/**
 * dsh-image-compressor — node half.
 *
 * Pure client plugin (C-02)：空 apply 用于让本插件以合法 host loader entry
 * 出现在 profile 的 cordis 组合中；浏览器半区经 `exports["./client"]` 分发，
 * 由 package.json 的 `dsh.client` 声明被 client-modules 发现并注入 boot graph。
 */

/** Host plugin body — 无任何 host 侧行为（纯 Client 插件）。 */
export function apply(): void {}
