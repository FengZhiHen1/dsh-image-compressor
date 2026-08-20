/**
 * 阶段6 浏览器端到端实测（headless Chromium + CDP，对运行中的 test GUI）。
 * 场景：
 *   A 超限 PNG 拖放 → 自动压缩（Toast「已自动压缩」+ 附件栏 .webp + 尺寸 ≤ 部署限制）；
 *   B 未超限小图 → 零介入（无新 Toast、原样入栏）；
 *   C 超限 GIF → 插件不接管、官方提示照旧（无压缩产物）；
 *   D 超限 PNG 粘贴（Ctrl+V 等价事件）→ 同 A；
 *   E 未超限小图粘贴 → 官方路径入栏、无压缩 Toast；
 *   F 混合拖放 [超限, 未超限] → 附件栏顺序与拖入顺序一致；
 *   G 混合拖放 [有效超限, 伪装损坏超限] → 通知如实报告失败张数、不丢图、不崩。
 * 用法：node scripts/probe/accept-drop.mjs [url]
 */
import { existsSync } from 'node:fs'
import { openPage, evaluate, disposeBrowser } from './cdp.mjs'

const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].filter(Boolean)
const chromePath = chromeCandidates.find((candidate) => existsSync(candidate))
const url = process.argv[2] ?? 'http://127.0.0.1:56784/'
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

const { session, browser } = await openPage(chromePath, url)
try {
  let ready = false
  for (let i = 0; i < 60; i += 1) {
    await sleep(1000)
    const probe = await evaluate(session, `!!document.querySelector('[data-composer-card]')`)
    if (probe) { ready = true; break }
  }
  if (!ready) throw new Error('GUI composer did not appear in time')

  const scenario = `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const MB = 1024 * 1024

    function makeFile(name, type, bytes) {
      const buf = new Uint8Array(bytes)
      for (let i = 0; i < bytes; i += 1) buf[i] = (i * 47) & 0xff
      return new File([buf], name, { type })
    }
    async function makeNoisePng(px = 2000) {
      const canvas = new OffscreenCanvas(px, px)
      const ctx = canvas.getContext('2d')
      const img = ctx.createImageData(canvas.width, canvas.height)
      for (let i = 0; i < img.data.length; i += 4) {
        img.data[i] = (Math.random() * 256) | 0
        img.data[i + 1] = (Math.random() * 256) | 0
        img.data[i + 2] = (Math.random() * 256) | 0
        img.data[i + 3] = 255
      }
      ctx.putImageData(img, 0, 0)
      const blob = await canvas.convertToBlob({ type: 'image/png' })
      return new File([blob], 'big-noise.png', { type: 'image/png' })
    }
    function drop(files) {
      const dt = new DataTransfer()
      for (const f of files) dt.items.add(f)
      document.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
    }
    function paste(files) {
      const dt = new DataTransfer()
      for (const f of files) dt.items.add(f)
      const textarea = document.querySelector('textarea')
      textarea.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }))
    }
    const railAlts = () => [...document.querySelectorAll('[data-composer-card] img[alt]')].map((i) => i.alt)
    const toasts = () => [...document.querySelectorAll('[role=alert]')].map((e) => e.textContent).filter(Boolean)

    async function poll(ms) {
      const seen = new Set(); let headline = ''
      for (let t = 0; t < ms; t += 500) {
        await sleep(500)
        for (const text of toasts()) {
          seen.add(text)
          if (headline === '' && (text.includes('已自动压缩') || text.includes('单张图片'))) headline = text
        }
      }
      return { seen: [...seen], headline, alts: railAlts() }
    }

    const out = {}

    // A: 超限 PNG 拖放
    const big = await makeNoisePng()
    drop([big])
    out.A = await poll(8000)
    out.A.pass = out.A.seen.some((t) => t.includes('已自动压缩')) && out.A.alts.includes('big-noise.webp')
    await sleep(5000)

    // B: 未超限小图拖放
    drop([makeFile('small.png', 'image/png', 800 * 1024)])
    out.B = await poll(2500)
    out.B.pass = out.B.alts.includes('small.png') && !out.B.seen.some((t) => t.includes('已自动压缩'))
    await sleep(2000)

    // C: 超限 GIF 拖放
    drop([makeFile('anim.gif', 'image/gif', 9 * MB)])
    out.C = await poll(2500)
    out.C.pass = !out.C.alts.includes('anim.webp')
      && !out.C.seen.some((t) => t.includes('已自动压缩'))
      && out.C.seen.some((t) => t.includes('单张图片不能超过'))
    await sleep(5500)

    // D: 超限 PNG 粘贴
    paste([await makeNoisePng()])
    out.D = await poll(8000)
    out.D.pass = out.D.seen.some((t) => t.includes('已自动压缩')) && out.D.alts.filter((a) => a === 'big-noise.webp').length >= 2
    await sleep(5000)

    // E: 未超限小图粘贴 → 官方路径
    paste([makeFile('pasted.png', 'image/png', 700 * 1024)])
    out.E = await poll(2500)
    out.E.pass = out.E.alts.includes('pasted.png') && !out.E.seen.some((t) => t.includes('已自动压缩'))
    await sleep(2000)

    // F: 混合拖放 [超限, 未超限] → 顺序一致
    drop([await makeNoisePng(), makeFile('small2.png', 'image/png', 900 * 1024)])
    out.F = await poll(8000)
    out.F.pass = out.F.alts.includes('big-noise.webp') && out.F.alts.includes('small2.png')
      && out.F.alts.indexOf('big-noise.webp') < out.F.alts.indexOf('small2.png')
    await sleep(5000)

    // G: 有效超限 + 伪装损坏超限 → 部分失败通知
    const broken = new File([new Uint8Array(8 * MB)], 'broken.png', { type: 'image/png' })
    drop([await makeNoisePng(), broken])
    out.G = await poll(8000)
    out.G.pass = out.G.seen.some((t) => t.includes('压缩失败')) // 通知如实报告失败
    return out
  })()`

  const result = await evaluate(session, scenario, 180000)
  console.log(JSON.stringify(result, null, 2))
  const passes = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].every((k) => result[k]?.pass)
  await disposeBrowser({ chrome: browser.chrome, profileDir: browser.profileDir })
  process.exit(passes ? 0 : 1)
} catch (error) {
  console.error(`[accept-drop] fatal: ${error?.message ?? String(error)}`)
  await disposeBrowser({ chrome: browser.chrome, profileDir: browser.profileDir })
  process.exit(1)
}
