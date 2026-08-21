/**
 * `read_image` 工具的 around-dispatch 包装器（Host 面）。
 *
 * 接缝：`ctx.on('tools/execute', …)` —— 官方插件 dsh-tool-call-timeout-policy
 * 使用的同一扩展点。包装器自创的成功结果会被注册表送交 read_image 自身的
 * output schema 归一化并走官方 render（normalizeDispatchResult），模型侧
 * 看到的信封与图片块与官方完全一致。
 *
 * 判定哲学与客户端拦截层一致（未超限零介入）：
 * - 非 read_image / 非图片扩展名 / GIF / 无 attachments 服务 / 类型不在白名单
 *   → 直接 next()，官方流程原样；
 * - 字节预筛（stat.size，零解码成本）：未超有效字节上限 → 先 next()，
 *   仅当官方以"像素/边长拒绝"（或 stat 后字节竞态 FS_TOO_LARGE）失败时
 *   才进入压缩修复 —— 字节未超限但边长超限（如 4K 截图，maxImageDimension
 *   默认仅 2000px）在 read_image 侧是常见情形；
 * - 字节超限（next 必败于 readBytes 的 byteCap）→ 跳过 next 直接接管，
 *   接管前自行复核图像能力门（官方 assertImageCapableRoute 的镜像：
 *   跳过官方路径时必须保证当前路由声明 image 输入）。
 *
 * 安全与合规：
 * - 路径解析与读取全程走 `ctx.fs`（resolve/stat/readBytes），不经 node:fs
 *   直读，保持在部署文件沙箱策略内；
 * - 压缩产物经 `attachments.saveImage` 官方入库通道，全部 admission 校验照常；
 * - 接管成功后补发 `fs/observed`（read-before-write 策略依赖该事件）；
 * - 压缩产物按 `targetKey@version#limits` 进程内缓存，同图重读免重复解码。
 */
import { realpathSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm';
import { compressHostImage, hostOutputName } from './engine.js';
/** 与官方 read_image 一致的扩展名 → 声明媒体类型映射。 */
const IMAGE_EXTENSIONS = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
};
/**
 * 压缩接管的源文件字节上限：超出说明源图体量已非常规照片（readBytes 需全量
 * 读入内存），不接管，由官方 FS_TOO_LARGE 报错兜底。
 */
export const HOST_READ_CEILING = 128 * 1024 * 1024;
/** 压缩结果进程内缓存上限（超出按插入序淘汰最旧条目）。 */
export const COMPRESS_CACHE_CAPACITY = 32;
/**
 * 官方 read_image 对像素/边长拒绝的稳定文案后缀（dsh-tool-fs，rc.8）：
 * `IMAGE_TOO_MANY_PIXELS` 与 `IMAGE_DIMENSION_TOO_LARGE` 均被包装为带该后缀的
 * 普通 Error，error.info 不携带 code，只能按文案识别。上游改写该文案时本插件
 * 退化为官方原样（报错依旧，只是不再自动修复），不会出现错误行为。
 */
const RETRYABLE_REFUSAL_SUFFIX = 'downscale the image and read the smaller copy';
/** 镜像 dsh-tool-fs sessionCwd：cwd 或被求路径含父级遍历时报 canonical 身份。 */
const PARENT_PATH_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/;
function sessionCwdOf(exec, requestedPath) {
    const cwd = exec.agent?.session.header.cwd;
    if (cwd === undefined || (!PARENT_PATH_SEGMENT.test(cwd) && !PARENT_PATH_SEGMENT.test(requestedPath)))
        return cwd;
    try {
        return realpathSync.native(cwd);
    }
    catch {
        return cwd;
    }
}
/** 读取失败结果是否可由压缩修复：字节竞态（类型化 code）或像素/边长拒绝（文案后缀）。 */
function isCompressibleFailure(result) {
    if (!result.isError)
        return false;
    if (result.error.info?.code === 'FS_TOO_LARGE')
        return true;
    return result.error.message.includes(RETRYABLE_REFUSAL_SUFFIX);
}
/** 图像能力门（官方 assertImageCapableRoute 的镜像）：仅在跳过官方路径前调用。 */
async function imageRouteCapable(ctx, exec) {
    try {
        const routed = exec.agent?.session.requestHeader()?.config;
        const provider = routed?.provider ?? exec.agent?.options.provider;
        const model = routed?.model ?? exec.agent?.options.model;
        const llm = ctx.get('llm');
        if (provider === undefined || model === undefined || llm === undefined)
            return false;
        const active = await llm.resolveModelInfo(provider, model, exec.signal);
        return active.inputModalities !== undefined && active.inputModalities.includes('image');
    }
    catch {
        return false; // 无法判定 → 不接管，交官方报错
    }
}
/** 创建 read_image 压缩包装器；返回的函数即 `tools/execute` 监听器。 */
export function createReadImageCompressor(ctx) {
    const cache = new Map();
    /** 压缩 + 入库 + 自创归一化结果；任一阶段失败返回 null（调用方回退官方路径）。 */
    async function compressAndRespond(exec, target, version, mediaType, limits) {
        const cacheKey = `${String(target.targetKey)}@${String(version)}#${limits.maxImageBytes}:${limits.maxImagePixels}:${limits.maxImageDimension}`;
        let artifact = cache.get(cacheKey);
        if (artifact === undefined) {
            let data;
            try {
                data = await ctx.fs.readBytes(target, exec.signal, HOST_READ_CEILING);
            }
            catch {
                return null; // 读取失败（含超 HOST_READ_CEILING）→ 官方报错兜底
            }
            const compressed = await compressHostImage(data, mediaType, limits).catch(() => null);
            if (compressed === null)
                return null;
            artifact = compressed;
            if (cache.size >= COMPRESS_CACHE_CAPACITY) {
                const oldest = cache.keys().next();
                if (!oldest.done)
                    cache.delete(oldest.value);
            }
            cache.set(cacheKey, artifact);
        }
        const attachments = ctx.get('attachments');
        if (attachments === undefined)
            return null;
        let ref;
        try {
            ref = await attachments.saveImage({
                data: artifact.data,
                mediaType: artifact.mediaType,
                name: hostOutputName(basename(target.displayPath), artifact.mediaType),
            });
        }
        catch {
            return null; // 引擎已保证限制内，入库仍失败属意外 → 官方报错兜底
        }
        // read-before-write 策略依赖该事件（官方 read_image 在成功路径同样补发）。
        ctx.emit('fs/observed', target, { kind: 'present', version }, exec);
        const note = `dsh-image-compressor auto-compressed this image to fit deployment limits: ` +
            `${artifact.originalWidth}x${artifact.originalHeight} ${artifact.originalBytes} bytes -> ` +
            `${ref.width}x${ref.height} ${ref.bytes} bytes` +
            (artifact.formatChanged ? `, format changed to ${ref.mediaType}` : '') +
            `. The on-disk file is unchanged; the stored copy is the compressed one.`;
        return {
            isError: false,
            value: {
                path: target.displayPath,
                image: {
                    attachmentId: ref.attachmentId,
                    mediaType: ref.mediaType,
                    bytes: ref.bytes,
                    width: ref.width,
                    height: ref.height,
                    ...(ref.name === undefined ? {} : { name: ref.name }),
                },
            },
            // content 由注册表按 read_image 官方 render 重新生成（normalizeDispatchResult）。
            content: [],
            additionalContexts: [
                createUserMessage({
                    content: [{ type: 'text', text: note }],
                    source: { kind: 'plugin', plugin: 'dsh-image-compressor', form: 'notice', summary: boundContextSummary(note) },
                }),
            ],
        };
    }
    return async function readImageCompressor(exec, next) {
        if (exec.name !== 'read_image')
            return next();
        const args = exec.arguments;
        const filePath = typeof args?.file_path === 'string' ? args.file_path : undefined;
        if (filePath === undefined || filePath.trim().length === 0)
            return next();
        const declared = IMAGE_EXTENSIONS[extname(filePath).toLowerCase()];
        if (declared === undefined)
            return next(); // 非图片扩展名：官方报错
        if (declared === 'image/gif')
            return next(); // GIF 动画不压缩（与客户端 R-07 一致）
        const attachments = ctx.get('attachments');
        if (attachments === undefined)
            return next();
        const limits = attachments.imageLimits;
        if (!limits.mediaTypes.includes(declared))
            return next();
        // 合规预筛：resolve/stat 走 ctx.fs，与官方 resolveRegularReadTarget 同一入口。
        let target;
        let info;
        try {
            const cwd = sessionCwdOf(exec, filePath);
            target = await ctx.fs.resolve(filePath, { ...(cwd === undefined ? {} : { cwd }), signal: exec.signal });
            info = await ctx.fs.stat(target, exec.signal);
        }
        catch {
            return next(); // 解析/stat 失败：官方产出准确报错（含 fs/observed absent）
        }
        if (info === undefined || info.type !== 'file')
            return next();
        const effectiveLimits = {
            // 官方 read_image 的字节上限是两者的较小者（readBytes byteCap）。
            maxImageBytes: Math.min(limits.maxImageBytes, limits.maxMessageImageBytes),
            maxImagePixels: limits.maxImagePixels,
            maxImageDimension: limits.maxImageDimension,
        };
        if (info.size !== undefined && info.size > effectiveLimits.maxImageBytes) {
            // 字节超限：next 必败于 readBytes byteCap，跳过官方直接接管。
            if (info.size > HOST_READ_CEILING)
                return next();
            if (!(await imageRouteCapable(ctx, exec)))
                return next(); // 跳过官方前自核能力门
            return (await compressAndRespond(exec, target, info.version, declared, effectiveLimits)) ?? next();
        }
        // 字节未超限（或后端不报 size）：官方先行，零介入；仅修复可压缩拒绝。
        const result = await next();
        if (!isCompressibleFailure(result))
            return result;
        return (await compressAndRespond(exec, target, info.version, declared, effectiveLimits)) ?? result;
    };
}
