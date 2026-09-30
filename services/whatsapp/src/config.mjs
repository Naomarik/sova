// Configuration: environment over an optional $SOVA_WA_HOME/config.json, then defaults. Nothing user-specific.
import { existsSync, readFileSync, statSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Every key the sender reads, with its default (as a string, the way env carries it). */
export const KEYS = {
  SOVA_WA_HOME: null, // <PI_CODING_AGENT_DIR or ~/.pi/agent>/sova/whatsapp
  SOVA_WA_AUTH_DIR: null, // $SOVA_WA_HOME/auth
  SOVA_WA_SOCKET: null, // $SOVA_WA_HOME/sender.sock
  SOVA_WA_LIMITS: '3/20/60', // seconds between sends / sends per hour / sends per day
  SOVA_WA_RECONNECT_BUDGET: '3/10', // automatic reconnects per hour / per day
  SOVA_WA_SEND_WAIT_S: '15', // how long a send waits for the connection before not-connected
  SOVA_WA_DEVICE_NAME: 'Sova', // the name the phone shows under Linked devices
  SOVA_WA_LOG_LEVEL: 'warn', // warn | info | debug (never message bodies or numbers at any level)
}

// Linux caps a Unix socket path at 108 bytes, macOS at 104.
const SOCKET_PATH_MAX = 103

const expandHome = (p, home) => (p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p)

function parseSlash(name, raw, parts) {
  const nums = String(raw).split('/').map((s) => s.trim())
  if (nums.length !== parts.length || nums.some((s) => !/^\d+$/.test(s))) {
    throw new Error(`${name} must be ${parts.join('/')} as whole numbers, got "${raw}"`)
  }
  return Object.fromEntries(parts.map((p, i) => [p, Number(nums[i])]))
}

/** Reads $SOVA_WA_HOME/config.json strictly: an object of known keys with string or number values. */
export function readConfigFile(file) {
  if (!existsSync(file)) return {}
  let data
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err.message}`)
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${file} must hold a JSON object`)
  for (const [k, v] of Object.entries(data)) {
    if (!(k in KEYS) || k === 'SOVA_WA_HOME') throw new Error(`${file}: unknown key "${k}"`)
    if (typeof v !== 'string' && typeof v !== 'number') throw new Error(`${file}: "${k}" must be a string or number`)
  }
  return data
}

/**
 * Resolves the configuration. Throws on a malformed value; path problems are reported by problems().
 * `sources` says where each value came from: env, file or default.
 */
export function resolveConfig(env = process.env, { home = homedir() } = {}) {
  const agentDir = env.PI_CODING_AGENT_DIR ? expandHome(env.PI_CODING_AGENT_DIR, home) : join(home, '.pi/agent')
  const waHome = resolve(env.SOVA_WA_HOME ? expandHome(env.SOVA_WA_HOME, home) : join(agentDir, 'sova/whatsapp'))
  const configFile = join(waHome, 'config.json')
  const file = readConfigFile(configFile)
  const sources = { SOVA_WA_HOME: env.SOVA_WA_HOME ? 'env' : 'default' }
  const pick = (k) => {
    if (env[k] != null && env[k] !== '') return (sources[k] = 'env'), String(env[k])
    if (file[k] != null) return (sources[k] = 'file'), String(file[k])
    return (sources[k] = 'default'), KEYS[k]
  }
  const authDir = resolve(expandHome(pick('SOVA_WA_AUTH_DIR') ?? join(waHome, 'auth'), home))
  const socket = resolve(expandHome(pick('SOVA_WA_SOCKET') ?? join(waHome, 'sender.sock'), home))
  const limits = parseSlash('SOVA_WA_LIMITS', pick('SOVA_WA_LIMITS'), ['gapS', 'perHour', 'perDay'])
  const reconnectBudget = parseSlash('SOVA_WA_RECONNECT_BUDGET', pick('SOVA_WA_RECONNECT_BUDGET'), ['perHour', 'perDay'])
  const sendWaitRaw = pick('SOVA_WA_SEND_WAIT_S')
  if (!/^\d+$/.test(sendWaitRaw)) throw new Error(`SOVA_WA_SEND_WAIT_S must be whole seconds, got "${sendWaitRaw}"`)
  const deviceName = pick('SOVA_WA_DEVICE_NAME').trim()
  if (!deviceName || deviceName.length > 40) throw new Error('SOVA_WA_DEVICE_NAME must be 1 to 40 characters')
  const logLevel = pick('SOVA_WA_LOG_LEVEL')
  if (!['warn', 'info', 'debug'].includes(logLevel)) throw new Error(`SOVA_WA_LOG_LEVEL must be warn, info or debug, got "${logLevel}"`)
  return {
    home: waHome,
    configFile,
    authDir,
    socket,
    lockFile: join(waHome, 'sender.lock'),
    stateFile: join(waHome, 'state.json'),
    eventsFile: join(waHome, 'events.json'),
    limits,
    reconnectBudget,
    sendWaitS: Number(sendWaitRaw),
    deviceName,
    logLevel,
    sources,
  }
}

/** The git work tree containing `path` (or its nearest existing parent), or null. */
export function gitWorkTreeOf(path) {
  let dir = path
  while (!existsSync(dir)) {
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
  try {
    dir = realpathSync(dir)
  } catch {}
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

/** A directory that exists and is readable or writable by group or others. */
function openMode(path) {
  if (!existsSync(path)) return null
  const mode = statSync(path).mode & 0o777
  return mode & 0o077 ? mode : null
}

/** Why the sender must not start with this configuration: [] when it may. */
export function problems(config) {
  const out = []
  for (const [name, path] of [
    ['SOVA_WA_HOME', config.home],
    ['SOVA_WA_AUTH_DIR', config.authDir],
  ]) {
    const mode = openMode(path)
    if (mode != null) out.push(`${name} ${path} is group/world-accessible (mode ${mode.toString(8).padStart(4, '0')}): run chmod 700 on it`)
    const tree = gitWorkTreeOf(path)
    if (tree) out.push(`${name} ${path} is inside the git work tree ${tree}: credentials must live outside any repository`)
  }
  if (Buffer.byteLength(config.socket) > SOCKET_PATH_MAX) {
    out.push(`SOVA_WA_SOCKET ${config.socket} is longer than ${SOCKET_PATH_MAX} bytes, too long for a Unix socket: set a shorter path`)
  }
  return out
}
