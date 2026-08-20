// 摄入拦截与注入单测（阶段3）：判定条件矩阵 + 批次处理不变量（顺序保持、
// GIF/失败原样入列、引擎异常兜底）。DOM 监听挂载由阶段1 浏览器探针 + 阶段6
// 验收覆盖，Node 侧只测纯函数面。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadClient } from './helpers/load-client.mjs'

const { client } = await loadClient()
const {
  shouldTakeOver,
  asImageLimits,
  processBatch,
  isMarked,
  INJECTION_MARK,
} = client

const MB = 1024 * 1024
const LIMITS = { maxImageBytes: 5 * MB, maxImagePixels: 40_000_000 }

function fileOf(name, type, bytes) {
  return new File([new Uint8Array(bytes)], name, { type })
}

function facts(overrides = {}) {
  return {
    injected: false,
    hasSession: true,
    running: false,
    limits: LIMITS,
    files: [],
    ...overrides,
  }
}

test('判定矩阵：注入标记 / 无会话 / 忙 / 无投影 / 非图片一律放行', () => {
  const over = [fileOf('big.png', 'image/png', 9 * MB)]
  assert.equal(shouldTakeOver(facts({ injected: true, files: over })), false)
  assert.equal(shouldTakeOver(facts({ hasSession: false, files: over })), false)
  assert.equal(shouldTakeOver(facts({ running: true, files: over })), false)
  assert.equal(shouldTakeOver(facts({ limits: undefined, files: over })), false)

  const nonImage = [fileOf('notes.txt', 'text/plain', 9 * MB)]
  assert.equal(shouldTakeOver(facts({ files: nonImage })), false)
  const gifOnly = [fileOf('anim.gif', 'image/gif', 9 * MB)]
  assert.equal(shouldTakeOver(facts({ files: gifOnly })), false)
  const empty = []
  assert.equal(shouldTakeOver(facts({ files: empty })), false)
})

test('判定矩阵：字节预筛——未超限放行、存在超限可压缩图才接管', () => {
  const under = [fileOf('small.png', 'image/png', 1 * MB)]
  assert.equal(shouldTakeOver(facts({ files: under })), false)
  const exact = [fileOf('exact.jpg', 'image/jpeg', 5 * MB)]
  assert.equal(shouldTakeOver(facts({ files: exact })), false, '恰好等于限制不算超限')
  const overJpeg = [fileOf('big.jpg', 'image/jpeg', 6 * MB)]
  assert.equal(shouldTakeOver(facts({ files: overJpeg })), true)
  // 混合批次：含一张超限 → 接管
  const mixed = [
    fileOf('a.txt', 'text/plain', 3 * MB),
    fileOf('gif.gif', 'image/gif', 8 * MB),
    fileOf('small.png', 'image/png', 1 * MB),
    fileOf('big.webp', 'image/webp', 7 * MB),
  ]
  assert.equal(shouldTakeOver(facts({ files: mixed })), true)
})

test('asImageLimits 防御：缺投影/非法值返回 undefined，合法值投影出结构', () => {
  assert.equal(asImageLimits(undefined), undefined)
  assert.equal(asImageLimits(null), undefined)
  assert.equal(asImageLimits({}), undefined)
  assert.equal(asImageLimits({ maxImageBytes: '5M', maxImagePixels: 40_000_000 }), undefined)
  assert.equal(asImageLimits({ maxImageBytes: 0, maxImagePixels: 40_000_000 }), undefined)
  assert.deepEqual(
    asImageLimits({ maxImageBytes: 5 * MB, maxImagePixels: 40_000_000, mediaTypes: ['image/png'] }),
    { maxImageBytes: 5 * MB, maxImagePixels: 40_000_000 },
  )
})

test('批次处理：顺序保持，GIF 与失败图原样入列（字节不变，引用不变）', async () => {
  const gif = fileOf('anim.gif', 'image/gif', 9 * MB)
  const big = fileOf('big.png', 'image/png', 6 * MB)
  const small = fileOf('small.png', 'image/png', 1 * MB)
  const broken = fileOf('broken.png', 'image/png', 7 * MB)
  const txt = fileOf('notes.txt', 'text/plain', 2 * MB)

  const compressCalls = []
  const batch = await processBatch([gif, big, small, broken, txt], LIMITS, async (file) => {
    compressCalls.push(file.name)
    if (file.name === 'big.png') {
      return {
        file: fileOf('big.webp', 'image/webp', 900 * 1024),
        originalName: 'big.png', changed: true, originalBytes: file.size,
        status: 'compressed', overLimit: false, formatChanged: true,
      }
    }
    if (file.name === 'broken.png') {
      return { file, originalName: file.name, changed: false, originalBytes: file.size, status: 'failed', overLimit: false, formatChanged: false }
    }
    // small.png 未超限 → 引擎原样
    return { file, originalName: file.name, changed: false, originalBytes: file.size, status: 'unchanged', overLimit: false, formatChanged: false }
  })

  assert.deepEqual(batch.items.map((r) => r.file.name), [
    'anim.gif', 'big.webp', 'small.png', 'broken.png', 'notes.txt',
  ])
  assert.deepEqual(batch.items.map((r) => r.originalIndex), [0, 1, 2, 3, 4])
  // GIF 与非图片未进入压缩器
  assert.deepEqual(compressCalls, ['big.png', 'small.png', 'broken.png'])
  // GIF/失败/未超限保持原文件对象（字节不变）
  assert.equal(batch.items[0].file, gif)
  assert.equal(batch.items[3].file, broken)
  assert.equal(batch.items[2].file, small)
  assert.equal(batch.items[4].file, txt)
  // 统计
  assert.equal(batch.images, 3)
  assert.equal(batch.compressed, 1)
  assert.equal(batch.failed, 1)
  assert.equal(batch.overLimit, 0)
  assert.deepEqual(batch.changedTo, ['webp'])
  assert.equal(batch.totalBefore, 9 * MB + 6 * MB + 1 * MB + 7 * MB + 2 * MB)
  assert.equal(batch.totalAfter, 9 * MB + 900 * 1024 + 1 * MB + 7 * MB + 2 * MB)
})

test('批次处理：引擎抛错 → failed 原样，绝不丢图', async () => {
  const a = fileOf('a.png', 'image/png', 6 * MB)
  const batch = await processBatch([a], LIMITS, async () => { throw new Error('boom') })
  assert.equal(batch.items[0].status, 'failed')
  assert.equal(batch.items[0].file, a)
  assert.equal(batch.failed, 1)
})

test('批次处理：overLimit 尽力而为计入统计并保持输出', async () => {
  const a = fileOf('a.png', 'image/png', 6 * MB)
  const batch = await processBatch([a], LIMITS, async () => ({
    file: fileOf('a.webp', 'image/webp', 9 * MB),
    originalName: 'a.png', changed: true, originalBytes: a.size,
    status: 'compressed', overLimit: true, formatChanged: true,
  }))
  assert.equal(batch.compressed, 1)
  assert.equal(batch.overLimit, 1)
  assert.equal(batch.items[0].overLimit, true)
})

test('空批次：全零统计', async () => {
  const batch = await processBatch([], LIMITS, async () => { throw new Error('unused') })
  assert.deepEqual(batch, {
    items: [], images: 0, compressed: 0, failed: 0, overLimit: 0,
    totalBefore: 0, totalAfter: 0, changedTo: [],
  })
})

test('注入标记：isMarked 能识别挂上私有符号的事件对象', () => {
  const event = new Event('drop', { bubbles: true, cancelable: true })
  assert.equal(isMarked(event), false)
  ;(event)[INJECTION_MARK] = true
  assert.equal(isMarked(event), true)
})
