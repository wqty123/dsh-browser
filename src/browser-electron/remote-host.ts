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
 *   <- { id, ok: true, result? } | { id, ok: false, err }
 *
 * The child is Electron's main process; host-main.js owns the BrowserWindow,
 * WebContentsViews, and webContents.debugger (CDP).
 * @module dsh-browser/browser-electron/remote-host
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type Server, type Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import type { ElectronBrowserViewHost, ElectronViewHandle } from './provider.ts'
import type { ExportedCookie } from '../browser/types.ts'

/** How long to wait for the child to signal readiness before failing. */
const READY_TIMEOUT_MS = 20_000

/**
 * Locate the Electron binary, trying, in order:
 *   1. require('electron') from this module (optional peer dependency),
 *   2. require.resolve('electron') against DSH install anchors (global dsh
 *      package, npm global root) — desktop-shell environments satisfy this,
 *   3. a pnpm virtual store under common workspace layouts,
 *   4. ELECTRON_PATH (explicit override).
 * @returns the path to the Electron executable.
 */
function resolveElectronPath(): string {
  const require = createRequire(import.meta.url)
  // 1. Optional peer dependency.
  try {
    const resolved: unknown = require('electron')
    if (typeof resolved === 'string' && resolved.length > 0) return resolved
  } catch {
    // continue probing
  }
  // 2. DSH install anchors: the global dsh package and the npm global root
  // both carry electron junctions under pnpm layouts.
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
        // electron's index.js is not the binary; find the dist executable
        // next to the package root.
        const exe = electronExeBeside(resolved)
        if (exe !== undefined) return exe
      }
    } catch {
      // continue probing
    }
  }
  // 3. pnpm virtual store, walking up from several candidate roots: this
  // module (its real path may differ from where the profile resolves it when
  // installed via a junction/link), the process CWD, and the Node executable
  // dir (DSH CLI typically runs from the workspace root).
  const roots = new Set<string>([
    fileURLToPath(new URL('.', import.meta.url)),
    process.cwd(),
    dirname(process.execPath),
  ])
  for (const root of roots) {
    let dir = root
    for (let depth = 0; depth < 8; depth++) {
      const store = join(dir, 'node_modules', '.pnpm')
      if (existsSync(store)) {
        const exe = findElectronExe(store)
        if (exe !== undefined) return exe
      }
      const parent = join(dir, '..')
      if (parent === dir) break
      dir = parent
    }
  }
  // 4. Explicit override.
  const override = process.env.ELECTRON_PATH
  if (typeof override === 'string' && override.length > 0 && existsSync(override)) return override
  throw new Error(
    'dsh-builtin-browser: cannot locate the Electron binary. Install electron in the host profile ' +
    '(e.g. `dsh plugin --profile web add electron`) or set ELECTRON_PATH to the electron executable.',
  )
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

/** dirname without importing node:path's dirname separately. */
function dirname(p: string): string {
  const i = p.lastIndexOf('/')
  const j = p.lastIndexOf('\\')
  const k = Math.max(i, j)
  return k < 0 ? p : p.slice(0, k)
}

/** Search a pnpm virtual store for an Electron dist binary. */
function findElectronExe(store: string): string | undefined {
  const entries = existsSync(store) ? readdirSync(store) : []
  for (const entry of entries) {
    if (!entry.startsWith('electron@')) continue
    const candidates = [
      join(store, entry, 'node_modules', 'electron', 'dist', 'electron.exe'),
      join(store, entry, 'node_modules', 'electron', 'dist', 'electron'),
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
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
  private readonly child: ChildProcessByStdio<null, import('node:stream').Readable, import('node:stream').Readable>
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private buffer = ''
  private socket: import('node:net').Socket | undefined
  private connected = false
  private outbox: string[] = []
  /** Set once the child has exited; further calls fail fast instead of queueing. */
  private dead = false

  constructor(
    private readonly hostMainPath: string,
    private readonly port: number,
    private readonly onExit?: () => void,
  ) {
    const electron = resolveElectronPath()
    // ELECTRON_RUN_AS_NODE (even an empty string) makes Electron run as plain
    // Node, breaking require('electron'); NODE_OPTIONS can inject flags that
    // break the child. Rebuild the env without either.
    const env: Record<string, string | undefined> = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.NODE_OPTIONS
    this.child = spawn(electron, [hostMainPath, '--rpc-port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
      env,
    })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', chunk => {
      // Diagnostics only; never parse stderr as protocol.
      process.stderr.write(`[dsh-browser host] ${String(chunk)}`)
    })
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

  /** Accept the child's connection (called by the server). */
  attach(socket: import('node:net').Socket): void {
    this.socket = socket
    this.connected = true
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
    // Flush anything queued while disconnected.
    if (this.outbox.length > 0) {
      for (const line of this.outbox) socket.write(line + '\n')
      this.outbox = []
    }
  }

  private onData(chunk: string | Buffer): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (line === '') continue
      let msg: { id?: number; ok?: boolean; result?: unknown; err?: string }
      try {
        msg = JSON.parse(line) as typeof msg
      } catch {
        // Non-protocol line; ignore.
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
    const result = await this.client.call<{ base64: string }>('download', { viewId: this.id, url, savePath })
    writeFileSync(savePath, Buffer.from(result.base64, 'base64'))
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

  constructor(private readonly hostMainPath: string) {}

  /** Ensure the child is up and ready (lazy on first use; restarts after a crash). */
  private ready(): Promise<void> {
    if (this.readyPromise !== undefined) return this.readyPromise
    this.readyPromise = this.start()
    return this.readyPromise
  }

  private async start(): Promise<void> {
    // Listen on an ephemeral loopback port; the child connects back.
    const server = createServer(socket => {
      if (this.client !== undefined) this.client.attach(socket)
      else this.pendingSocket = socket
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
    this.client = new ElectronChildClient(this.hostMainPath, port, () => this.onChildExit())
    if (this.pendingSocket !== undefined) {
      this.client.attach(this.pendingSocket)
      this.pendingSocket = undefined
    }
    // Wait for the child's connection + readiness ping.
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
    await client.call('createView', { viewId: id })
    const view = new RemoteView(id, client)
    this.views.set(id, view)
    return view
  }

  showView(handle: ElectronViewHandle): void {
    // Fire-and-forget by design (visibility is best-effort), but a rejected
    // promise must not become an unhandled rejection (crash on Node >= 15).
    void this.ready()
      .then(() => this.client?.call('showView', { viewId: handle.id }))
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

  async sendCommand(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    // Materialize once and cache: every sendCommand on the same handle must
    // target the SAME child view. Re-materializing would re-run createView
    // (duplicate window) and drop the established view.
    this.materialized ??= this.materialize()
    const view = await this.materialized
    return view.sendCommand(method, params)
  }

  async download(url: string, savePath: string): Promise<void> {
    this.materialized ??= this.materialize()
    const view = await this.materialized
    return view.download(url, savePath)
  }

  async flushAuth(): Promise<ExportedCookie[]> {
    this.materialized ??= this.materialize()
    const view = await this.materialized
    return view.flushAuth()
  }

  async restoreAuth(cookies: ExportedCookie[]): Promise<number> {
    this.materialized ??= this.materialize()
    const view = await this.materialized
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
