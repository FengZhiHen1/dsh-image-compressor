/**
 * 通知队列 store（notification.md，追溯 R-08/R-09）。
 *
 * 模块级订阅 store（参照 dsh-openpencil-lite preview-store 模式）：拦截层在
 * 批次完成时 `publish`（聚合一条，R-08 避免逐张刷屏），通知层组件
 * `useSyncExternalStore` 订阅；Toast `onDone` 出队。apply 生命周期内初始化
 * （reset），dispose 清空（R-11 零残留）；已清空时 publish 为空操作。
 */

import { buildNotification, type NotificationSummary, type TranslateFn } from './locales.js'
import type { ProcessedBatch } from './intake.js'

export type { NotificationKind, NotificationMessage, NotificationSummary } from './locales.js'

export interface NotificationItem {
  seq: number
  text: string
  kind: 'info' | 'warning'
}

/** ProcessedBatch → NotificationSummary 的纯桥梁（批量单/多、失败、尽力而为派生）。 */
export function summaryOf(batch: ProcessedBatch, fromPaste: boolean): NotificationSummary {
  const compressedItems = batch.items.filter((item) => item.status === 'compressed')
  const single = batch.images === 1 && batch.failed === 0 && compressedItems.length === 1
    ? compressedItems[0]
    : undefined
  return {
    images: batch.images,
    compressed: batch.compressed,
    failed: batch.failed,
    overLimit: batch.overLimit,
    changedTo: batch.changedTo,
    fromPaste,
    totalBefore: batch.totalBefore,
    totalAfter: batch.totalAfter,
    fileName: single?.originalName ?? null,
    firstBefore: single?.originalBytes ?? 0,
    firstAfter: single?.file.size ?? 0,
  }
}

/** 聚合批次为一条通知文案与语义；无工作报告（未接管）返回 null（不通知）。 */
export function messageOf(batch: ProcessedBatch, fromPaste: boolean, translate: TranslateFn) {
  return buildNotification(summaryOf(batch, fromPaste), translate)
}

// ---- 模块级 store ----

let items: NotificationItem[] = []
let seq = 0
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) {
    try { listener() } catch { /* 订阅者异常不影响其余 */ }
  }
}

/** apply 初始化或测试隔离：清空队列与序号并通知。 */
export function resetNotifyStore(): void {
  items = []
  seq = 0
  notify()
}

/** dispose 清空（R-11）。已清空时重复清空为空操作。 */
export function clearNotifyStore(): void {
  items = []
  notify()
}

/** 队列快照（uSES getSnapshot；引用在每次变更后替换，稳定协议）。 */
export function getNotifySnapshot(): readonly NotificationItem[] {
  return items
}

/** 订阅队列变更；返回取消订阅函数。 */
export function subscribeNotify(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 入队一条通知（聚合好的单条）。 */
export function publish(message: { text: string; kind: 'info' | 'warning' }): boolean {
  seq += 1
  items = [...items, { seq, text: message.text, kind: message.kind }]
  notify()
  return true
}

/** 按序号出队（Toast onDone）；不存在的序号为空操作。 */
export function dismiss(sequence: number): void {
  if (!items.some((item) => item.seq === sequence)) return
  items = items.filter((item) => item.seq !== sequence)
  notify()
}
