import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [tool, ...args] = process.argv.slice(2)
if (tool !== 'tsc' && tool !== 'tsdown') {
  throw new Error(`run-tool: unsupported tool ${JSON.stringify(tool)}`)
}

const candidates = [
  join(root, 'node_modules', '.bin', tool),
]
const typeRoots = [join(root, 'node_modules', '@types')]

const explicitSource = process.env.DSH_SOURCE_ROOT?.trim()
if (explicitSource) candidates.push(join(explicitSource, 'node_modules', '.bin', tool))
if (explicitSource) typeRoots.push(join(explicitSource, 'node_modules', '@types'))

// A linked DSH peer package gives us the active source checkout without a
// machine-specific path. Walk upward until its workspace-level .bin appears.
const peer = join(root, 'node_modules', '@deepseek-ai', 'dsh-tools')
if (existsSync(peer)) {
  let current = realpathSync(peer)
  for (;;) {
    candidates.push(join(current, 'node_modules', '.bin', tool))
    typeRoots.push(join(current, 'node_modules', '@types'))
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
}

// Installed DSH source bundles are another supported build environment.
const sourceStore = join(homedir(), '.dsh', 'source')
if (existsSync(sourceStore)) {
  const sources = readdirSync(sourceStore)
    .map(name => join(sourceStore, name))
    .filter(path => statSync(path).isDirectory())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  for (const source of sources) {
    candidates.push(join(source, 'node_modules', '.bin', tool))
    typeRoots.push(join(source, 'node_modules', '@types'))
  }
}

// On Windows, pnpm's `.bin` entries are shell shims without an executable
// extension; Node's spawnSync cannot run them directly, so resolve to the
// `.cmd` twin when one exists.
const selectBinary = (candidate) => {
  if (process.platform === 'win32' && !candidate.toLowerCase().endsWith('.cmd')) {
    const cmdTwin = `${candidate}.cmd`
    if (existsSync(cmdTwin)) return cmdTwin
  }
  return candidate
}

const binary = candidates.find(candidate => existsSync(candidate))
if (binary === undefined) {
  throw new Error(`run-tool: ${tool} is unavailable; install dev dependencies or set DSH_SOURCE_ROOT`)
}
const executable = selectBinary(binary)
const discoveredTypeRoots = [...new Set(typeRoots.filter(path => existsSync(path)))]
const forwardedArgs = [...args]
if (tool === 'tsc' && discoveredTypeRoots.length > 0) {
  forwardedArgs.push('--typeRoots', discoveredTypeRoots.join(','))
}
const env = {
  ...process.env,
}
// Invoke through cmd.exe on Windows: Node can spawn real `.exe` files
// directly, but pnpm's `.cmd` shims (and the isolated consoles used by
// sandboxed shells) return EINVAL from a raw spawnSync. `cmd /d /s /c`
// is the reliable path for batch shims.
const invokeArgs =
  process.platform === 'win32'
    ? ['/d', '/s', '/c', executable, ...forwardedArgs]
    : forwardedArgs
const result = spawnSync(
  process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : executable,
  invokeArgs,
  { cwd: root, env, stdio: 'inherit' },
)
if (result.error) throw result.error
process.exitCode = result.status ?? 1
