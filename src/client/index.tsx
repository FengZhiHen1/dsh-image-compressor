/**
 * dsh-image-compressor — pure Client entry.
 *
 * apply 生命周期：注册词典 → 初始化通知队列 → 挂 document 捕获监听（drop/paste）
 * + 完成后 publish → 注册通知层座位。全部副作用随当前 Fiber 回收，dispose 移除
 * 监听、卸载座位、清空通知队列（R-11 零残留）。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import {
  compressImage,
  createBrowserCompressHost,
  formatPlan,
  isCompressibleType,
  outputNameOf,
  pixelTarget,
  shouldProcess,
  DOWNSIZE_FACTOR,
  EXT_BY_MIME,
  MAX_ROUNDS,
  QUALITY_STEPS,
  type Bitmap,
  type CanvasHandle,
  type CompressHost,
  type CompressResult,
  type CompressStatus,
  type ImageLimits,
} from './compressor.js'
import {
  asImageLimits,
  attachIntakeListeners,
  filesOfDrop,
  filesOfPaste,
  injectDrop,
  INJECTION_MARK,
  isMarked,
  processBatch,
  shouldTakeOver,
  type BatchItemResult,
  type IntakeDeps,
  type ProcessedBatch,
  type TakeOverFacts,
} from './intake.js'
import {
  buildNotification,
  en,
  formatBytes,
  IMAGE_COMPRESSOR_NS,
  zh,
  type CompressNotifyKey,
  type NotificationKind,
  type NotificationMessage,
  type NotificationSummary,
  type TranslateFn,
} from './locales.js'
import {
  clearNotifyStore,
  dismiss,
  getNotifySnapshot,
  messageOf,
  publish,
  resetNotifyStore,
  subscribeNotify,
  summaryOf,
  type NotificationItem,
} from './notify-store.js'
import { NotificationDock } from './Notifications.js'

// Engine surface re-exported so Node tests (loaded via the module loader
// harness) reach the pure logic without a separate compile step.
export {
  compressImage,
  createBrowserCompressHost,
  formatPlan,
  isCompressibleType,
  outputNameOf,
  pixelTarget,
  shouldProcess,
  DOWNSIZE_FACTOR,
  EXT_BY_MIME,
  MAX_ROUNDS,
  QUALITY_STEPS,
  type Bitmap,
  type CanvasHandle,
  type CompressHost,
  type CompressResult,
  type CompressStatus,
  type ImageLimits,
}
export {
  asImageLimits,
  attachIntakeListeners,
  filesOfDrop,
  filesOfPaste,
  injectDrop,
  INJECTION_MARK,
  isMarked,
  processBatch,
  shouldTakeOver,
  type BatchItemResult,
  type IntakeDeps,
  type ProcessedBatch,
  type TakeOverFacts,
}
export {
  buildNotification,
  en,
  formatBytes,
  IMAGE_COMPRESSOR_NS,
  zh,
  type CompressNotifyKey,
  type NotificationKind,
  type NotificationMessage,
  type NotificationSummary,
  type TranslateFn,
}
export {
  clearNotifyStore,
  dismiss,
  getNotifySnapshot,
  messageOf,
  publish,
  resetNotifyStore,
  subscribeNotify,
  summaryOf,
  type NotificationItem,
}
export { NotificationDock }

/** Required services (service-oriented reads, hard deps of the web shell). */
export const inject = ['sessions', 'slots', 'locale']

/**
 * Client plugin body（阶段5 完整集成）：
 * 1. 注册 zh/en 词典（ctx.effect 随 Fiber 卸载反注册）。
 * 2. 初始化通知队列。
 * 3. document 捕获阶段 drop/paste 监听 + 完成后 publish 聚合通知；dispose 移除并清空队列。
 * 4. 通知层挂到 `conversation.input.dock` 会话级座位。
 */
export function apply(ctx: ClientContext): void {
  // 词典注册（disposer 随 Fiber 释放）。
  ctx.effect(() => ctx.locale.register(IMAGE_COMPRESSOR_NS, { zh, en }), 'dsh-image-compressor: dictionaries')

  // 通知队列初始化（dispose 时由下面的 effect 清空）。
  resetNotifyStore()

  // 摄入拦截 + 通知发布：全部副作用挂当前 Fiber。
  ctx.effect(() => {
    const translate = ctx.locale.bind(IMAGE_COMPRESSOR_NS) as TranslateFn
    const detach = attachIntakeListeners({
      sessions: ctx.sessions,
      compress: compressImage,
      onDone: (batch, fromPaste) => {
        const message = messageOf(batch, fromPaste, translate)
        if (message !== null) publish(message)
      },
    })
    return () => {
      detach()
      clearNotifyStore()
    }
  }, 'dsh-image-compressor: intake + notification lifecycle')

  // 通知层座位：会话存在时挂载（压缩必然发生在会话中）。
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'dsh-image-compressor',
    order: 20,
    locale: IMAGE_COMPRESSOR_NS,
  }, NotificationDock))
}
