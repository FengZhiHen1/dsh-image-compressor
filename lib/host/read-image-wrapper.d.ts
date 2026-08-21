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
import type { Context } from '@deepseek-ai/cordis';
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools';
/**
 * 压缩接管的源文件字节上限：超出说明源图体量已非常规照片（readBytes 需全量
 * 读入内存），不接管，由官方 FS_TOO_LARGE 报错兜底。
 */
export declare const HOST_READ_CEILING: number;
/** 压缩结果进程内缓存上限（超出按插入序淘汰最旧条目）。 */
export declare const COMPRESS_CACHE_CAPACITY = 32;
/** 创建 read_image 压缩包装器；返回的函数即 `tools/execute` 监听器。 */
export declare function createReadImageCompressor(ctx: Context): (exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>) => Promise<ToolExecutionResult>;
