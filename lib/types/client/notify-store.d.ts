/**
 * 通知队列 store（notification.md，追溯 R-08/R-09）。
 *
 * 模块级订阅 store（参照 dsh-openpencil-lite preview-store 模式）：拦截层在
 * 批次完成时 `publish`（聚合一条，R-08 避免逐张刷屏），通知层组件
 * `useSyncExternalStore` 订阅；Toast `onDone` 出队。apply 生命周期内初始化
 * （reset），dispose 清空（R-11 零残留）；已清空时 publish 为空操作。
 */
import { type NotificationSummary, type TranslateFn } from './locales.js';
import type { ProcessedBatch } from './intake.js';
export type { NotificationKind, NotificationMessage, NotificationSummary } from './locales.js';
export interface NotificationItem {
    seq: number;
    text: string;
    kind: 'info' | 'warning';
}
/** ProcessedBatch → NotificationSummary 的纯桥梁（批量单/多、失败、尽力而为派生）。 */
export declare function summaryOf(batch: ProcessedBatch, fromPaste: boolean): NotificationSummary;
/** 聚合批次为一条通知文案与语义；无工作报告（未接管）返回 null（不通知）。 */
export declare function messageOf(batch: ProcessedBatch, fromPaste: boolean, translate: TranslateFn): import("./locales.js").NotificationMessage | null;
/** apply 初始化或测试隔离：清空队列与序号并通知。 */
export declare function resetNotifyStore(): void;
/** dispose 清空（R-11）。已清空时重复清空为空操作。 */
export declare function clearNotifyStore(): void;
/** 队列快照（uSES getSnapshot；引用在每次变更后替换，稳定协议）。 */
export declare function getNotifySnapshot(): readonly NotificationItem[];
/** 订阅队列变更；返回取消订阅函数。 */
export declare function subscribeNotify(listener: () => void): () => void;
/** 入队一条通知（聚合好的单条）。 */
export declare function publish(message: {
    text: string;
    kind: 'info' | 'warning';
}): boolean;
/** 按序号出队（Toast onDone）；不存在的序号为空操作。 */
export declare function dismiss(sequence: number): void;
