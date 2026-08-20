// 通知层单测（阶段4）：publish 聚合语义（多张合并、失败计数、overLimit 标记、
// 格式变化、粘贴文本丢弃）、summaryOf 派生、队列出队与订阅。文案走 bundle 内
// zh 词典 + 本地插值 translate（与运行时 ctx.locale.bind 行为对齐）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadClient } from './helpers/load-client.mjs'

const { client } = await loadClient()
const {
  buildNotification,
  summaryOf,
  formatBytes,
  zh,
  resetNotifyStore,
  clearNotifyStore,
  getNotifySnapshot,
  subscribeNotify,
  publish,
  dismiss,
} = client

const translate = (key, params = {}) =>
  zh[key].replace(/\{(\w+)\}/g, (_, name) => params[name] ?? `{${name}}`)

const MB = 1024 * 1024

function batchOf(overrides = {}) {
  return {
    items: [], images: 0, compressed: 0, failed: 0, overLimit: 0,
    totalBefore: 0, totalAfter: 0, changedTo: [],
    ...overrides,
  }
}

function compressedItem(name, before, after, overLimit = false, type = 'image/webp') {
  return {
    file: new File([new Uint8Array(after)], name, { type }),
    originalName: name, changed: true, originalBytes: before,
    status: 'compressed', overLimit, formatChanged: type !== 'image/jpeg',
  }
}

test('formatBytes：MB / KB / B 朗读', () => {
  assert.equal(formatBytes(12.3 * 1024 * 1024), '12.3MB')
  assert.equal(formatBytes(4.1 * 1024 * 1024), '4.1MB')
  assert.equal(formatBytes(512 * 1024), '512.0KB')
  assert.equal(formatBytes(300), '300B')
})

test('单张压缩 + 格式变化：已自动压缩：name before → after（已转为 WebP）', () => {
  const batch = batchOf({
    items: [compressedItem('Screenshot.png', 12.3 * MB, 4.1 * MB)],
    images: 1, compressed: 1, totalBefore: 12.3 * MB, totalAfter: 4.1 * MB,
    changedTo: ['webp'],
  })
  const msg = buildNotification(summaryOf(batch, false), translate)
  assert.ok(msg, '必须生成通知')
  assert.equal(msg.kind, 'info')
  assert.equal(msg.text, '已自动压缩：Screenshot.png 12.3MB → 4.1MB（已转为 WebP）')
})

test('单张 JPEG 重编码：无格式变化、不加格式提示', () => {
  const batch = batchOf({
    items: [compressedItem('shot.jpg', 8 * MB, 3.2 * MB, false, 'image/jpeg')],
    images: 1, compressed: 1, totalBefore: 8 * MB, totalAfter: 3.2 * MB,
    changedTo: [],
  })
  const msg = buildNotification(summaryOf(batch, false), translate)
  assert.equal(msg.text, '已自动压缩：shot.jpg 8.0MB → 3.2MB')
})

test('多张合并：无格式变化时只有总数；混合格式变化提示 WebP/JPEG', () => {
  const batch = batchOf({
    items: [compressedItem('a.png', 6 * MB, 2 * MB), compressedItem('b.png', 9 * MB, 1 * MB)],
    images: 2, compressed: 2, totalBefore: 15 * MB, totalAfter: 3 * MB,
    changedTo: ['webp'],
  })
  const msg = buildNotification(summaryOf(batch, false), translate)
  assert.equal(msg.text, '已自动压缩 2 张图片（共 15.0MB → 3.0MB）（已转为 WebP）')

  // 混合格式（既有转 WebP 也有转 JPEG）→ 提示 WebP/JPEG
  const mixed = batchOf({
    ...batch,
    changedTo: ['webp', 'jpeg'],
    items: [compressedItem('a.png', 6 * MB, 2 * MB), compressedItem('b.png', 9 * MB, 1 * MB, false, 'image/jpeg')],
  })
  const mixedMsg = buildNotification(summaryOf(mixed, false), translate)
  assert.equal(mixedMsg.text, '已自动压缩 2 张图片（共 15.0MB → 3.0MB）（已转为 WebP/JPEG）')
})

test('部分失败：失败计数如实报告并转警示', () => {
  const failed = {
    file: new File([new Uint8Array(6 * MB)], 'broken.png', { type: 'image/png' }),
    originalName: 'broken.png', changed: false, originalBytes: 6 * MB, status: 'failed', overLimit: false, formatChanged: false,
  }
  const batch = batchOf({
    items: [compressedItem('ok.png', 6 * MB, 2 * MB), failed, compressedItem('ok2.png', 7 * MB, 1 * MB)],
    images: 3, compressed: 2, failed: 1, totalBefore: 19 * MB, totalAfter: 9 * MB,
  })
  const msg = buildNotification(summaryOf(batch, false), translate)
  assert.equal(msg.kind, 'warning')
  assert.equal(msg.text, '已压缩 2 张图片；1 张压缩失败，已按原图添加')
})

test('全部失败：仅报告失败张数', () => {
  const batch = batchOf({
    items: [{
      file: new File([], 'broken.png', { type: 'image/png' }),
      originalName: 'broken.png', changed: false, originalBytes: 0, status: 'failed', overLimit: false, formatChanged: false,
    }],
    images: 1, failed: 1,
  })
  const msg = buildNotification(summaryOf(batch, false), translate)
  assert.equal(msg.kind, 'warning')
  assert.equal(msg.text, '1 张图片压缩失败，已按原图添加')
})

test('单张尽力而为：overLimit 标记如实提示仍超限制', () => {
  const batch = batchOf({
    items: [compressedItem('photo.jpg', 12.3 * MB, 5.2 * MB, true, 'image/jpeg')],
    images: 1, compressed: 1, overLimit: 1, totalBefore: 12.3 * MB, totalAfter: 5.2 * MB,
    changedTo: [],
  })
  const msg = buildNotification(summaryOf(batch, false), translate)
  assert.equal(msg.kind, 'warning')
  assert.equal(msg.text, '已压缩：photo.jpg 12.3MB → 5.2MB（仍超出限制，建议更换图片）')
})

test('多张中存在 overLimit：尾部追加计数说明', () => {
  const batch = batchOf({
    items: [compressedItem('a.png', 6 * MB, 4 * MB, true), compressedItem('b.png', 7 * MB, 2 * MB)],
    images: 2, compressed: 2, overLimit: 1, totalBefore: 13 * MB, totalAfter: 6 * MB,
    changedTo: ['webp'],
  })
  const msg = buildNotification(summaryOf(batch, false), translate)
  assert.equal(msg.kind, 'warning')
  assert.equal(msg.text, '已自动压缩 2 张图片（共 13.0MB → 6.0MB）（已转为 WebP）；1 张仍超出限制')
})

test('粘贴路径：追加"剪贴板文本未随图片粘贴"', () => {
  const batch = batchOf({
    items: [compressedItem('clip.png', 6 * MB, 2 * MB)],
    images: 1, compressed: 1, totalBefore: 6 * MB, totalAfter: 2 * MB, changedTo: ['webp'],
  })
  const msg = buildNotification(summaryOf(batch, true), translate)
  assert.equal(msg.text, '已自动压缩：clip.png 6.0MB → 2.0MB（已转为 WebP）；剪贴板文本未随图片粘贴')
})

test('未接管（零压缩零失败）→ 不通知（AC-03 零介入）', () => {
  const msg = buildNotification(summaryOf(batchOf(), false), translate)
  assert.equal(msg, null)
})

test('summaryOf：单张取文件名与前后字节；多张 fileName 为 null', () => {
  const single = summaryOf(batchOf({
    items: [compressedItem('only.png', 6 * MB, 2 * MB)],
    images: 1, compressed: 1, totalBefore: 6 * MB, totalAfter: 2 * MB, changedTo: ['webp'],
  }), false)
  assert.equal(single.fileName, 'only.png')
  assert.equal(single.firstBefore, 6 * MB)
  assert.equal(single.firstAfter, 2 * MB)

  const multi = summaryOf(batchOf({
    items: [compressedItem('a.png', 6 * MB, 2 * MB), compressedItem('b.png', 9 * MB, 1 * MB)],
    images: 2, compressed: 2, totalBefore: 15 * MB, totalAfter: 3 * MB, changedTo: ['webp'],
  }), true)
  assert.equal(multi.fileName, null)
  assert.equal(multi.fromPaste, true)
})

test('队列：publish → 订阅通知 → 出队后清空；clear/reset 生效', () => {
  resetNotifyStore()
  assert.deepEqual(getNotifySnapshot(), [])

  const seen = []
  const unsubscribe = subscribeNotify(() => { seen.push(getNotifySnapshot().length) })
  publish({ text: '已自动压缩：a.png', kind: 'info' })
  publish({ text: '已自动压缩：b.png', kind: 'info' })
  assert.equal(getNotifySnapshot().length, 2)
  const [first] = getNotifySnapshot()
  assert.equal(first.text, '已自动压缩：a.png')
  assert.equal(first.kind, 'info')

  // 只出队第一条（onDone 语义）
  dismiss(first.seq)
  assert.equal(getNotifySnapshot().length, 1)
  assert.equal(getNotifySnapshot()[0].text, '已自动压缩：b.png')

  // 不存在的序号为空操作
  dismiss(999)
  assert.equal(getNotifySnapshot().length, 1)

  // 停止订阅后不再收到通知
  unsubscribe()
  publish({ text: 'c', kind: 'warning' })
  const before = seen.length
  publish({ text: 'd', kind: 'warning' })
  assert.equal(seen.length, before, '退订后不再回调')

  clearNotifyStore()
  assert.deepEqual(getNotifySnapshot(), [])
  resetNotifyStore()
  assert.deepEqual(getNotifySnapshot(), [])
})
