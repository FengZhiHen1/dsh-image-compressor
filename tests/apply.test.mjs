// 入口集成单测（阶段5）：apply 在假 ctx + global document 桩下正确挂载
// 捕获监听与座位、dispose 移除监听并清空通知队列（R-11 零残留）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadClient } from './helpers/load-client.mjs'

const { client } = await loadClient()
const { getNotifySnapshot, publish } = client

function makeFakeDocument() {
  const added = []
  const removed = []
  return {
    added,
    removed,
    addEventListener(type, fn, capture) { added.push({ type, capture }) },
    removeEventListener(type, fn, capture) { removed.push({ type, capture }) },
  }
}

const LIMITS = { maxImageBytes: 5 * 1024 * 1024, maxImagePixels: 40_000_000 }

function makeFakeCtx(doc) {
  const effects = []
  const injectedSlots = []
  return {
    effects,
    injectedSlots,
    effect(fn) {
      const disposer = typeof fn === 'function' ? fn() : undefined
      effects.push(disposer)
    },
    locale: {
      register(ns, dicts) {
        assert.equal(ns, 'image-compressor')
        assert.ok(dicts.zh && dicts.en)
        return () => {}
      },
      bind() {
        return (key, params = {}) =>
          String(key) + ':' + JSON.stringify(params)
      },
    },
    sessions: {
      list: { getSnapshot: () => ({ current: 's1' }) },
      binding: () => ({
        session: {
          getSnapshot: () => ({ running: false }),
          projections: { faceOf: () => ({ getSnapshot: () => LIMITS }) },
        },
      }),
    },
    slots: {
      inject(key, callback) {
        injectedSlots.push({ key, hasCallback: typeof callback === 'function' })
        // 不执行 callback：register 面由浏览器验证
      },
    },
  }
}

test('apply 挂载 drop/paste 捕获监听与 dock 座位；dispose 清理监听与队列', () => {
  const doc = makeFakeDocument()
  globalThis.document = doc
  const ctx = makeFakeCtx(doc)

  // 队列先污染一条，验证 apply 初始化清空
  publish({ text: 'stale', kind: 'info' })
  assert.equal(getNotifySnapshot().length, 1)

  client.apply(ctx)

  // 捕获监听
  assert.deepEqual(doc.added.map((e) => e.type), ['drop', 'paste'])
  assert.ok(doc.added.every((e) => e.capture === true), '必须是捕获阶段')

  // 座位注入
  assert.equal(ctx.injectedSlots.length, 1)
  assert.equal(ctx.injectedSlots[0].key, 'conversation.input.dock')
  assert.equal(ctx.injectedSlots[0].hasCallback, true)

  // 三个 effect：词典、intake+通知、以及 slots.inject 内部（未执行 callback，无 disposer）
  assert.equal(ctx.effects.length, 2, '词典 + intake/notify 两个 effect')
  const intakeDisposer = ctx.effects[1]
  assert.equal(typeof intakeDisposer, 'function')

  // dispose：移除全部 capture 监听并清空队列
  intakeDisposer()
  assert.deepEqual(doc.removed.map((e) => e.type), ['drop', 'paste'])
  assert.ok(doc.removed.every((e) => e.capture === true))
  assert.equal(getNotifySnapshot().length, 0, '队列在 dispose 后清空')

  delete globalThis.document
})
