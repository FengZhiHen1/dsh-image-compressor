/**
 * 压缩引擎（compression-engine.md，追溯 R-04/R-05/R-06/R-07/R-09）。
 *
 * 纯逻辑面与浏览器 DOM/事件层零耦合：`shouldProcess` 同步字节预筛；
 * `compressImage` 为异步压缩管线（解码 → 像素判定 → 格式选择 → 质量迭代）。
 * 浏览器原生能力（createImageBitmap / canvas / toBlob）全部隔离在
 * `CompressHost` seam 之后，Node 单测注入 fake host 即可覆盖全管线。
 */

/** 运行时可读的 `imageLimits` 投影中本引擎需要的字段（允许更多字段）。 */
export interface ImageLimits {
  readonly maxImageBytes: number
  readonly maxImagePixels: number
}

/** 白名单能力宿主（浏览器实现见 {@link createBrowserCompressHost}）。 */
export interface Bitmap {
  readonly width: number
  readonly height: number
  close(): void
}

export interface CanvasHandle {
  readonly width: number
  readonly height: number
  /** 宿主私有底层画布对象（浏览器为 HTMLCanvasElement），仅供同一宿主 encode 使用。 */
  readonly backing: unknown
  /** 以目标尺寸绘制位图（等比缩放由调用方计算，本方法不放大）。 */
  draw(bitmap: Bitmap, width: number, height: number): void
  /** JPEG 兜底：透明区合成白底（调用顺序：先 fillWhite 再 draw）。 */
  fillWhite(): void
}

export interface CompressHost {
  decode(file: File): Promise<Bitmap>
  canvas(width: number, height: number): CanvasHandle
  /** 返回 null 表示该 mime 无法编码（toBlob null）。 */
  encode(canvas: CanvasHandle, mime: string, quality: number): Promise<Blob | null>
  /** WebP 编码能力检测（`toBlob('image/webp')` 回调 type 判定）。 */
  supportsWebp(): Promise<boolean>
}

export type CompressStatus = 'compressed' | 'unchanged' | 'failed'

/** 单图压缩结果；`file` 在 unchanged/failed 时为原文件对象（字节不变）。 */
export interface CompressResult {
  file: File
  /** 输入文件原名（压缩路径内不变；通知层据此显示原文件名）。 */
  originalName: string
  changed: boolean
  originalBytes: number
  status: CompressStatus
  /** 仅 status==='compressed' 时有效：尽力而为后仍超出字节限制。 */
  overLimit: boolean
  /** 仅 status==='compressed' 时有效：输出格式与原格式不同（如 PNG→WebP）。 */
  formatChanged: boolean
}

/** 引擎可压缩的白名单格式（GIF 由拦截层跳过，引擎不接收，见 R-07）。 */
const COMPRESSIBLE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp'])

export const EXT_BY_MIME: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

/** 质量迭代步降序列（compression-engine.md 第 5 步）。 */
export const QUALITY_STEPS: readonly number[] = [0.85, 0.7, 0.5, 0.3, 0.15]
/** 总轮次上限（质量轮 + 尺寸轮合并计数）。 */
export const MAX_ROUNDS = 6
/** 尺寸耗尽后缩小因子。 */
export const DOWNSIZE_FACTOR = 0.75

/** 判断某文件类型是否为引擎可压缩格式。 */
export function isCompressibleType(type: string): boolean {
  return COMPRESSIBLE_TYPES.has(type)
}

/** 字节预筛（byte-prescreen-pixel-2026-08）：仅比较 size > maxImageBytes，零成本。 */
export function shouldProcess(file: { readonly size: number }, limits: { readonly maxImageBytes: number }): boolean {
  return file.size > limits.maxImageBytes
}

/**
 * 像素等比缩放目标：超过 maxImagePixels 时等比缩至限制内（宽高比不变、不放大）。
 * 使用 floor 保证 `width * height <= maxImagePixels`。
 */
export function pixelTarget(
  width: number,
  height: number,
  maxPixels: number,
): { width: number; height: number } {
  const pixels = width * height
  if (pixels <= maxPixels) return { width, height }
  const ratio = Math.sqrt(maxPixels / pixels)
  return {
    width: Math.max(1, Math.floor(width * ratio)),
    height: Math.max(1, Math.floor(height * ratio)),
  }
}

/**
 * 格式选择（R-05/R-06）：JPEG → JPEG 重编码；PNG/WebP → WebP 优先（保 alpha），
 * 不支持时 JPEG 白底兜底。GIF 不在此路径。
 */
export function formatPlan(sourceType: string, webpSupported: boolean): { mime: string } {
  if (sourceType === 'image/jpeg' || sourceType === 'image/jpg') return { mime: 'image/jpeg' }
  return webpSupported ? { mime: 'image/webp' } : { mime: 'image/jpeg' }
}

/** 输出文件名 = 原名主干 + 新扩展名；原名无扩展名时直接追加。 */
export function outputNameOf(name: string, mime: string): string {
  const ext = EXT_BY_MIME[mime] ?? 'img'
  const dot = name.lastIndexOf('.')
  const stem = dot <= 0 ? name : name.slice(0, dot)
  return `${stem}.${ext}`
}

/** 浏览器默认宿主：createImageBitmap（EXIF from-image 自动纠正）+ canvas + toBlob。 */
export function createBrowserCompressHost(): CompressHost {
  let webpSupport: boolean | undefined
  return {
    decode(file: File): Promise<Bitmap> {
      return window.createImageBitmap(file, { imageOrientation: 'from-image' }) as Promise<Bitmap>
    },
    canvas(width: number, height: number): CanvasHandle {
      const element = document.createElement('canvas')
      element.width = width
      element.height = height
      const ctx = element.getContext('2d')
      if (ctx === null) throw new Error('canvas 2d context unavailable')
      return {
        width,
        height,
        backing: element,
        draw(bitmap: Bitmap, drawWidth: number, drawHeight: number): void {
          ctx.drawImage(bitmap as unknown as CanvasImageSource, 0, 0, drawWidth, drawHeight)
        },
        fillWhite(): void {
          ctx.fillStyle = '#ffffff'
          ctx.fillRect(0, 0, width, height)
        },
      }
    },
    encode(canvas: CanvasHandle, mime: string, quality: number): Promise<Blob | null> {
      const element = canvas.backing as HTMLCanvasElement
      return new Promise((resolve) => {
        element.toBlob((blob) => resolve(blob), mime, quality)
      })
    },
    async supportsWebp(): Promise<boolean> {
      if (webpSupport !== undefined) return webpSupport
      const canvas = document.createElement('canvas')
      canvas.width = 1
      canvas.height = 1
      webpSupport = await new Promise<boolean>((resolve) => {
        canvas.toBlob((blob) => resolve((blob?.type ?? '') === 'image/webp'), 'image/webp')
      })
      return webpSupport
    },
  }
}

function keepBest(best: { blob: Blob; bytes: number } | null, blob: Blob): { blob: Blob; bytes: number } | null {
  if (best === null || blob.size < best.bytes) return { blob, bytes: blob.size }
  return best
}

/**
 * 压缩管线（单图）。任一阶段异常/解码失败按 `failed` 原样返回（失败兜底，R-09）；
 * 迭代耗尽仍超限返回最小历史结果并标 `overLimit`（尽力而为）。
 */
export async function compressImage(
  file: File,
  limits: ImageLimits,
  host: CompressHost = createBrowserCompressHost(),
): Promise<CompressResult> {
  const originalBytes = file.size
  const passthrough = (): CompressResult => ({
    file, originalName: file.name, changed: false, originalBytes, status: 'unchanged', overLimit: false, formatChanged: false,
  })
  const failedOriginal = (): CompressResult => ({
    file, originalName: file.name, changed: false, originalBytes, status: 'failed', overLimit: false, formatChanged: false,
  })

  if (!isCompressibleType(file.type) || !shouldProcess(file, limits)) return passthrough()

  let bitmap: Bitmap
  try {
    bitmap = await host.decode(file)
  } catch {
    // 解码失败（损坏/伪装/超大源图像例）：原文件入列，绝不丢图。
    return failedOriginal()
  }

  try {
    const webpSupported = await host.supportsWebp()
    const { mime } = formatPlan(file.type, webpSupported)
    const needWhiteForJpeg = mime === 'image/jpeg'

    const pixels = bitmap.width * bitmap.height
    const target = pixels > limits.maxImagePixels
      ? pixelTarget(bitmap.width, bitmap.height, limits.maxImagePixels)
      : { width: bitmap.width, height: bitmap.height }

    let best: { blob: Blob; bytes: number } | null = null
    let rounds = 0
    let width = target.width
    let height = target.height
    let success: { blob: Blob; overLimit: boolean } | null = null

    while (rounds < MAX_ROUNDS && success === null) {
      const canvas = host.canvas(width, height)
      if (needWhiteForJpeg) canvas.fillWhite()
      canvas.draw(bitmap, width, height)

      for (const quality of QUALITY_STEPS) {
        if (rounds >= MAX_ROUNDS) break
        rounds += 1
        let blob: Blob | null = null
        try {
          blob = await host.encode(canvas, mime, quality)
        } catch {
          blob = null // 单轮编码异常视为该轮失败，继续尝试
        }
        if (blob === null) continue
        best = keepBest(best, blob)
        if (blob.size <= limits.maxImageBytes) {
          success = { blob, overLimit: false }
          break
        }
      }

      if (success === null) {
        const nextWidth = Math.max(1, Math.round(width * DOWNSIZE_FACTOR))
        const nextHeight = Math.max(1, Math.round(height * DOWNSIZE_FACTOR))
        if (nextWidth >= width && nextHeight >= height) break // 无法再缩小
        width = nextWidth
        height = nextHeight
      }
    }

    if (success !== null) {
      return {
        file: new File([success.blob], outputNameOf(file.name, mime), { type: mime }),
        originalName: file.name,
        changed: true,
        originalBytes,
        status: 'compressed',
        overLimit: false,
        formatChanged: mime !== file.type,
      }
    }
    if (best !== null) {
      return {
        file: new File([best.blob], outputNameOf(file.name, mime), { type: mime }),
        originalName: file.name,
        changed: true,
        originalBytes,
        status: 'compressed',
        overLimit: true,
        formatChanged: mime !== file.type,
      }
    }
    // 所有轮次都无法产出 blob：视为压缩失败，原文件入列。
    return failedOriginal()
  } finally {
    try { bitmap.close() } catch { /* 位图可能已释放 */ }
  }
}
