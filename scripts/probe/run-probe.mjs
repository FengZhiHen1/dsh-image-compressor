/**
 * 阶段1 missing evidence 浏览器实测驱动。
 *
 * 用法：node scripts/probe/run-probe.mjs [probe.html 路径]
 * 走 CDP：启动 headless Chrome → 导航到探针页 → Runtime.evaluate 运行全部场景 →
 * 打印结果表；任一场景失败时以非零码退出（供自动化/CI 使用）。
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchChrome, connectCdp, navigate, evaluate, disposeBrowser } from './cdp.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean)

const chromePath = chromeCandidates.find((candidate) => existsSync(candidate))
if (chromePath === undefined) {
  console.error('[probe] no Chromium/Edge binary found; set CHROME_PATH')
  process.exit(2)
}

const probeArg = process.argv[2]
const probeFile = probeArg === undefined
  ? join(root, 'tmp-probe', 'probe.html')
  : resolve(probeArg)
if (!existsSync(probeFile)) {
  console.error(`[probe] probe page not found: ${probeFile}`)
  process.exit(2)
}
const fileUrl = 'file:///' + probeFile.replaceAll('\\', '/')

const { chrome, port, profileDir } = await launchChrome(chromePath)
const session = await connectCdp(await pageWebSocketUrlWithRetry(port))
try {
  await navigate(session, fileUrl)
  const { results } = await evaluate(session, 'window.__runProbe()')
  let failed = 0
  for (const item of results) {
    const flag = item.ok ? 'PASS' : 'FAIL'
    if (!item.ok) failed += 1
    console.log(`[${flag}] ${item.name}`)
    if (item.ok) console.log(`      ${item.detail}`)
    else console.log(`      ${item.detail}`)
  }
  console.log(`\n[probe] ${results.length - failed}/${results.length} passed`)
  await disposeBrowser({ chrome, profileDir })
  process.exit(failed === 0 ? 0 : 1)
} catch (error) {
  console.error(`[probe] fatal: ${error?.message ?? String(error)}`)
  await disposeBrowser({ chrome, profileDir })
  process.exit(1)
}

async function pageWebSocketUrlWithRetry(port) {
  // The cdp helper resolves the page ws url itself; keep a tiny local copy for
  // the runner so navigation stays self-contained.
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch { /* transient */ }
    await new Promise((resolve2) => { setTimeout(resolve2, 100) })
  }
  throw new Error(`No page target on port ${port}`)
}
