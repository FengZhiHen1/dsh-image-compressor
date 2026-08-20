/**
 * 文案表与通知文案聚合（notification.md，追溯 R-08/R-09）。
 *
 * zh/en 词典在 `IMAGE_COMPRESSOR_NS` 命名空间；`buildNotification` 为纯函数，
 * 输入批次摘要 + 当前语言的 translate，输出一条聚合结果的 Toast 文案与图标语义。
 */

/** 本插件专属 locale 命名空间（注册进 DSH LocaleNamespaceMap）。 */
export const IMAGE_COMPRESSOR_NS = 'image-compressor'

export const en = {
  'compressed.single': 'Auto-compressed: {name} {before} → {after}{formatNote}',
  'compressed.multi': 'Auto-compressed {count} images ({before} → {after} total){formatNote}',
  'compressed.partial': 'Compressed {ok} image(s); {failed} failed and were added as-is',
  'compressed.allFailed': '{failed} image(s) failed to compress and were added as-is',
  'compressed.overLimit': 'Compressed: {name} {before} → {after} (still over the limit; try another image)',
  'compressed.overLimitWithin': '; {count} still over the limit',
  'common.formatChanged': ' (converted to {format})',
  'paste.textDropped': '; clipboard text was not pasted with the images',
} as const

export type CompressNotifyKey = keyof typeof en

export const zh: Record<CompressNotifyKey, string> = {
  'compressed.single': '已自动压缩：{name} {before} → {after}{formatNote}',
  'compressed.multi': '已自动压缩 {count} 张图片（共 {before} → {after}）{formatNote}',
  'compressed.partial': '已压缩 {ok} 张图片；{failed} 张压缩失败，已按原图添加',
  'compressed.allFailed': '{failed} 张图片压缩失败，已按原图添加',
  'compressed.overLimit': '已压缩：{name} {before} → {after}（仍超出限制，建议更换图片）',
  'compressed.overLimitWithin': '；{count} 张仍超出限制',
  'common.formatChanged': '（已转为 {format}）',
  'paste.textDropped': '；剪贴板文本未随图片粘贴',
}

/** 向 DSH 槽表声明本命名空间的词典键（声明合并；词典所有权唯一）。 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'image-compressor': CompressNotifyKey
  }
}

/** translate 最小签名（运行时传 `ctx.locale.bind(NS)`，测试传本地插值实现）。 */
export type TranslateFn = (key: CompressNotifyKey, params?: Record<string, string>) => string

/** 批次摘要（由 processBatch 结果派生，见 notify-store.summaryOf）。 */
export interface NotificationSummary {
  images: number
  compressed: number
  failed: number
  overLimit: number
  /** 压缩后格式变化的唯一集合（'webp' | 'jpeg'），空 = 无变化（仅 JPEG 重编码不提示）。 */
  changedTo: readonly ('webp' | 'jpeg')[]
  fromPaste: boolean
  totalBefore: number
  totalAfter: number
  /** 单张成功时文件名（否则 null）。 */
  fileName: string | null
  firstBefore: number
  firstAfter: number
}

export type NotificationKind = 'info' | 'warning'

export interface NotificationMessage {
  text: string
  kind: NotificationKind
}

/** 字节朗读：≥1MB 显示 MB（1 位小数），≥1KB 显示 KB，否则 B。 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${bytes}B`
}

function formatNoteOf(summary: NotificationSummary, t: TranslateFn): string {
  if (summary.changedTo.length === 0 || summary.compressed === 0) return ''
  const [first, second] = summary.changedTo
  const label = second === undefined
    ? (first === 'webp' ? 'WebP' : first === 'jpeg' ? 'JPEG' : '')
    : 'WebP/JPEG'
  if (label === '') return ''
  return t('common.formatChanged', { format: label })
}

/**
 * 聚合批次摘要为一条通知（R-08 单条聚合、R-09 失败/尽力而为如实报告）。
 * 未接管到任何可报告工作（压缩/失败都为零）→ 返回 null（不通知，AC-03）。
 */
export function buildNotification(
  summary: NotificationSummary,
  t: TranslateFn,
): NotificationMessage | null {
  const hasWork = summary.compressed > 0 || summary.failed > 0
  if (!hasWork) return null

  const single = summary.images === 1
    && summary.compressed === 1
    && summary.failed === 0
    && summary.fileName !== null
  const formatNote = formatNoteOf(summary, t)
  const overLimitWithin = summary.overLimit > 0 && !single
    ? t('compressed.overLimitWithin', { count: String(summary.overLimit) })
    : ''

  let text: string
  if (single && summary.overLimit > 0) {
    text = t('compressed.overLimit', {
      name: summary.fileName ?? '',
      before: formatBytes(summary.firstBefore),
      after: formatBytes(summary.firstAfter),
    })
  } else if (single) {
    text = t('compressed.single', {
      name: summary.fileName ?? '',
      before: formatBytes(summary.firstBefore),
      after: formatBytes(summary.firstAfter),
      formatNote,
    })
  } else if (summary.compressed > 0 && summary.failed === 0) {
    text = t('compressed.multi', {
      count: String(summary.compressed),
      before: formatBytes(summary.totalBefore),
      after: formatBytes(summary.totalAfter),
      formatNote,
    }) + overLimitWithin
  } else if (summary.compressed > 0 && summary.failed > 0) {
    text = t('compressed.partial', {
      ok: String(summary.compressed),
      failed: String(summary.failed),
    }) + overLimitWithin
  } else {
    text = t('compressed.allFailed', { failed: String(summary.failed) })
  }

  if (summary.fromPaste) text += t('paste.textDropped')
  const kind: NotificationKind = summary.failed > 0 || summary.overLimit > 0 ? 'warning' : 'info'
  return { text, kind }
}
