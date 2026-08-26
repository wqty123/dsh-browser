/**
 * Self-hosted Electron browser host (parent side): an
 * {@link ElectronBrowserViewHost} implementation that spawns the plugin's own
 * Electron child process (host-main.js) and drives it over line-delimited
 * JSON-RPC on a loopback TCP socket. This is what makes the plugin work on
 * surfaces without a desktop shell's electronViewHost (plain dsh web):
 * installing the plugin is enough — the browser window appears on first use.
 *
 * Protocol (one JSON object per line, both directions):
 *   -> { id, op: 'createView' } | { id, op: 'destroyView', viewId } |
 *      { id, op: 'showView', viewId } | { id, op: 'command', viewId, method, params }
 *   <- { id, op: 'hello', token } (the child's FIRST message — authenticates it)
 *   <- { id, ok: true, result? } | { id, ok: false, err }
 *
 * The child is Electron's main process; host-main.js owns the BrowserWindow,
 * WebContentsViews, and webContents.debugger (CDP).
 *
 * Security: the RPC server accepts exactly ONE connection, and only after
 * that connection proves knowledge of the random per-spawn token (passed to
 * the child via its stdin (first line, never in argv). A local process that
 * connects to the loopback port without the token can neither impersonate the
 * child nor inject replies — it is disconnected immediately. Commands are
 * only written after the hello authenticates, so a spoofed socket never
 * sees traffic.
 * @module dsh-browser/browser-electron/remote-host
 */

import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createServer, type Server, type Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import type { BrowserUserAction, ElectronBrowserViewHost, ElectronViewHandle, ScreenshotOptions } from './provider.js'
import type { ExportedCookie } from '../browser/types.js'

/** How long to wait for the child to signal readiness before failing. */
const READY_TIMEOUT_MS = 20_000

/** Safety cap on a single RPC reply line (base64 downloads are the big ones). */
const MAX_RPC_BUFFER_BYTES = 512 * 1024 * 1024

/**
 * Locate the Electron binary:
 *   0. the current process IS Electron (DSH Desktop hosts load this plugin
 *      inside their own Electron main process) — reuse the host binary, so
 *      the plugin works out of the box without `add electron`;
 *   1. require('electron') from this module (bundled dependency — the
 *      electron package ships with the plugin),
 *   2. ELECTRON_PATH (explicit override),
 *   3. every DSH install anchor + pnpm virtual store candidate, choosing the
 *      NEWEST version found. Older Electron releases (e.g. 33.x) have a
 *      compositor defect that intermittently breaks page capture, so prefer
 *      the newest binary available in the environment,
 *   4. last resort: the process ancestry, for hosts that run this plugin in a
 *      child Node process of their own Electron main process (DSH Desktop).
 * @returns the path to the Electron executable.
 */
function resolveElectronPath(): string {
  const require = createRequire(import.meta.url)
  // 0. The current process IS Electron: reuse the host binary. It cannot be
  //    missing because we are running on it.
  if (typeof process.versions.electron === 'string') {
    const exe = process.execPath
    if (typeof exe === 'string' && exe.length > 0 && existsSync(exe)) return exe
  }
  // 1. Bundled dependency — but ONLY when its binary is already on disk.
  //    Electron 44+ downloads the binary lazily on the first require()
  //    (it has no postinstall anymore), so probing here must never trigger a
  //    synchronous network download: available() would block DSH startup for
  //    the download (or fail outright offline), surfacing as a broken plugin.
  //    The download still happens on the first real spawn; this guard only
  //    keeps the probe side-effect free.
  try {
    const entry: unknown = require.resolve('electron')
    if (typeof entry === 'string' && entry.length > 0) {
      const pkgRoot = dirname(entry)
      const binaryReady =
        existsSync(join(pkgRoot, 'path.txt'))
        || existsSync(join(pkgRoot, 'dist', 'electron.exe'))
        || existsSync(join(pkgRoot, 'dist', 'electron'))
      if (binaryReady) {
        const resolved: unknown = require('electron')
        if (typeof resolved === 'string' && resolved.length > 0) return resolved
      }
    }
  } catch {
    // continue probing
  }
  // 2. Explicit override (user intent wins).
  const override = process.env.ELECTRON_PATH
  if (typeof override === 'string' && override.length > 0 && existsSync(override)) return override
  // 3. Collect every candidate (anchors + pnpm stores), then pick the newest.
  const candidates: Array<{ version: string; path: string }> = []
  const add = (version: string, path: string | undefined): void => {
    if (path !== undefined) candidates.push({ version, path })
  }
  const anchors: string[] = []
  const globalPrefix = process.env.npm_config_prefix ?? process.env.PREFIX
  if (globalPrefix !== undefined) {
    anchors.push(join(globalPrefix, 'node_modules'))
    anchors.push(join(globalPrefix, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'))
  }
  if (process.env.DSH_HOME !== undefined) {
    anchors.push(join(process.env.DSH_HOME, 'profiles', 'node_modules'))
  }
  for (const anchor of anchors) {
    try {
      const resolved: unknown = require.resolve('electron', { paths: [anchor] })
      if (typeof resolved === 'string' && resolved.length > 0) {
        add(versionOf(resolved), electronExeBeside(resolved))
      }
    } catch {
      // continue probing
    }
  }
  // Scan ONLY the plugin's own install tree (plus the explicit DSH anchors
  // above). Never cwd or the executable's directory: those can sit inside an
  // unrelated project whose node_modules may hold a different electron, and
  // executing the newest random binary in the filesystem is a supply-chain
  // hazard with no benefit.
  const roots = new Set<string>([
    fileURLToPath(new URL('.', import.meta.url)),
  ])
  for (const root of roots) {
    let dir = root
    for (let depth = 0; depth < 8; depth++) {
      const store = join(dir, 'node_modules', '.pnpm')
      if (existsSync(store)) {
        for (const entry of readdirSync(store)) {
          if (!entry.startsWith('electron@')) continue
          const exe = electronDistExe(join(store, entry, 'node_modules', 'electron'))
          add(entry.slice('electron@'.length), exe)
        }
      }
      const parent = join(dir, '..')
      if (parent === dir) break
      dir = parent
    }
  }
  // 4. Last resort for Electron hosts. DSH Desktop may run the agent runtime
  //    (and thus this plugin) in a plain Node child of its Electron main
  //    process — step 0 does not fire there, and there is no electron package
  //    anywhere to find. The host's own binary IS an Electron runtime and is
  //    guaranteed present (it is running us), so walk the process ancestry
  //    and reuse the first Electron executable found. Zero extra install;
  //    this is what makes the plugin work on DSH Desktop without `add
  //    electron`, no matter how the host loads plugins.
  const hostExe = hostElectronViaProcessTree()
  if (hostExe !== undefined) return hostExe
  throw new Error(
    'dsh-builtin-browser: cannot locate the Electron binary. Options: (1) if you are on DSH Desktop, ' +
    'this should never appear — the plugin reuses the host Electron automatically; (2) the electron ' +
    'package ships with the plugin, so on newer installs nothing is needed here — on installs from ' +
    'before that change, add it to the active profile (`dsh plugin --profile <your-profile> add electron`; ' +
    'on DSH Desktop the profile is `desktop`); (3) set ELECTRON_PATH to the electron executable. Note: ' +
    'Electron 44+ downloads its binary on first use, so if the package is installed but the binary is ' +
    'missing, run `npx install-electron` once (needs network) and retry.',
  )
}

/**
 * Last-resort Electron discovery: walk this process's ancestry looking for a
 * parent process whose executable is itself an Electron binary. Covers hosts
 * that run the plugin in a child Node process of their own Electron main
 * process (e.g. DSH Desktop): the host binary is already on disk and running,
 * so reusing it needs no extra install. Filesystem-only on POSIX (/proc); on
 * Windows a best-effort PowerShell CIM query is used — this path only runs
 * when every other lookup failed, so its latency never touches the happy
 * path, and a missing/blocked powershell simply yields nothing.
 */
function hostElectronViaProcessTree(): string | undefined {
  let pid: number | undefined = process.ppid
  for (let depth = 0; depth < 6 && pid !== undefined && pid > 1; depth++) {
    const exe = processExecutable(pid)
    if (exe !== undefined && isElectronBinary(exe)) return exe
    pid = processParent(pid)
  }
  return undefined
}

/** The executable path of a running process, or undefined when unknown. */
function processExecutable(pid: number): string | undefined {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ExecutablePath`,
      ], { encoding: 'utf8', windowsHide: true, timeout: 3000 })
      const line = out.trim().split(/\r?\n/)[0] ?? ''
      return line.length > 0 ? line : undefined
    }
    const exe = readlinkSync(`/proc/${pid}/exe`)
    return exe.length > 0 ? exe : undefined
  } catch {
    return undefined
  }
}

/** The parent pid of a running process, or undefined when unknown. */
function processParent(pid: number): number | undefined {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`,
      ], { encoding: 'utf8', windowsHide: true, timeout: 3000 })
      const n = Number(out.trim().split(/\r?\n/)[0])
      return Number.isInteger(n) && n > 1 ? n : undefined
    }
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // Format: pid (comm) state ppid ... — comm is parenthesized and may
    // itself contain spaces/parens, so parse from the LAST ')'; ppid is the
    // second field after it.
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)
    const n = Number(fields[1])
    return Number.isInteger(n) && n > 1 ? n : undefined
  } catch {
    return undefined
  }
}

/**
 * True when the given executable is an Electron binary. The name match
 * covers dev binaries (electron, electron.exe); the resources marker covers
 * packaged apps whose exe carries the product name (e.g. "DSH Desktop.exe") —
 * every Electron distribution ships `resources/electron.asar`,
 * `resources/app.asar`, or `resources/default_app.asar` beside the binary.
 */
function isElectronBinary(exe: string): boolean {
  if (basename(exe).toLowerCase().includes('electron')) return true
  const resources = join(dirname(exe), 'resources')
  return existsSync(join(resources, 'electron.asar'))
    || existsSync(join(resources, 'app.asar'))
    || existsSync(join(resources, 'default_app.asar'))
}

/** Extract an electron version like "43.4.0" from a path containing it. */
function versionOf(path: string): string {
  const match = /electron@(\d+\.\d+\.\d+)/.exec(path)
  return match?.[1] ?? '0.0.0'
}

/** Compare dotted numeric versions; higher wins. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => Number(n) || 0)
  const pb = b.split('.').map(n => Number(n) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** From an electron package entry file, find the dist executable beside it. */
function electronExeBeside(entry: string): string | undefined {
  const candidates = [
    join(dirname(entry), 'dist', 'electron.exe'),
    join(dirname(entry), 'dist', 'electron'),
    join(dirname(entry), '..', 'dist', 'electron.exe'),
    join(dirname(entry), '..', 'dist', 'electron'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** From an electron package root, find its dist executable. */
function electronDistExe(pkgRoot: string): string | undefined {
  for (const candidate of [join(pkgRoot, 'dist', 'electron.exe'), join(pkgRoot, 'dist', 'electron')]) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** One RPC round-trip with the child. */
interface Pending {
  resolve(result: unknown): void
  reject(err: Error): void
}

/**
 * Line-delimited JSON-RPC client over a local TCP socket. Electron's main
 * process on Windows does not receive piped stdin, so the parent listens on a
 * loopback port and passes it to the child via `--rpc-port`; the child
 * connects back and speaks the same one-JSON-per-line protocol.
 */
class ElectronChildClient {
  private readonly child: import('node:child_process').ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private buffer = ''
  private socket: import('node:net').Socket | undefined
  private connected = false
  private outbox: string[] = []
  /** Set once the child has exited; further calls fail fast instead of queueing. */
  private dead = false
  /**
   * True until the first message proves the child knows the spawn token.
   * Commands are queued (not written) until then, so a spoofed socket never
   * sees any traffic.
   */
  private awaitingHello = true
  private helloTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly hostMainPath: string,
    private readonly port: number,
    private readonly token: string,
    private readonly onExit?: () => void,
    private readonly onUserAction?: (action: BrowserUserAction) => void,
  ) {
    const electron = resolveElectronPath()
    process.stderr.write(`[dsh-browser host] spawning electron: ${electron}\n`)
    // ELECTRON_RUN_AS_NODE (even an empty string) makes Electron run as plain
    // Node, breaking require('electron'); NODE_OPTIONS can inject flags that
    // break the child. Rebuild the env without either.
    const env: Record<string, string | undefined> = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.NODE_OPTIONS
    // Windows GUI-subsystem processes (Electron included) never receive piped
    // stdin, so the token written below is silently lost there. Pass it as an
    // environment variable too (hidden from the process-listing tools that
    // expose argv, and preferred over stdin only when stdin cannot deliver):
    // the child reads env only as a fallback after stdin yields nothing.
    env.DSH_BROWSER_RPC_TOKEN = token
    this.child = spawn(electron, [hostMainPath, '--rpc-port', String(port)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: false,
      env,
    })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', chunk => {
      // Diagnostics only; never parse stderr as protocol.
      process.stderr.write(`[dsh-browser host] ${String(chunk)}`)
    })
    // Send the spawn token over stdin (first line). The child reads it from
    // stdin instead of argv so the token is never visible in the process
    // listing (WMI / Process Explorer / /proc/*). After writing, close stdin
    // so the child knows the token has been fully delivered.
    this.child.stdin?.write(token + '\n')
    this.child.stdin?.end()
    // A failed spawn (bad/corrupt binary) emits 'error' — without a listener
    // that would crash the whole DSH process.
    this.child.on('error', error => {
      process.stderr.write(`[dsh-browser host] spawn error: ${String(error)}\n`)
      this.fail(new Error(`dsh-builtin-browser: browser host failed to start: ${String(error)}`))
    })
    this.child.on('exit', (code, signal) => {
      this.fail(new Error(`dsh-builtin-browser: browser host exited (code=${String(code)} signal=${String(signal)})`))
    })
  }

  /** Reject everything in flight, mark the client dead, and notify the host. */
  private fail(err: Error): void {
    if (this.dead) return
    this.dead = true
    this.connected = false
    for (const pending of this.pending.values()) pending.reject(err)
    this.pending.clear()
    this.outbox = []
    this.onExit?.()
  }

  /** Whether a connection (authenticated or still authenticating) is held. */
  isAttached(): boolean {
    return this.socket !== undefined
  }

  /**
   * Accept the child's connection (called by the server). Exactly one socket
   * is ever attached; the server drops any further connection. Commands stay
   * queued until the child's first line authenticates with the spawn token.
   */
  attach(socket: import('node:net').Socket): void {
    if (this.socket !== undefined) {
      // Already attached: this is a second connection; reject it.
      socket.destroy()
      return
    }
    this.socket = socket
    socket.setEncoding('utf8')
    // Without an 'error' listener a remote reset (ECONNRESET/EPIPE) throws an
    // uncaught 'error' event and crashes the whole DSH process; 'close' below
    // does the cleanup.
    socket.on('error', error => {
      process.stderr.write(`[dsh-browser host] socket error: ${String(error)}\n`)
    })
    socket.on('data', chunk => this.onData(chunk))
    socket.on('close', () => {
      this.connected = false
      if (!this.dead) {
        this.fail(new Error('dsh-builtin-browser: browser host connection closed'))
      }
    })
    // The child must authenticate within the readiness budget; otherwise the
    // connection is treated as hostile and torn down.
    this.helloTimer = setTimeout(() => {
      if (this.awaitingHello) {
        socket.destroy()
        this.fail(new Error('dsh-builtin-browser: browser host did not authenticate'))
      }
    }, READY_TIMEOUT_MS)
  }

  private onData(chunk: string | Buffer): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    // Safety net: a pathological child (or a reply larger than expected)
    // must not grow the parent's memory without bound. The child caps
    // downloads at 256 MiB, so a healthy stream never approaches this.
    if (this.buffer.length > MAX_RPC_BUFFER_BYTES) {
      this.buffer = ''
      this.fail(new Error(`dsh-builtin-browser: RPC reply exceeded ${MAX_RPC_BUFFER_BYTES} bytes`))
      return
    }
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (line === '') continue
      let msg: { id?: number; op?: string; token?: string; ok?: boolean; result?: unknown; err?: string; action?: unknown }
      try {
        msg = JSON.parse(line) as typeof msg
      } catch {
        // Non-protocol line; ignore.
        continue
      }
      if (msg.op === 'userAction') {
        // Fire-and-forget notification from the child's own UI (toolbar):
        // there is no reply and no pending id — route it straight to the
        // host's user-action handler (which the provider registered).
        this.onUserAction?.(msg.action as BrowserUserAction)
        continue
      }
      if (this.awaitingHello) {
        // The FIRST line must be the child's hello carrying the spawn token.
        // Anything else (or a wrong token) means a spoofed connection: drop
        // it and fail every pending call rather than trust the line.
        this.awaitingHello = false
        if (this.helloTimer !== undefined) {
          clearTimeout(this.helloTimer)
          this.helloTimer = undefined
        }
        if (msg.op !== 'hello' || msg.token !== this.token) {
          this.socket?.destroy()
          this.fail(new Error('dsh-builtin-browser: browser host authentication failed'))
          return
        }
        this.connected = true
        // Flush anything queued while disconnected — now that the peer is
        // authenticated, it is safe to send commands.
        if (this.outbox.length > 0) {
          for (const line of this.outbox) this.socket?.write(line + '\n')
          this.outbox = []
        }
        continue
      }
      if (typeof msg.id !== 'number') continue
      const pending = this.pending.get(msg.id)
      if (pending === undefined) continue
      this.pending.delete(msg.id)
      if (msg.ok === true) pending.resolve(msg.result)
      else pending.reject(new Error(msg.err ?? 'browser host command failed'))
    }
  }

  /** Send one command and await the reply. */
  call<T = unknown>(op: string, payload: Record<string, unknown> = {}): Promise<T> {
    if (this.dead) {
      return Promise.reject(new Error('dsh-builtin-browser: browser host is not running'))
    }
    const id = this.nextId++
    const line = JSON.stringify({ id, op, ...payload })
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      if (this.connected && this.socket !== undefined) {
        this.socket.write(line + '\n')
      } else {
        // Not connected yet: queue; attach() flushes on the child's arrival.
        this.outbox.push(line)
      }
    })
  }

  /** Terminate the child. */
  kill(): void {
    try { this.socket?.destroy() } catch { /* already closed */ }
    this.child.kill()
  }
}

/** One view in the child: its id, used for every command. */
class RemoteView implements ElectronViewHandle {
  constructor(readonly id: string, private readonly client: ElectronChildClient) {}

  sendCommand(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.call<Record<string, unknown>>('command', {
      viewId: this.id,
      method,
      params: params ?? {},
    })
  }

  /** Ask the child to download a URL to a local file (keeps cookies/login). */
  async download(url: string, savePath: string): Promise<void> {
    // The child writes the file itself (temp + rename); only a small
    // confirmation crosses the RPC, so large downloads never balloon the
    // parent's memory or hit the single-line cap.
    await this.client.call<{ path: string }>('download', { viewId: this.id, url, savePath })
  }

  /** Native capturePage snapshot of the view (base64 + mime). */
  capture(opts?: ScreenshotOptions): Promise<{ base64: string; mime: string }> {
    return this.client.call<{ base64: string; mime: string }>('capture', { viewId: this.id, ...opts ?? {} })
  }

  /** Export the session's cookies (login state). */
  flushAuth(): Promise<ExportedCookie[]> {
    return this.client.call<{ cookies: ExportedCookie[] }>('flushAuth', { viewId: this.id }).then(r => r.cookies)
  }

  /** Import cookies into the session (restore login state). */
  restoreAuth(cookies: ExportedCookie[]): Promise<number> {
    return this.client.call<{ restored: number }>('restoreAuth', { viewId: this.id, cookies }).then(r => r.restored)
  }
}

/**
 * Self-hosted view host: spawns the plugin's Electron child on first use and
 * keeps it alive until dispose(). Fallback when no desktop shell provides
 * ctx.electronViewHost.
 */
export class RemoteElectronViewHost implements ElectronBrowserViewHost {
  private client: ElectronChildClient | undefined
  private server: Server | undefined
  private pendingSocket: Socket | undefined
  private readonly views = new Map<string, ElectronViewHandle>()
  private readyPromise: Promise<void> | undefined
  private disposed = false
  /** Cached probe result so `available()` stays cheap after the first call. */
  private electronAvailable: boolean | undefined
  /** Window groups (windowId per view), re-sent on every materialization so
   *  a restarted child still places views in the right windows. */
  private readonly groups = new Map<string, { windowId: string; label?: string }>()
  /** The provider's user-action handler; routes toolbar actions into sessions. */
  private userActionHandler: ((action: BrowserUserAction) => void) | undefined

  constructor(private readonly hostMainPath: string) {}

  /**
   * Cheap usability probe: can we find an Electron binary to spawn? The scan
   * is filesystem-only (no network), per the seam's contract, and the result
   * is cached for the host's lifetime — a missing binary surfaces as
   * `BROWSER_PROVIDER_UNAVAILABLE` at provider selection instead of a
   * confusing spawn failure on first use.
   */
  available(): boolean {
    if (this.electronAvailable === undefined) {
      try {
        resolveElectronPath()
        this.electronAvailable = true
      } catch {
        this.electronAvailable = false
      }
    }
    return this.electronAvailable
  }

  /** Ensure the child is up and ready (lazy on first use; restarts after a crash). */
  private ready(): Promise<void> {
    if (this.readyPromise !== undefined) return this.readyPromise
    const started = this.start()
    const wrapped = started.catch(error => {
      // A failed startup must not poison the host forever: tear down whatever
      // was half-created and let the next call retry from scratch.
      if (this.readyPromise === wrapped) {
        this.readyPromise = undefined
        this.client?.kill()
        this.client = undefined
        this.server?.close()
        this.server = undefined
        this.pendingSocket = undefined
      }
      throw error
    })
    this.readyPromise = wrapped
    return wrapped
  }

  private async start(): Promise<void> {
    // Listen on an ephemeral loopback port; the child connects back. The
    // server accepts exactly one connection: the child's. Any further
    // connection (a local process probing the port) is destroyed at once.
    const server = createServer(socket => {
      if (this.client !== undefined && this.client.isAttached()) {
        // A live child connection already exists — reject the extra one.
        socket.destroy()
        return
      }
      if (this.client !== undefined) {
        // The child's first connection arrived after the client was created.
        this.client.attach(socket)
        return
      }
      if (this.pendingSocket !== undefined) {
        // Only one connection may wait for the client; drop the older one.
        this.pendingSocket.destroy()
      }
      this.pendingSocket = socket
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    // A later server error (rare on a loopback ephemeral port) must not crash
    // the process; the client's fail path handles the actual recovery.
    server.on('error', error => {
      process.stderr.write(`[dsh-browser host] rpc server error: ${String(error)}\n`)
    })
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    this.server = server
    // Random per-spawn token: the child must prove knowledge of it (via
    // stdin hello) before any command is written to the socket.
    const token = randomBytes(24).toString('hex')
    this.client = new ElectronChildClient(
      this.hostMainPath,
      port,
      token,
      () => this.onChildExit(),
      action => this.userActionHandler?.(action),
    )
    if (this.pendingSocket !== undefined) {
      this.client.attach(this.pendingSocket)
      this.pendingSocket = undefined
    }
    // Wait for the child's connection + authentication + readiness ping. The
    // ping is queued until the hello authenticates, so a spoofed socket
    // never observes it.
    await withTimeout(this.client.call('ping'), READY_TIMEOUT_MS, 'browser host did not become ready')
  }

  /** The child died: tear down so the next use starts a fresh child. */
  private onChildExit(): void {
    if (this.disposed) return
    this.client = undefined
    this.server?.close()
    this.server = undefined
    this.pendingSocket = undefined
    this.readyPromise = undefined
    // Keep the views map: handles still resolve to ids; a fresh child simply
    // has no such views yet, and reset_session reopens clean sessions.
  }

  createView(): ElectronViewHandle {
    // The seam is synchronous; the provider uses the handle immediately, so
    // commands are deferred until the child is up and the view materialized.
    const id = `view:${Math.random().toString(36).slice(2, 10)}`
    const view = new DeferredRemoteView(id, () => this.ensureView(id))
    this.views.set(id, view)
    return view
  }

  private async ensureView(id: string): Promise<RemoteView> {
    await this.ready()
    const client = this.client
    if (client === undefined) throw new Error('browser host unavailable')
    // Re-send the window group before creating the view: the child routes the
    // view into its session's own window. Re-sending every materialization
    // also covers a child restart (the new child has no assignments yet).
    const group = this.groups.get(id)
    if (group !== undefined) {
      await client.call('groupView', { viewId: id, windowId: group.windowId, ...group.label !== undefined ? { label: group.label } : {} })
    }
    await client.call('createView', { viewId: id })
    // If the view was destroyed while the createView RPC was in flight, do
    // not re-insert a stale entry that would resurrect a dead child view.
    if (this.views.get(id) === undefined) {
      throw new Error('browser: view destroyed while starting')
    }
    const view = new RemoteView(id, client)
    this.views.set(id, view)
    return view
  }

  showView(handle: ElectronViewHandle, label?: string): void {
    // Fire-and-forget by design (visibility is best-effort), but a rejected
    // promise must not become an unhandled rejection (crash on Node >= 15).
    // The label (session/task id) rides along so the child can show it in the
    // window title — a human can then tell which task's page is visible.
    void this.ready()
      .then(() => this.client?.call('showView', { viewId: handle.id, ...label !== undefined ? { label } : {} }))
      .catch(() => { /* host unavailable */ })
  }

  /** Route a view into its session's own window (one window per session). */
  groupView(handle: ElectronViewHandle, windowId: string, label?: string): void {
    this.groups.set(handle.id, { windowId, ...label !== undefined ? { label } : {} })
    // Fire-and-forget: the child may not exist yet; ensureView re-sends the
    // group before every createView anyway.
    void this.ready()
      .then(() => this.client?.call('groupView', { viewId: handle.id, windowId, ...label !== undefined ? { label } : {} }))
      .catch(() => { /* host unavailable */ })
  }

  /** Register the provider's handler for user-initiated toolbar actions. */
  onUserAction(handler: (action: BrowserUserAction) => void): void {
    this.userActionHandler = handler
  }

  /** Surface a failed user action to the child's toolbar (address bar etc.). */
  notifyUserActionError(windowId: string, message: string): void {
    void this.ready()
      .then(() => this.client?.call('userActionError', { windowId, message }))
      .catch(() => { /* host unavailable */ })
  }

  destroyView(handle: ElectronViewHandle): void {
    const view = this.views.get(handle.id)
    if (view === undefined) return
    this.views.delete(handle.id)
    void this.ready()
      .then(() => this.client?.call('destroyView', { viewId: handle.id }))
      .catch(() => { /* child already gone */ })
  }

  /** Shut the child and the RPC server down. */
  dispose(): void {
    this.disposed = true
    this.client?.kill()
    this.client = undefined
    this.server?.close()
    this.server = undefined
    this.readyPromise = undefined
    this.views.clear()
  }
}

/** A view handle that waits for child readiness before issuing commands. */
class DeferredRemoteView implements ElectronViewHandle {
  private materialized: Promise<RemoteView> | undefined

  constructor(
    readonly id: string,
    private readonly materialize: () => Promise<RemoteView>,
  ) {}

  /**
   * Materialize once and cache: every sendCommand on the same handle must
   * target the SAME child view (re-materializing would re-run createView and
   * duplicate the window). A FAILED materialization is reset so a later call
   * (e.g. after the host restarted) can retry instead of being poisoned.
   */
  private materializeOnce(): Promise<RemoteView> {
    if (this.materialized === undefined) {
      const pending = this.materialize()
      this.materialized = pending.catch(error => {
        if (this.materialized === pending) this.materialized = undefined
        throw error
      })
    }
    return this.materialized
  }

  async sendCommand(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const view = await this.materializeOnce()
    return view.sendCommand(method, params)
  }

  async download(url: string, savePath: string): Promise<void> {
    const view = await this.materializeOnce()
    return view.download(url, savePath)
  }

  async capture(opts?: ScreenshotOptions): Promise<{ base64: string; mime: string }> {
    const view = await this.materializeOnce()
    return view.capture(opts)
  }

  async flushAuth(): Promise<ExportedCookie[]> {
    const view = await this.materializeOnce()
    return view.flushAuth()
  }

  async restoreAuth(cookies: ExportedCookie[]): Promise<number> {
    const view = await this.materializeOnce()
    return view.restoreAuth(cookies)
  }
}

/** Reject a promise if it does not settle within the budget. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${message} (${ms}ms)`)), ms)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

/** Default host-main path relative to this module's build output. */
export function defaultHostMainPath(): string {
  return fileURLToPath(new URL('./host-main.js', import.meta.url))
}
