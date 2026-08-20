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

test('host half is a loader-importable empty plugin (dual-face package)', () => {
  assert.equal(typeof host.apply, 'function')
  // host 面无任何副作用：apply 直接返回。
  assert.equal(host.apply(), undefined)
})

test('client inject list matches the pure-client service set', () => {
  assert.deepEqual(client.inject, ['sessions', 'slots', 'locale'])
})

test('client bundle resolves the platform primitives at load (Toast + icons)', () => {
  assert.ok(primitivesRequireCalls > 0, 'must require @deepseek-ai/dsh-client-ui-primitives')
})
