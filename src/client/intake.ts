/**
 * 摄入拦截与注入（intake-interception.md，追溯 R-02/R-03/R-09/R-10/R-11）。
 *
 * - `shouldTakeOver`：事件回调内全同步判定（防重入 / 无会话 / 忙 / 无投影 /
 *   非可压缩图 / 字节未超限 → 放行）。
 * - `processBatch`：接管后串行逐张处理，GIF 与失败张原文件入列，顺序与
 *   不变量（任何图片不因本插件消失）由本函数保证。
 * - `attachIntakeListeners`：document 捕获阶段 drop/paste 监听；dispose 移除。
 * - `injectDrop`：构造 DataTransfer + DragEvent 重新喂入官方 document 监听。
 */

import { isCompressibleType, type CompressResult, type ImageLimits } from './compressor.js'

/** 防重入标记：注入事件对象上挂本插件私有符号。 */
export const INJECTION_MARK = Symbol.for('dsh-image-compressor.injection')

/** 结构化判定事实（监听器在浏览器侧收集后交给纯函数判定）。 */
export interface TakeOverFacts {
  injected: boolean
  hasSession: boolean
  running: boolean
  limits: ImageLimits | undefined
  files: readonly { readonly type: string; readonly size: number }[]
}

/**
 * 同步判定（R-03 字节预筛 + R-10 状态感知）。任一条件不满足即放行。
 * 仅当存在任一张可压缩图片且其字节 > maxImageBytes 时接管。
 */
export function shouldTakeOver(facts: TakeOverFacts): boolean {
  if (facts.injected) return false
  if (!facts.hasSession) return false
  if (facts.running) return false
  if (facts.limits === undefined) return false
  const maxImageBytes = facts.limits.maxImageBytes
  const compressible = facts.files.filter((file) => isCompressibleType(file.type))
  if (compressible.length === 0) return false
  return compressible.some((file) => file.size > maxImageBytes)
}

/** 运行时投影防御：非负数值检查失败即视为无投影（AC-11 放行）。 */
export function asImageLimits(value: unknown): ImageLimits | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.maxImageBytes !== 'number' || typeof record.maxImagePixels !== 'number') return undefined
  if (!(record.maxImageBytes > 0) || !(record.maxImagePixels > 0)) return undefined
  return { maxImageBytes: record.maxImageBytes, maxImagePixels: record.maxImagePixels }
}

/** 一批次单张结果：携带原始顺序下标。 */
export interface BatchItemResult extends CompressResult {
  originalIndex: number
}

/** 批次聚合：通知层消费的全部统计字段（R-08/R-09）。 */
export interface ProcessedBatch {
  /** 按原始顺序的全部结果（压缩/原样/失败混合）。 */
  items: readonly BatchItemResult[]
  /** 可压缩图片张数（不含 GIF/非图片）。 */
  images: number
  /** 成功压缩张数（含 overLimit 尽力而为）。 */
  compressed: number
  /** 压缩失败（解码/编码不可用）按原文件入列的张数。 */
  failed: number
  /** 尽力而为仍超字节限制的张数。 */
  overLimit: number
  /** 批次总字节（原始）。 */
  totalBefore: number
  /** 批次总字节（处理后）。 */
  totalAfter: number
  /** 格式变化的唯一目标格式集合（'webp' | 'jpeg'），空 = 无变化。 */
  changedTo: readonly ('webp' | 'jpeg')[]
}

/**
 * 串行处理整批次（不并行，见内存边界）：GIF/非图片以原文件入列；可压缩图
 * 单张调用 `compress`；引擎异常由本函数兜底为失败原样。返回按原始顺序排列。
 */
export async function processBatch(
  files: readonly File[],
  limits: ImageLimits,
  compress: (file: File, limits: ImageLimits) => Promise<CompressResult>,
): Promise<ProcessedBatch> {
  const items: BatchItemResult[] = []
  let images = 0
  let compressed = 0
  let failed = 0
  let overLimit = 0
  let totalBefore = 0
  let totalAfter = 0
  const changedToSet = new Set<'webp' | 'jpeg'>()
  for (const file of files) {
    totalBefore += file.size
    const originalIndex = items.length
    if (!isCompressibleType(file.type)) {
      totalAfter += file.size
      items.push({
        file, originalName: file.name, changed: false, originalBytes: file.size,
        status: 'unchanged', overLimit: false, formatChanged: false, originalIndex,
      })
      continue
    }
    images += 1
    let result: CompressResult
    try {
      result = await compress(file, limits)
    } catch {
      result = {
        file, originalName: file.name, changed: false, originalBytes: file.size,
        status: 'failed', overLimit: false, formatChanged: false,
      }
    }
    if (result.status === 'compressed') {
      compressed += 1
      if (result.overLimit) overLimit += 1
      if (result.formatChanged) {
        if (result.file.type === 'image/webp') changedToSet.add('webp')
        else if (result.file.type === 'image/jpeg') changedToSet.add('jpeg')
      }
    } else if (result.status === 'failed') {
      failed += 1
    }
    totalAfter += result.file.size
    items.push({ ...result, originalIndex })
  }
  return {
    items, images, compressed, failed, overLimit, totalBefore, totalAfter,
    changedTo: [...changedToSet],
  }
}

/** 事件对象上防重入标记读取。 */
export function isMarked(event: Event, mark: symbol = INJECTION_MARK): boolean {
  return (event as unknown as Record<symbol, unknown>)[mark] === true
}

/** 读取 drop 事件的拖放文件（非图片拖放同样读取，判定决定是否接管）。 */
export function filesOfDrop(event: Event): File[] {
  const drop = event as DragEvent
  return [...(drop.dataTransfer?.files ?? [])]
}

/** 读取 paste 事件的剪贴板文件（React 合成事件由捕获阻断，这里读原生 ClipboardEvent）。 */
export function filesOfPaste(event: Event): File[] {
  const paste = event as ClipboardEvent
  const items = paste.clipboardData?.items
  if (items === undefined) return []
  const files: File[] = []
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file !== null) files.push(file)
  }
  return files
}

/**
 * 注入：按原始顺序构造 DataTransfer 逐项 add，派发 document 冒泡 drop 事件，
 * 事件对象挂防重入标记。返回是否成功派发。
 */
export function injectDrop(files: readonly File[], mark: symbol = INJECTION_MARK): boolean {
  if (files.length === 0) return true
  const dataTransfer = new DataTransfer()
  for (const file of files) dataTransfer.items.add(file)
  const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer })
  ;(event as unknown as Record<symbol, unknown>)[mark] = true
  return document.dispatchEvent(event)
}

/** 监听器所需的最小会话读面（浏览器侧由 ctx.sessions 提供）。 */
export interface IntakeSessionsFace {
  list: { getSnapshot(): { readonly current?: string | undefined } }
  binding(id: string): {
    session: {
      getSnapshot(): { readonly running: boolean }
      projections: { faceOf(key: string): { getSnapshot(): unknown } }
    }
  } | undefined
}

export interface IntakeDeps {
  sessions: IntakeSessionsFace
  /** 压缩单图（默认 engine；测试可注入）。 */
  compress: (file: File, limits: ImageLimits) => Promise<CompressResult>
  /** 批次完成后通知（通知层 publish），由入口层注入。 */
  onDone: (batch: ProcessedBatch, fromPaste: boolean) => void
}

/**
 * 收集一次事件的判定事实（纯读，零副作用）。limits 缺失 → 放行。
 */
function collectFacts(deps: IntakeDeps, event: Event, files: File[]): TakeOverFacts {
  const current = deps.sessions.list.getSnapshot().current
  const binding = current === undefined ? undefined : deps.sessions.binding(current)
  let limits: ImageLimits | undefined
  const projection = binding?.session.projections.faceOf('imageLimits').getSnapshot()
  limits = asImageLimits(projection)
  return {
    injected: isMarked(event),
    hasSession: current !== undefined,
    running: binding?.session.getSnapshot().running ?? false,
    limits,
    files,
  }
}

/**
 * 注册 document 捕获阶段 drop/paste 监听。判定放行时不干预；
 * 接管时 preventDefault + stopPropagation 并异步处理批次后注入。
 * 拦截器自身异常 → 返回（原事件未被 preventDefault，官方流程原样）。返回 disposer。
 */
export function attachIntakeListeners(
  deps: IntakeDeps,
  mark: symbol = INJECTION_MARK,
): () => void {
  const readFiles = (event: Event): File[] | undefined => {
    try {
      if (event.type === 'drop') return filesOfDrop(event)
      return filesOfPaste(event)
    } catch {
      return undefined // 无法读取文件 → 放行
    }
  }

  const onCapture = (event: Event): void => {
    const files = readFiles(event)
    if (files === undefined || files.length === 0) return
    let facts: TakeOverFacts
    try {
      facts = collectFacts(deps, event, files)
    } catch {
      return // 判定异常 → 放行
    }
    if (!shouldTakeOver(facts)) return
    const limits = facts.limits
    if (limits === undefined) return // 判定已要求 limits，防御性早退
    // 接管：吞掉原事件，进入异步处理。
    event.preventDefault()
    event.stopPropagation()
    const fromPaste = event.type === 'paste'
    void (async () => {
      try {
        const batch = await processBatch(files, limits, deps.compress)
        try {
          deps.onDone(batch, fromPaste)
        } catch { /* 通知失败不影响注入主流程 */ }
        injectDrop(batch.items.map((item) => item.file), mark)
      } catch {
        // 拦截器自身异常：不丢失批次——以原文件尽力注入（官方 intake 会再兜底）。
        try {
          injectDrop(files, mark)
        } catch { /* 静默 */ }
      }
    })()
  }

  document.addEventListener('drop', onCapture, true)
  document.addEventListener('paste', onCapture, true)
  return () => {
    document.removeEventListener('drop', onCapture, true)
    document.removeEventListener('paste', onCapture, true)
  }
}
