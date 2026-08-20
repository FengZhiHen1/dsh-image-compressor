/**
 * Shared harness: load `lib/client.js` in Node through a stubbed module
 * loader (mirrors dsh-openpencil-lite's client.test.mjs) and return the
 * bundle surface. Every value import into DSH client primitives is stubbed;
 * `react`/`react-dom`/`react/jsx-runtime` resolve against the package's own
 * node_modules.
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export async function loadClient() {
  const manifest = require('../../package.json')
  let client
  let loadedPluginId
  let primitivesRequireCalls = 0
  const stubRequire = (id) => {
    if (id === '@deepseek-ai/dsh-client-ui-primitives') {
      primitivesRequireCalls += 1
      return {
        Toast: () => null,
        IconCheckOutline16: () => null,
        IconWarningOutline16: () => null,
      }
    }
    return require(id)
  }
  // `lib/client.js` mounts itself through the loader. Any module in the bundle
  // that reads `document`/`window` at import time would fail here — every
  // module must touch browser globals only inside its functions.
  globalThis.window = {
    location: { href: 'http://127.0.0.1:3080/' },
    __ModuleLoader__: {
      load(definition) {
        loadedPluginId = definition.id
        client = definition.factory(stubRequire)
      },
    },
  }
  await import(`../../lib/client.js?test=${Date.now()}`)
  return { client, manifest, loadedPluginId, primitivesRequireCalls }
}
