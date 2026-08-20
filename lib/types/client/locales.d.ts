/**
 * 文案表与通知文案聚合（notification.md，追溯 R-08/R-09）。
 *
 * zh/en 词典在 `IMAGE_COMPRESSOR_NS` 命名空间；`buildNotification` 为纯函数，
 * 输入批次摘要 + 当前语言的 translate，输出一条聚合结果的 Toast 文案与图标语义。
 */
/** 本插件专属 locale 命名空间（注册进 DSH LocaleNamespaceMap）。 */
export declare const IMAGE_COMPRESSOR_NS = "image-compressor";
export declare const en: {
    readonly 'compressed.single': "Auto-compressed: {name} {before} → {after}{formatNote}";
    readonly 'compressed.multi': "Auto-compressed {count} images ({before} → {after} total){formatNote}";
    readonly 'compressed.partial': "Compressed {ok} image(s); {failed} failed and were added as-is";
    readonly 'compressed.allFailed': "{failed} image(s) failed to compress and were added as-is";
    readonly 'compressed.overLimit': "Compressed: {name} {before} → {after} (still over the limit; try another image)";
    readonly 'compressed.overLimitWithin': "; {count} still over the limit";
    readonly 'common.formatChanged': " (converted to {format})";
    readonly 'paste.textDropped': "; clipboard text was not pasted with the images";
};
export type CompressNotifyKey = keyof typeof en;
export declare const zh: Record<CompressNotifyKey, string>;
/** 向 DSH 槽表声明本命名空间的词典键（声明合并；词典所有权唯一）。 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        'image-compressor': CompressNotifyKey;
    }
}
/** translate 最小签名（运行时传 `ctx.locale.bind(NS)`，测试传本地插值实现）。 */
export type TranslateFn = (key: CompressNotifyKey, params?: Record<string, string>) => string;
/** 批次摘要（由 processBatch 结果派生，见 notify-store.summaryOf）。 */
export interface NotificationSummary {
    images: number;
    compressed: number;
    failed: number;
    overLimit: number;
    /** 压缩后格式变化的唯一集合（'webp' | 'jpeg'），空 = 无变化（仅 JPEG 重编码不提示）。 */
    changedTo: readonly ('webp' | 'jpeg')[];
    fromPaste: boolean;
    totalBefore: number;
    totalAfter: number;
    /** 单张成功时文件名（否则 null）。 */
    fileName: string | null;
    firstBefore: number;
    firstAfter: number;
}
export type NotificationKind = 'info' | 'warning';
export interface NotificationMessage {
    text: string;
    kind: NotificationKind;
}
/** 字节朗读：≥1MB 显示 MB（1 位小数），≥1KB 显示 KB，否则 B。 */
export declare function formatBytes(bytes: number): string;
/**
 * 聚合批次摘要为一条通知（R-08 单条聚合、R-09 失败/尽力而为如实报告）。
 * 未接管到任何可报告工作（压缩/失败都为零）→ 返回 null（不通知，AC-03）。
 */
export declare function buildNotification(summary: NotificationSummary, t: TranslateFn): NotificationMessage | null;
