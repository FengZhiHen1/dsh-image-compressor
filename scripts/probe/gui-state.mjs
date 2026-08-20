/**
 * 阶段6 GUI 状态检查驱动：连接一个运行中的 DSH web 页面（默认 test profile
 * 的 URL），等应用就绪后评估一组只读表达式并打印结果。用于确认插件 bundle
 * 已挂载、会话/输入条存在，为后续实测探针做准备。用法：
 *   node scripts/probe/gui-state.mjs [url]
 *
 * 轮询 document.readyState / body 而非等待 loadEventFired（SPA/信任边界页
 * 可能长期不发 load）。
 */
import { existsSync } from 'node:fs'
import { launchChrome, connectCdp, evaluate, disposeBrowser } from './cdp.mjs'

const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].filter(Boolean)
const chromePath = chromeCandidates.find((candidate) => existsSync(candidate))
const url = process.argv[2] ?? 'http://127.0.0.1:50756/'

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

const { chrome, port, profileDir } = await launchChrome(chromePath)
let session
for (let i = 0; i < 150; i += 1) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`)
    const targets = await res.json()
    const page = targets.find((t) => t.type === 'page')
    if (page?.webSocketDebuggerUrl) {
      session = await connectCdp(page.webSocketDebuggerUrl)
      break
    }
  } catch { /* transient */ }
  await sleep(100)
}
if (session === undefined) {
  console.error('[gui-state] no page target')
  process.exit(2)
}
try {
  await session.send('Page.enable')
  await session.send('Runtime.enable')
  let navError
  try {
    await session.send('Page.navigate', { url })
  } catch (error) {
    navError = String(error?.message ?? error)
  }

  // 最多 60s 轮询：记录每次采样的 location/readyState/first 文本，直到出现应用标记。
  const samples = []
  let appMarked = false
  for (let i = 0; i < 60; i += 1) {
    await sleep(1000)
    try {
      const probe = await evaluate(session, `(() => ({
        href: location.href,
        ready: document.readyState,
        text: document.body ? document.body.innerText.slice(0, 160) : '',
        composer: !!document.querySelector('[data-composer-card]'),
        textarea: !!document.querySelector('textarea'),
        boot: typeof window.__DSH_BOOT__ !== 'undefined' ? 'yes' : 'no',
      }))()`)
      samples.push(probe)
      if (probe.composer || probe.textarea || /(欢迎|新对话|Workspace|开始|继续)/.test(probe.text)) {
        appMarked = true
        break
      }
    } catch (error) {
      samples.push({ error: String(error?.message ?? error) })
    }
  }
  const last = samples.at(-1)
  console.log(JSON.stringify({
    url,
    navError,
    appMarked,
    samples,
    deep: last === undefined ? null : await evaluate(session, `(() => {
      const q = (sel) => !!document.querySelector(sel)
      return {
        bodyTextHead: document.body.innerText.slice(0, 300),
        composer: q('[data-composer-card]'),
        inputDock: q('[data-dock]'),
        dialogs: q('[role=dialog]'),
        sessionRows: Math.max(0, document.querySelectorAll('[data-session]').length),
        buttons: [...document.querySelectorAll('button')].slice(0, 12).map(b => b.innerText || b.getAttribute('aria-label') || ''),
      }
    })()`),
  }, null, 2))
  await disposeBrowser({ chrome, profileDir })
} catch (error) {
  console.error(`[gui-state] fatal: ${error?.message ?? String(error)}`)
  await disposeBrowser({ chrome, profileDir })
  process.exit(1)
}
