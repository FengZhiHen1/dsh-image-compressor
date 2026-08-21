// dsh-image-compressor client bundle smoke test (阶段0): the wrapper mounts
// the bundle under the published package name and the client declares the
// required service faces.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadClient } from './helpers/load-client.mjs'

const { client, loadedPluginId, manifest, primitivesRequireCalls } = await loadClient()
const host = await import('../lib/index.js')

test('registers the client bundle under the published package name', () => {
  assert.equal(loadedPluginId, manifest.name)
})

test('host half registers the read_image tools/execute wrapper', () => {
  assert.equal(typeof host.apply, 'function')
  // host 面唯一副作用：向 ctx 注册一个 tools/execute around-dispatch 监听器。
  const registered = []
  const ctx = { on: (event, fn) => registered.push({ event, fn }) }
  assert.equal(host.apply(ctx), undefined)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].event, 'tools/execute')
  assert.equal(typeof registered[0].fn, 'function')
})

test('client inject list matches the pure-client service set', () => {
  assert.deepEqual(client.inject, ['sessions', 'slots', 'locale'])
})

test('client bundle resolves the platform primitives at load (Toast + icons)', () => {
  assert.ok(primitivesRequireCalls > 0, 'must require @deepseek-ai/dsh-client-ui-primitives')
})
