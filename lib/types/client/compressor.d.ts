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
    readonly maxImageBytes: number;
    readonly maxImagePixels: number;
}
/** 白名单能力宿主（浏览器实现见 {@link createBrowserCompressHost}）。 */
export interface Bitmap {
    readonly width: number;
    readonly height: number;
    close(): void;
}
export interface CanvasHandle {
    readonly width: number;
    readonly height: number;
    /** 宿主私有底层画布对象（浏览器为 HTMLCanvasElement），仅供同一宿主 encode 使用。 */
    readonly backing: unknown;
    /** 以目标尺寸绘制位图（等比缩放由调用方计算，本方法不放大）。 */
    draw(bitmap: Bitmap, width: number, height: number): void;
    /** JPEG 兜底：透明区合成白底（调用顺序：先 fillWhite 再 draw）。 */
    fillWhite(): void;
}
export interface CompressHost {
    decode(file: File): Promise<Bitmap>;
    canvas(width: number, height: number): CanvasHandle;
    /** 返回 null 表示该 mime 无法编码（toBlob null）。 */
    encode(canvas: CanvasHandle, mime: string, quality: number): Promise<Blob | null>;
    /** WebP 编码能力检测（`toBlob('image/webp')` 回调 type 判定）。 */
    supportsWebp(): Promise<boolean>;
}
export type CompressStatus = 'compressed' | 'unchanged' | 'failed';
/** 单图压缩结果；`file` 在 unchanged/failed 时为原文件对象（字节不变）。 */
export interface CompressResult {
    file: File;
    /** 输入文件原名（压缩路径内不变；通知层据此显示原文件名）。 */
    originalName: string;
    changed: boolean;
    originalBytes: number;
    status: CompressStatus;
    /** 仅 status==='compressed' 时有效：尽力而为后仍超出字节限制。 */
    overLimit: boolean;
    /** 仅 status==='compressed' 时有效：输出格式与原格式不同（如 PNG→WebP）。 */
    formatChanged: boolean;
}
export declare const EXT_BY_MIME: Readonly<Record<string, string>>;
/** 质量迭代步降序列（compression-engine.md 第 5 步）。 */
export declare const QUALITY_STEPS: readonly number[];
/** 总轮次上限（质量轮 + 尺寸轮合并计数）。 */
export declare const MAX_ROUNDS = 6;
/** 尺寸耗尽后缩小因子。 */
export declare const DOWNSIZE_FACTOR = 0.75;
/** 判断某文件类型是否为引擎可压缩格式。 */
export declare function isCompressibleType(type: string): boolean;
/** 字节预筛（byte-prescreen-pixel-2026-08）：仅比较 size > maxImageBytes，零成本。 */
export declare function shouldProcess(file: {
    readonly size: number;
}, limits: {
    readonly maxImageBytes: number;
}): boolean;
/**
 * 像素等比缩放目标：超过 maxImagePixels 时等比缩至限制内（宽高比不变、不放大）。
 * 使用 floor 保证 `width * height <= maxImagePixels`。
 */
export declare function pixelTarget(width: number, height: number, maxPixels: number): {
    width: number;
    height: number;
};
/**
 * 格式选择（R-05/R-06）：JPEG → JPEG 重编码；PNG/WebP → WebP 优先（保 alpha），
 * 不支持时 JPEG 白底兜底。GIF 不在此路径。
 */
export declare function formatPlan(sourceType: string, webpSupported: boolean): {
    mime: string;
};
/** 输出文件名 = 原名主干 + 新扩展名；原名无扩展名时直接追加。 */
export declare function outputNameOf(name: string, mime: string): string;
/** 浏览器默认宿主：createImageBitmap（EXIF from-image 自动纠正）+ canvas + toBlob。 */
export declare function createBrowserCompressHost(): CompressHost;
/**
 * 压缩管线（单图）。任一阶段异常/解码失败按 `failed` 原样返回（失败兜底，R-09）；
 * 迭代耗尽仍超限返回最小历史结果并标 `overLimit`（尽力而为）。
 */
export declare function compressImage(file: File, limits: ImageLimits, host?: CompressHost): Promise<CompressResult>;
