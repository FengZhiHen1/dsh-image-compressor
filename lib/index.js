/**
 * dsh-image-compressor — node half.
 *
 * 双层插件：浏览器半区（exports["./client"]，拖放/粘贴捕获压缩）不变；
 * Host 半区注册 `tools/execute` around-dispatch 包装器，把 read_image 工具
 * 对超限图片的拒绝（字节 / 像素 / 边长）转为自动压缩入库（sharp 引擎，
 * 与客户端同一策略哲学），未超限调用零介入直接放行。
 */
import { createReadImageCompressor } from './host/read-image-wrapper.js';
/** Host plugin body — 注册 read_image 压缩包装器；卸载时 cordis 自动移除监听。 */
export function apply(ctx) {
    ctx.on('tools/execute', createReadImageCompressor(ctx));
}
