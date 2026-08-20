/**
 * Minimal Chrome DevTools Protocol driver over Node's built-in WebSocket.
 * Used only by the phase-1 missing-evidence browser probes (and later
 * phase-6 acceptance checks) — never ships in the plugin bundle.
 *
 * Launch one headless Chrome (remote debugging on an ephemeral port),
 * connect to its about:blank page target, navigate to a file:// probe page,
 * and evaluate async expressions with full awaitPromise + returnByValue.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/**
 * @returns {Promise<{ chrome: import('node:child_process').ChildProcess; port: number; profileDir: string }>}
 */
export async function launchChrome(chromePath) {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-probe-'))
  const chrome = spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--window-size=1280,900',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  chrome.stderr.on('data', () => { /* keep pipes drained */ })

  const portFile = join(profileDir, 'DevToolsActivePort')
  let port = -1
  for (let i = 0; i < 200 && port < 0; i += 1) {
    await sleep(100)
    try {
      if (existsSync(portFile)) {
        const head = readFileSync(portFile, 'utf8').split(/\r?\n/)[0].trim()
        const parsed = Number.parseInt(head, 10)
        if (Number.isFinite(parsed) && parsed > 0) port = parsed
      }
    } catch { /* retry */ }
  }
  if (port < 0) {
    chrome.kill()
    throw new Error('Chrome did not expose a remote-debugging port')
  }
  return { chrome, port, profileDir }
}

/** Resolve the first page target's WebSocket URL. */
async function pageWebSocketUrl(port) {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch { /* transient */ }
    await sleep(100)
  }
  throw new Error(`No page target on port ${port}`)
}

/** Open a CDP session over the given WebSocket URL. */
export function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let nextId = 1
    const pending = new Map()
    const eventListeners = new Map()
    ws.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = nextId++
            pending.set(id, { res, rej })
            ws.send(JSON.stringify({ id, method, params }))
          })
        },
        on(method, fn) {
          if (!eventListeners.has(method)) eventListeners.set(method, [])
          eventListeners.get(method).push(fn)
        },
        close() {
          try { ws.close() } catch { /* ignore */ }
        },
      })
    })
    ws.addEventListener('message', (event) => {
      let msg
      try { msg = JSON.parse(event.data) } catch { return }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) rej(new Error(`${msg.error.message} (${msg.error.code})`))
        else res(msg.result)
        return
      }
      if (msg.method) {
        for (const fn of eventListeners.get(msg.method) ?? []) fn(msg.params)
      }
    })
    ws.addEventListener('error', (err) => { reject(new Error(`CDP WebSocket error: ${String(err)}`)) })
  })
}

/** Navigate the page target to a file URL and wait for the load event. */
export async function navigate(session, fileUrl) {
  const loaded = new Promise((resolve) => { session.on('Page.loadEventFired', resolve) })
  await session.send('Page.enable')
  await session.send('Runtime.enable')
  await session.send('Page.navigate', { url: fileUrl })
  const raced = await Promise.race([
    loaded,
    sleep(60000).then(() => { throw new Error('Page load timed out') }),
  ]).catch((err) => { throw err })
  return raced
}

/** Evaluate an expression, awaiting promises and returning by value. */
export async function evaluate(session, expression, timeoutMs = 120000) {
  const response = await Promise.race([
    session.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }),
    (async () => {
      await sleep(timeoutMs)
      throw new Error(`Runtime.evaluate timed out after ${timeoutMs}ms`)
    })(),
  ])
  if (response.exceptionDetails) {
    const description = response.exceptionDetails.exception?.description
      ?? response.exceptionDetails.text
      ?? 'unknown exception'
    throw new Error(typeof description === 'string' ? description : String(description))
  }
  return response.result?.value
}

export async function disposeBrowser({ chrome, profileDir }) {
  try { chrome.kill() } catch { /* ignore */ }
  for (let i = 0; i < 50; i += 1) {
    if (chrome.exitCode !== null) break
    await sleep(50)
  }
  try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* keep temp on failure */ }
}

const sleep2 = sleep

/**
 * 一键打开页面的组合助手：启动 Chrome → 连接到 about:blank 页 target →
 * 导航到 url（轮询而非等 load 事件）。返回 { session, browser, url }。
 * 调用方负责 disposeBrowser(browser)。
 */
export async function openPage(chromePath, url) {
  const browser = await launchChrome(chromePath)
  let session
  for (let i = 0; i < 150; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${browser.port}/json/list`)
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
    await disposeBrowser(browser)
    throw new Error('no page target')
  }
  await session.send('Page.enable')
  await session.send('Runtime.enable')
  await session.send('Page.navigate', { url })
  return { session, browser, url }
}
