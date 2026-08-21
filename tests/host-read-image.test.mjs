// Host 面 read_image 压缩包装器单测：判定矩阵（直通 / 修复 / 接管 / 兜底）、
// 能力门、缓存与 fs/observed 补发。夹具用真实 sharp 生成，saveImage 桩
// 复刻 attachment-local 的 admission 校验（解码 + 字节 / 像素 / 边长）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'

const { apply } = await import('../lib/index.js')
const { HOST_READ_CEILING } = await import('../lib/host/read-image-wrapper.js')

// 有效字节上限 300KB（min(maxImageBytes, maxMessageImageBytes)），单边 2000px。
const LIMITS = {
  maxImageBytes: 300_000,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 100_000_000,
  maxImagePixels: 40_000_000,
  maxImageDimension: 2_000,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

// 确定性伪随机（xorshift32），保证噪声夹具跨运行可复现且 PNG 无法 deflate 压缩。
function lcgNoise(length) {
  const out = new Uint8Array(length)
  let state = 0x2f6e2b1
  for (let i = 0; i < length; i += 1) {
    state ^= (state << 13) | 0
    state ^= state >>> 17
    state ^= (state << 5) | 0
    out[i] = state & 0xff
  }
  return out
}

// 夹具 A：3000×1200 纯色 PNG —— 字节小（远低于 cap）但单边 3000 > 2000（边长超限）。
const FIXTURE_DIMENSION_OVER = await sharp({
  create: { width: 3000, height: 1200, channels: 3, background: { r: 60, g: 120, b: 200 } },
}).png().toBuffer()

// 夹具 B：800×600 噪声 PNG —— 尺寸合规但字节远超 300KB cap（PNG 无损 ≈ 1.4MB）。
const FIXTURE_BYTE_OVER = await sharp(lcgNoise(800 * 600 * 3), {
  raw: { width: 800, height: 600, channels: 3 },
}).png().toBuffer()
assert.ok(FIXTURE_BYTE_OVER.byteLength > LIMITS.maxImageBytes, '噪声夹具必须超过字节上限')

const REFUSAL_SUFFIX = 'downscale the image and read the smaller copy'

function makeHarness(fixture, options = {}) {
  const calls = { next: 0, readBytes: 0, saveImage: 0, resolveModelInfo: 0 }
  const emitted = []
  const listeners = []
  const target = { targetKey: `key:${options.path ?? 'shot.png'}`, displayPath: options.path ?? 'shot.png' }
  const info = options.absent
    ? undefined
    : { version: 'v1', type: 'file', size: options.size ?? fixture.byteLength }

  const attachments = {
    imageLimits: { ...LIMITS, ...(options.limits ?? {}) },
    async saveImage(input) {
      calls.saveImage += 1
      // 复刻 attachment-local admission：字节 + 全解码 + 像素/边长 + 格式一致。
      assert.ok(input.data.byteLength <= this.imageLimits.maxImageBytes, '入库字节必须已在限制内')
      const meta = await sharp(input.data, { failOn: 'error' }).metadata()
      assert.ok(meta.width * meta.height <= this.imageLimits.maxImagePixels)
      assert.ok(Math.max(meta.width, meta.height) <= this.imageLimits.maxImageDimension)
      return {
        attachmentId: 'sha256:' + 'ab'.repeat(32),
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: meta.width,
        height: meta.height,
        ...(input.name === undefined ? {} : { name: input.name }),
      }
    },
  }

  const ctx = {
    on(event, fn) { listeners.push({ event, fn }) },
    get(name) {
      if (name === 'attachments') return options.noAttachments ? undefined : attachments
      if (name === 'llm') {
        return {
          async resolveModelInfo() {
            calls.resolveModelInfo += 1
            return { inputModalities: options.imageCapable === false ? ['text'] : ['text', 'image'] }
          },
        }
      }
      return undefined
    },
    fs: {
      async resolve(path) { return { targetKey: `key:${path}`, displayPath: path } },
      async stat() { return info },
      async readBytes(_t, _s, maxBytes) {
        calls.readBytes += 1
        if (fixture.byteLength > maxBytes) {
          const err = new Error('too large')
          err.code = 'FS_TOO_LARGE'
          throw err
        }
        return fixture
      },
    },
    emit(event, ...args) { emitted.push({ event, args }) },
  }

  apply(ctx)
  assert.equal(listeners.length, 1)
  assert.equal(listeners[0].event, 'tools/execute')
  const wrapper = listeners[0].fn

  const exec = {
    name: 'read_image',
    arguments: { file_path: options.path ?? 'shot.png' },
    signal: new AbortController().signal,
    agent: {
      session: {
        header: {},
        requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
      },
      options: {},
    },
  }

  const next = async () => {
    calls.next += 1
    const behavior = options.nextBehavior ?? 'success'
    if (behavior === 'success') {
      return { isError: false, value: { path: 'official' }, content: [{ type: 'text', text: 'official' }] }
    }
    if (behavior === 'dimension-refusal') {
      return {
        isError: true,
        error: { message: `cannot read "shot.png": at least one image side exceeds the 2000px limit; ${REFUSAL_SUFFIX}` },
        content: [{ type: 'text', text: 'Error: ...' }],
      }
    }
    if (behavior === 'fs-too-large') {
      return {
        isError: true,
        error: { message: 'cannot read "shot.png": 400000 bytes exceeds the 300000-byte limit', info: { name: 'FsError', code: 'FS_TOO_LARGE' } },
        content: [{ type: 'text', text: 'Error: ...' }],
      }
    }
    return { isError: true, error: { message: 'boom' }, content: [{ type: 'text', text: 'Error: boom' }] }
  }

  return { wrapper, exec, next, calls, emitted }
}

test('非 read_image 调用直通', async () => {
  const { wrapper, exec, next, calls } = makeHarness(FIXTURE_BYTE_OVER)
  const result = await wrapper({ ...exec, name: 'read' }, next)
  assert.equal(result.isError, false)
  assert.equal(calls.next, 1)
  assert.equal(calls.readBytes, 0)
})

test('非图片扩展名 / GIF / 无 attachments 服务均直通（GIF 即使字节超限也不接管）', async () => {
  for (const [path, extra] of [['notes.txt', {}], ['anim.gif', {}], ['shot.png', { noAttachments: true }]]) {
    const { wrapper, exec, next, calls } = makeHarness(FIXTURE_BYTE_OVER, { path, ...extra })
    await wrapper(exec, next)
    assert.equal(calls.next, 1, path)
    assert.equal(calls.readBytes, 0, path)
  }
})

test('声明类型不在部署白名单时直通', async () => {
  const { wrapper, exec, next, calls } = makeHarness(FIXTURE_BYTE_OVER, {
    path: 'shot.webp',
    limits: { mediaTypes: ['image/png', 'image/jpeg'] },
  })
  await wrapper(exec, next)
  assert.equal(calls.next, 1)
  assert.equal(calls.saveImage, 0)
})

test('字节未超限且官方成功：零介入直通（不读字节、不入库）', async () => {
  const { wrapper, exec, next, calls } = makeHarness(FIXTURE_DIMENSION_OVER, { nextBehavior: 'success' })
  const result = await wrapper(exec, next)
  assert.equal(result.isError, false)
  assert.equal(result.value.path, 'official')
  assert.equal(calls.next, 1)
  assert.equal(calls.readBytes, 0)
  assert.equal(calls.saveImage, 0)
})

test('边长超限修复：官方拒绝后压缩接管，结果归一化并补发 fs/observed', async () => {
  const { wrapper, exec, next, calls, emitted } = makeHarness(FIXTURE_DIMENSION_OVER, { nextBehavior: 'dimension-refusal' })
  const result = await wrapper(exec, next)

  assert.equal(calls.next, 1, '官方先行一次')
  assert.equal(calls.resolveModelInfo, 0, '修复路径不重复能力门（官方已核）')
  assert.equal(result.isError, false)
  assert.equal(result.value.path, 'shot.png')
  assert.equal(result.value.image.width, 2000)
  assert.equal(result.value.image.height, 800)
  assert.ok(result.value.image.bytes <= LIMITS.maxImageBytes)
  assert.equal(result.value.image.mediaType, 'image/webp', 'PNG→WebP（保 alpha 策略）')
  assert.equal(calls.saveImage, 1)
  assert.equal(result.additionalContexts.length, 1)
  assert.equal(result.additionalContexts[0].source.kind, 'plugin')
  assert.equal(result.additionalContexts[0].source.plugin, 'dsh-image-compressor')
  assert.equal(result.additionalContexts[0].source.form, 'notice')
  assert.ok(result.additionalContexts[0].content[0].text.includes('3000x1200'))
  assert.ok(emitted.some((e) => e.event === 'fs/observed' && e.args[1].kind === 'present'))
})

test('官方其他失败原样返回，不修复', async () => {
  const { wrapper, exec, next, calls } = makeHarness(FIXTURE_DIMENSION_OVER, { nextBehavior: 'other-error' })
  const result = await wrapper(exec, next)
  assert.equal(result.isError, true)
  assert.equal(result.error.message, 'boom')
  assert.equal(calls.saveImage, 0)
})

test('字节超限直接接管：跳过官方路径，但先自核图像能力门', async () => {
  const { wrapper, exec, next, calls } = makeHarness(FIXTURE_BYTE_OVER)
  const result = await wrapper(exec, next)
  assert.equal(calls.next, 0, 'next 必败（FS_TOO_LARGE），不应调用')
  assert.equal(calls.resolveModelInfo, 1, '跳过官方前必须自核能力门')
  assert.equal(result.isError, false)
  assert.ok(result.value.image.bytes <= LIMITS.maxImageBytes)
  assert.equal(result.value.image.mediaType, 'image/webp')
  assert.equal(calls.saveImage, 1)
})

test('字节超限但路由无图像输入能力：交回官方报错', async () => {
  const { wrapper, exec, next, calls } = makeHarness(FIXTURE_BYTE_OVER, { imageCapable: false, nextBehavior: 'fs-too-large' })
  const result = await wrapper(exec, next)
  assert.equal(calls.next, 1)
  assert.equal(result.isError, true)
  assert.equal(calls.saveImage, 0)
})

test('stat 后字节竞态（next 返回类型化 FS_TOO_LARGE）也进入修复', async () => {
  const { wrapper, exec, next, calls } = makeHarness(FIXTURE_BYTE_OVER, {
    size: 1000, // stat 时未超限
    nextBehavior: 'fs-too-large',
  })
  const result = await wrapper(exec, next)
  assert.equal(calls.next, 1)
  assert.equal(result.isError, false)
  assert.equal(calls.saveImage, 1)
})

test('超过 HOST_READ_CEILING 的巨文件不接管', async () => {
  const { wrapper, exec, next, calls } = makeHarness(FIXTURE_BYTE_OVER, { size: HOST_READ_CEILING + 1 })
  await wrapper(exec, next)
  assert.equal(calls.next, 1)
  assert.equal(calls.readBytes, 0)
})

test('文件缺失 / 非常规文件直通（官方负责报错与 absent 观察）', async () => {
  const { wrapper, exec, next, calls } = makeHarness(FIXTURE_BYTE_OVER, { absent: true })
  await wrapper(exec, next)
  assert.equal(calls.next, 1)
  assert.equal(calls.readBytes, 0)
})

test('同图同版本重读命中进程内缓存：只解码压缩一次，入库仍各走官方通道', async () => {
  const { wrapper, exec, next, calls } = makeHarness(FIXTURE_BYTE_OVER)
  const first = await wrapper(exec, next)
  const second = await wrapper(exec, next)
  assert.equal(first.isError, false)
  assert.equal(second.isError, false)
  assert.equal(calls.readBytes, 1, '第二次命中缓存，不再读源文件')
  assert.equal(calls.saveImage, 2, '每次调用仍独立入库（内容寻址去重）')
})
