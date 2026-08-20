/**
 * AC-10 卸载验证（基线）：test profile 移除 dsh-image-compressor 后，
 * 拖入超限图应只出现官方 Toast（单张图片不能超过 NMB）、附件栏无压缩产物
 * （无 .webp 后缀、无「已自动压缩」文案）。
 * 用法：node scripts/probe/baseline-drop.mjs [url]
 */
import { existsSync } from 'node:fs'
import { openPage, evaluate, disposeBrowser } from './cdp.mjs'

const chromePath = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((c) => existsSync(c))
const url = process.argv[2] ?? 'http://127.0.0.1:62892/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { session, browser } = await openPage(chromePath, url)
try {
  let ready = false
  for (let i = 0; i < 60; i += 1) {
    await sleep(1000)
    if (await evaluate(session, `!!document.querySelector('[data-composer-card]')`, 10000)) { ready = true; break }
  }
  if (!ready) throw new Error('GUI composer not ready')

  const result = await evaluate(session, `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    async function makeNoisePng() {
      const c = new OffscreenCanvas(2000, 2000)
      const ctx = c.getContext('2d')
      const img = ctx.createImageData(c.width, c.height)
      for (let i = 0; i < img.data.length; i += 4) { img.data[i] = (Math.random()*256)|0; img.data[i+1]=(Math.random()*256)|0; img.data[i+2]=(Math.random()*256)|0; img.data[i+3]=255 }
      ctx.putImageData(img, 0, 0)
      const blob = await c.convertToBlob({ type: 'image/png' })
      return new File([blob], 'big-noise.png', { type: 'image/png' })
    }
    const dt = new DataTransfer()
    dt.items.add(await makeNoisePng())
    document.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
    const seen = new Set()
    for (let t = 0; t < 8000; t += 500) {
      await sleep(500)
      for (const el of document.querySelectorAll('[role=alert]')) seen.add(el.textContent)
    }
    const alts = [...document.querySelectorAll('[data-composer-card] img[alt]')].map((i) => i.alt)
    return {
      toasts: [...seen],
      alts,
      noCompressionTrace: ![...seen].some((t) => t.includes('已自动压缩')) && !alts.some((a) => a.endsWith('.webp')),
      pass: [...seen].some((t) => t.includes('单张图片不能超过')) && ![...seen].some((t) => t.includes('已自动压缩')) && alts.length === 0,
    }
  })()`, 120000)
  console.log(JSON.stringify(result, null, 2))
  await disposeBrowser({ chrome: browser.chrome, profileDir: browser.profileDir })
  process.exit(result?.pass ? 0 : 1)
} catch (error) {
  console.error(`[baseline-drop] fatal: ${error?.message ?? String(error)}`)
  await disposeBrowser({ chrome: browser.chrome, profileDir: browser.profileDir })
  process.exit(1)
}
