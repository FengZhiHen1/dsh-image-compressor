/**
 * Host 侧压缩引擎（read_image 面）：sharp 重编码管线。
 *
 * 与客户端引擎（src/client/compressor.ts）同一策略哲学的 Node 实现：
 * 等比缩至像素/边长限制内（不放大）→ 格式选择（JPEG→JPEG，PNG/WebP→WebP
 * 保 alpha，sharp 自带 WebP 编码能力，无需浏览器式能力检测）→ 质量阶梯
 * 迭代 → 尺寸 ×0.75 降级，总轮次上限一致。
 *
 * 语义差异：客户端尽力而为后仍超限会带 overLimit 标记放行（官方 toast 兜底）；
 * Host 侧入库（saveImage）会再次强制限制，超限产物无法落库，因此迭代耗尽
 * 仍超限直接返回 null，由调用方回退官方报错路径。
 */
/** 引擎接受的格式（GIF 动画永不进入本引擎，与客户端 R-07 一致）。 */
export type CompressibleMediaType = 'image/png' | 'image/jpeg' | 'image/webp';
/** 压缩目标限制；maxImageBytes 为调用方算好的有效字节上限。 */
export interface HostImageLimits {
    readonly maxImageBytes: number;
    readonly maxImagePixels: number;
    readonly maxImageDimension: number;
}
/** 压缩产物及其溯源信息（用于通知文案）。 */
export interface CompressedImage {
    readonly data: Uint8Array;
    readonly mediaType: 'image/jpeg' | 'image/webp';
    readonly width: number;
    readonly height: number;
    readonly originalWidth: number;
    readonly originalHeight: number;
    readonly originalBytes: number;
    /** 输出格式与声明的原格式不同（PNG→WebP）。 */
    readonly formatChanged: boolean;
}
/**
 * 源图解码像素上限：超出即视为不可压缩（防内存炸弹），返回 null 由官方报错兜底。
 * 150MP RGBA 解码约 600MB 瞬时内存，是真实手机照片（≤108MP）与恶意巨图之间的取舍线。
 */
export declare const DECODE_PIXEL_CAP = 150000000;
/** 质量迭代步降序列（sharp 质量域 1-100，对应客户端 0.85→0.15）。 */
export declare const QUALITY_STEPS: readonly number[];
/** 总轮次上限（质量轮 + 尺寸轮合并计数），与客户端一致。 */
export declare const MAX_ROUNDS = 6;
/** 质量耗尽后的尺寸缩小因子，与客户端一致。 */
export declare const DOWNSIZE_FACTOR = 0.75;
/**
 * 等比缩放目标：同时满足像素总量与单边边长限制（宽高比不变、不放大）。
 * floor 保证 `width * height <= maxImagePixels` 且两边均 `<= maxImageDimension`。
 */
export declare function hostPixelTarget(width: number, height: number, maxPixels: number, maxDimension: number): {
    width: number;
    height: number;
};
/** 输出文件名 = 原名主干 + 新扩展名（镜像客户端 outputNameOf）。 */
export declare function hostOutputName(name: string, mediaType: 'image/jpeg' | 'image/webp'): string;
/**
 * 单图压缩管线。返回 null 表示解码失败 / 源图超过解码像素上限 /
 * 迭代耗尽仍超字节限制 —— 调用方回退官方报错路径，图片不因本插件消失。
 */
export declare function compressHostImage(data: Uint8Array, mediaType: CompressibleMediaType, limits: HostImageLimits): Promise<CompressedImage | null>;
