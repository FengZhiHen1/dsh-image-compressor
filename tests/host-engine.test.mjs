// Host 压缩引擎单测：等比缩放目标（像素/边长/不放大）、输出命名、
// 真实 sharp 管线的压缩契约（产物必在全部限制内）与垃圾输入兜底。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'

const { compressHostImage, hostOutputName, hostPixelTarget, DECODE_PIXEL_CAP, MAX_ROUNDS, QUALITY_STEPS, DOWNSIZE_FACTOR } = await import('../lib/host/engine.js')

test('常数与客户端引擎对齐', () => {
  assert.deepEqual([...QUALITY_STEPS], [85, 70, 50, 30, 15])
  assert.equal(MAX_ROUNDS, 6)
  assert.equal(DOWNSIZE_FACTOR, 0.75)
  assert.ok(DECODE_PIXEL_CAP >= 108_000_000, '至少覆盖真实手机照片像素量级')
})

test('hostPixelTarget：像素与边长同时满足、不放大、宽高比不变', () => {
  // 边长触发：3000×1200，maxDim 2000 → 2000×800
  assert.deepEqual(hostPixelTarget(3000, 1200, 40e6, 2000), { width: 2000, height: 800 })
  // 像素触发：8000×5000（40MP 边界外）→ floor 后总像素 ≤ maxPixels
  const scaled = hostPixelTarget(8000, 5000, 40e6, 10000)
  assert.ok(scaled.width * scaled.height <= 40e6)
  assert.ok(Math.abs(scaled.width / scaled.height - 8000 / 5000) < 0.01)
  // 限制内不放大
  assert.deepEqual(hostPixelTarget(800, 600, 40e6, 2000), { width: 800, height: 600 })
  // 极端细长图：两边均 ≤ maxDim 且 ≥1
  const thin = hostPixelTarget(100000, 10, 40e6, 2000)
  assert.ok(thin.width <= 2000 && thin.height >= 1)
})

test('hostOutputName：扩展名跟随输出格式', () => {
  assert.equal(hostOutputName('photo.png', 'image/webp'), 'photo.webp')
  assert.equal(hostOutputName('photo.jpeg', 'image/jpeg'), 'photo.jpg')
  assert.equal(hostOutputName('noext', 'image/webp'), 'noext.webp')
  assert.equal(hostOutputName('.hidden', 'image/jpeg'), '.hidden.jpg')
})

const LIMITS = { maxImageBytes: 300_000, maxImagePixels: 40e6, maxImageDimension: 2_000 }

test('compressHostImage：边长超限 PNG → WebP，产物满足全部限制并标 formatChanged', async () => {
  const source = await sharp({
    create: { width: 3000, height: 1200, channels: 4, background: { r: 60, g: 120, b: 200, alpha: 0.5 } },
  }).png().toBuffer()
  const out = await compressHostImage(source, 'image/png', LIMITS)
  assert.ok(out !== null)
  assert.equal(out.mediaType, 'image/webp')
  assert.equal(out.formatChanged, true)
  assert.equal(out.width, 2000)
  assert.equal(out.height, 800)
  assert.equal(out.originalWidth, 3000)
  assert.equal(out.originalHeight, 1200)
  assert.ok(out.data.byteLength <= LIMITS.maxImageBytes)
  const meta = await sharp(out.data).metadata()
  assert.equal(meta.format, 'webp')
  assert.equal(meta.hasAlpha, true, 'WebP 保留 alpha')
})

test('compressHostImage：字节超限 JPEG 噪声 → 保持 JPEG，字节落入限制', async () => {
  const noise = new Uint8Array(800 * 600 * 3)
  let state = 7
  for (let i = 0; i < noise.length; i += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    noise[i] = (state >>> 16) & 0xff
  }
  const source = await sharp(noise, { raw: { width: 800, height: 600, channels: 3 } }).jpeg({ quality: 95 }).toBuffer()
  assert.ok(source.byteLength > LIMITS.maxImageBytes, '夹具必须超限')
  const out = await compressHostImage(source, 'image/jpeg', LIMITS)
  assert.ok(out !== null)
  assert.equal(out.mediaType, 'image/jpeg')
  assert.equal(out.formatChanged, false)
  assert.ok(out.data.byteLength <= LIMITS.maxImageBytes)
  assert.equal(out.width, 800, '尺寸合规时不动尺寸')
  assert.equal(out.height, 600)
})

test('compressHostImage：垃圾字节返回 null（调用方回退官方路径）', async () => {
  assert.equal(await compressHostImage(new Uint8Array([1, 2, 3, 4]), 'image/png', LIMITS), null)
})
