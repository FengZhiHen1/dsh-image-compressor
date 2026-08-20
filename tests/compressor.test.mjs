// 压缩引擎单测（阶段2）：通过 bundle 面读取纯逻辑 + fake CompressHost 驱动
// `compressImage` 全管线。覆盖 compression-engine.md 验证计划四项。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadClient } from './helpers/load-client.mjs'

const { client } = await loadClient()
const {
  shouldProcess,
  isCompressibleType,
  pixelTarget,
  formatPlan,
  outputNameOf,
  compressImage,
  QUALITY_STEPS,
  MAX_ROUNDS,
  DOWNSIZE_FACTOR,
} = client

const MB = 1024 * 1024

/** 构造一张任意字节的文件。 */
function fileOf(name, type, bytes) {
  const buf = new Uint8Array(bytes)
  for (let i = 0; i < bytes; i += 1) buf[i] = (i * 13) & 0xff
  return new File([buf], name, { type })
}

/** 可编程 fake host：解码尺寸 / WebP 支持 / 编码字节均受控，并记录调用。 */
function fakeHost(options = {}) {
  const {
    width = 100, height = 80,
    webp = true,
    encodeBytes = () => 64 * 1024,
    encodeNull = false,
    decodeFail = false,
  } = options
  const calls = { draws: [], canvases: [], encodes: 0, fillWhites: 0, closed: 0 }
  const host = {
    calls,
    async decode() {
      if (decodeFail) throw new Error('decode-boom')
      return { width, height, close: () => { calls.closed += 1 } }
    },
    canvas(w, h) {
      const handle = {
        width: w, height: h, backing: {},
        draw: (bitmap, dw, dh) => { calls.draws.push({ w: dw, h: dh }) },
        fillWhite: () => { calls.fillWhites += 1 },
      }
      calls.canvases.push(handle)
      return handle
    },
    async encode(canvas, mime, quality) {
      calls.encodes += 1
      if (encodeNull) return null
      const size = encodeBytes(quality)
      return new Blob([new Uint8Array(Math.max(1, size))], { type: mime })
    },
    async supportsWebp() { return webp },
  }
  return host
}

const LIMITS = { maxImageBytes: 5 * MB, maxImagePixels: 40_000_000 }

test('shouldProcess 是纯字节预筛，超限才 true', () => {
  assert.equal(shouldProcess({ size: 5 * MB + 1 }, LIMITS), true)
  assert.equal(shouldProcess({ size: 5 * MB }, LIMITS), false)
  assert.equal(shouldProcess({ size: 1024 }, LIMITS), false)
})

test('isCompressibleType 只认 PNG/JPEG/WebP，GIF 与非图片不被引擎接收', () => {
  assert.equal(isCompressibleType('image/png'), true)
  assert.equal(isCompressibleType('image/jpeg'), true)
  assert.equal(isCompressibleType('image/jpg'), true)
  assert.equal(isCompressibleType('image/webp'), true)
  assert.equal(isCompressibleType('image/gif'), false)
  assert.equal(isCompressibleType('text/plain'), false)
})

test('pixelTarget：超限时等比缩至限制内且宽高比不变、不放大', () => {
  const { width, height } = pixelTarget(8000, 6000, 40_000_000)
  assert.ok(width * height <= 40_000_000, `43.2e7 -> ${width}x${height}`)
  assert.ok(width < 8000 && height < 6000)
  const ratio = width / height
  assert.ok(Math.abs(ratio - 8000 / 6000) < 0.01, `ratio ${ratio}`)
  // 未超限：原样返回
  assert.deepEqual(pixelTarget(800, 600, 40_000_000), { width: 800, height: 600 })
})

test('formatPlan 格式映射矩阵', () => {
  assert.equal(formatPlan('image/jpeg', true).mime, 'image/jpeg')
  assert.equal(formatPlan('image/jpeg', false).mime, 'image/jpeg')
  assert.equal(formatPlan('image/png', true).mime, 'image/webp')
  assert.equal(formatPlan('image/webp', true).mime, 'image/webp')
  assert.equal(formatPlan('image/png', false).mime, 'image/jpeg')
  assert.equal(formatPlan('image/webp', false).mime, 'image/jpeg')
})

test('outputNameOf 文件名矩阵：保留主干、更新/追加扩展名', () => {
  assert.equal(outputNameOf('photo.png', 'image/webp'), 'photo.webp')
  assert.equal(outputNameOf('photo', 'image/webp'), 'photo.webp')
  assert.equal(outputNameOf('a.b.png', 'image/webp'), 'a.b.webp')
  assert.equal(outputNameOf('photo.png', 'image/jpeg'), 'photo.jpg')
  assert.equal(outputNameOf('photo.jpg', 'image/jpeg'), 'photo.jpg')
  assert.equal(outputNameOf('photo.PNG', 'image/webp'), 'photo.webp')
})

test('字节超限 JPEG → 重编码为 JPEG，输出 ≤ 限制且不放大尺寸', async () => {
  const host = fakeHost({ width: 100, height: 80, encodeBytes: () => 1 * MB })
  const result = await compressImage(fileOf('shot.jpg', 'image/jpeg', 8 * MB), LIMITS, host)
  assert.equal(result.status, 'compressed')
  assert.equal(result.changed, true)
  assert.equal(result.originalName, 'shot.jpg')
  assert.equal(result.formatChanged, false)
  assert.equal(result.file.type, 'image/jpeg')
  assert.equal(result.file.name, 'shot.jpg')
  assert.ok(result.file.size <= LIMITS.maxImageBytes)
  // 未超像素 → 目标尺寸 = 原始尺寸（不放大）
  assert.equal(host.calls.draws[0].w, 100)
  assert.equal(host.calls.draws[0].h, 80)
  assert.equal(host.calls.closed, 1, 'bitmap.close 必须被调用')
})

test('像素超限 → 输出尺寸等比缩至限制内且宽高比不变', async () => {
  const host = fakeHost({ width: 8000, height: 6000, encodeBytes: () => 1 * MB })
  const result = await compressImage(fileOf('huge.png', 'image/png', 9 * MB), LIMITS, host)
  assert.equal(result.status, 'compressed')
  const first = host.calls.draws[0]
  assert.ok(first.w * first.h <= LIMITS.maxImagePixels)
  assert.ok(Math.abs(first.w / first.h - 8000 / 6000) < 0.01)
  assert.equal(result.file.name, 'huge.webp', 'PNG → WebP')
  assert.equal(result.file.type, 'image/webp')
})

test('透明 PNG → WebP 保 alpha（webp 支持时）；无 WebP → JPEG 白底合成', async () => {
  const withWebp = fakeHost({ webp: true, encodeBytes: () => 1 * MB })
  const r1 = await compressImage(fileOf('transparent.png', 'image/png', 6 * MB), LIMITS, withWebp)
  assert.equal(r1.file.type, 'image/webp')
  assert.equal(r1.file.name, 'transparent.webp')
  assert.equal(r1.formatChanged, true)
  assert.equal(withWebp.calls.fillWhites, 0, 'WebP 输出不需白底')

  const noWebp = fakeHost({ webp: false, encodeBytes: () => 1 * MB })
  const r2 = await compressImage(fileOf('transparent.png', 'image/png', 6 * MB), LIMITS, noWebp)
  assert.equal(r2.file.type, 'image/jpeg')
  assert.equal(r2.file.name, 'transparent.jpg')
  assert.ok(noWebp.calls.fillWhites > 0, 'JPEG 兜底需白底合成')
})

test('质量迭代收敛：极端图返回 overLimit 标记且不抛错、轮次受上限约束', async () => {
  // 所有质量/尺寸轮编码都超限 → 尽力而为 overLimit
  const host = fakeHost({ width: 60, height: 40, encodeBytes: () => 9 * MB })
  const result = await compressImage(fileOf('brutal.jpg', 'image/jpeg', 12 * MB), LIMITS, host)
  assert.equal(result.status, 'compressed')
  assert.equal(result.overLimit, true)
  assert.equal(result.changed, true)
  assert.ok(host.calls.encodes >= 1)
  assert.ok(host.calls.encodes <= MAX_ROUNDS, `encodes=${host.calls.encodes} ≤ ${MAX_ROUNDS}`)
  assert.ok(result.file.size > 0)
})

test('解码失败（伪装损坏）→ failed 原样返回，字节不变、不丢图', async () => {
  const host = fakeHost({ decodeFail: true })
  const original = fileOf('broken.png', 'image/png', 7 * MB)
  const result = await compressImage(original, LIMITS, host)
  assert.equal(result.status, 'failed')
  assert.equal(result.changed, false)
  assert.equal(result.originalName, 'broken.png')
  assert.equal(result.file, original, '必须返回原文件对象')
  assert.equal(result.file.size, 7 * MB)
})

test('GIF / 不压缩类型 → unchanged 原样（引擎不接收由拦截层保证，此处防御）', async () => {
  const host = fakeHost()
  const gif = fileOf('anim.gif', 'image/gif', 9 * MB)
  const result = await compressImage(gif, LIMITS, host)
  assert.equal(result.status, 'unchanged')
  assert.equal(result.file, gif)
  assert.equal(host.calls.encodes, 0)
})

test('全部编码轮返回 null（编码不可用）→ failed 原样，不抛错', async () => {
  const host = fakeHost({ encodeNull: true })
  const result = await compressImage(fileOf('x.png', 'image/png', 6 * MB), LIMITS, host)
  assert.equal(result.status, 'failed')
  assert.equal(result.file.name, 'x.png')
  assert.equal(result.file.size, 6 * MB)
})

test('字节未超限由调用方拦截（防御：引擎不处理未超限输入）', async () => {
  const host = fakeHost()
  const small = fileOf('small.png', 'image/png', 100)
  const result = await compressImage(small, LIMITS, host)
  assert.equal(result.status, 'unchanged')
  assert.equal(result.file, small)
  assert.equal(host.calls.encodes, 0)
})

test('常量符合设计基线', () => {
  assert.deepEqual([...QUALITY_STEPS], [0.85, 0.7, 0.5, 0.3, 0.15])
  assert.equal(MAX_ROUNDS, 6)
  assert.equal(DOWNSIZE_FACTOR, 0.75)
})
