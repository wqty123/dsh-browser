/**
 * Self-hosted Electron browser host (child side): the Electron main process
 * spawned by {@link RemoteElectronViewHost}. Owns one `BrowserWindow` plus
 * `WebContentsView`s and their `webContents.debugger` (CDP), and answers
 * line-delimited JSON-RPC on stdio.
 *
 * Protocol (one JSON object per line, both directions):
 *   <- { id, op: 'ping' } | { id, op: 'createView', viewId } |
 *      { id, op: 'destroyView', viewId } | { id, op: 'showView', viewId } |
 *      { id, op: 'command', viewId, method, params }
 *   -> { id: 0, op: 'hello', token } (our FIRST message — proves we know the
 *      parent's `--rpc-token`; the parent refuses the connection otherwise)
 *   -> { id, ok: true, result? } | { id, ok: false, err }
 *
 * The parent never parses stderr, so diagnostics may go there freely.
 * @module dsh-browser/browser-electron/host-main
 */

import { app, BrowserWindow, WebContentsView } from 'electron'
import { createInterface } from 'node:readline'
import { createConnection } from 'node:net'
import { join } from 'node:path'

/** The spawn token the parent passed via `--rpc-token`; must be echoed in our hello. */
const tokenArg = process.argv.indexOf('--rpc-token')
const RPC_TOKEN = tokenArg >= 0 ? process.argv[tokenArg + 1] ?? '' : ''

// Isolate this host's profile from the DSH app's default Electron userData:
// several Electron instances sharing Roaming\Electron fight over the GPU
// cache/session locks, which can leave the window without a display surface
// (capturePage then fails). A dedicated userData also persists cookies across
// host restarts (on top of browser_auth). Must run before app is ready.
try {
  const base = process.env.DSH_HOME ?? app.getPath('appData')
  app.setPath('userData', join(base, 'dsh-builtin-browser-host'))
} catch (error) {
  process.stderr.write(`[dsh-browser host] userData setup failed: ${String(error)}\n`)
}

/** CDP protocol version attached to every view's debugger. */
const CDP_VERSION = '1.3'

/** Download cap: the body is shipped base64 as one JSON line; bound the memory. */
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024

/** One view: the Electron object plus its CDP-backed surface. */
interface HostView {
  readonly webContentsView: WebContentsView
}

/** Views by the id the parent assigned at createView time. */
const views = new Map<string, HostView>()

/** The single browser window; created lazily on first createView. */
let window: BrowserWindow | undefined

/** The RPC socket to the parent; set when the connection is established. */
let rpcSocket: import('node:net').Socket | undefined

/** Reply to the parent over the RPC socket. */
function reply(id: number, payload: Record<string, unknown>): void {
  if (rpcSocket === undefined) {
    process.stderr.write(`[dsh-browser host] reply without socket (id=${id})\n`)
    return
  }
  rpcSocket.write(JSON.stringify({ id, ...payload }) + '\n')
}

/** Handle one command. */
async function handle(op: string, msg: { id: number; viewId?: string; method?: string; params?: Record<string, unknown>; url?: string; savePath?: string; cookies?: unknown[] }): Promise<void> {
  try {
    switch (op) {
      case 'ping':
        reply(msg.id, { ok: true })
        return
      case 'createView': {
        const viewId = msg.viewId
        if (viewId === undefined) throw new Error('createView missing viewId')
        if (window === undefined) {
          window = new BrowserWindow({ width: 1400, height: 900, show: true, title: 'dsh-browser' })
          window.on('closed', () => { window = undefined })
          // Views are positioned once at creation; keep them filling the
          // window as the human resizes it (otherwise the page stays at the
          // original size and the layout breaks).
          window.on('resize', () => {
            const [width, height] = window?.getContentSize() ?? [0, 0]
            for (const v of views.values()) {
              try { v.webContentsView.setBounds({ x: 0, y: 0, width: width ?? 0, height: height ?? 0 }) } catch { /* destroyed */ }
            }
          })
        }
        const view = new WebContentsView()
        // Route popups (window.open / target=_blank) back into THIS view
        // instead of letting Electron open untracked native windows that would
        // diverge from the session/tab model. The URL is loaded directly with
        // the page's own navigation (http/https only); the agent re-snapshots
        // and sees the new page as the active tab's content.
        view.webContents.setWindowOpenHandler(({ url }) => {
          try {
            if (/^https?:/i.test(url)) void view.webContents.loadURL(url).catch(() => { /* navigation failures surface on the next snapshot */ })
          } catch { /* synchronous failures are no-ops too */ }
          return { action: 'deny' }
        })
        // Attach the debugger BEFORE the view can be seen: an attach failure
        // then leaves nothing in the window (no visible ghost view).
        view.webContents.debugger.attach(CDP_VERSION)
        // New views start hidden: with several sessions/tabs only the shown
        // one may be visible (they stack in contentView child order).
        view.setVisible(false)
        window.contentView.addChildView(view)
        const [width, height] = window.getContentSize()
        view.setBounds({ x: 0, y: 0, width: width ?? 0, height: height ?? 0 })
        if (views.size === 0) view.setVisible(true)
        views.set(viewId, { webContentsView: view })
        reply(msg.id, { ok: true })
        return
      }
      case 'destroyView': {
        const viewId = msg.viewId
        if (viewId === undefined) throw new Error('destroyView missing viewId')
        const entry = views.get(viewId)
        if (entry !== undefined) {
          views.delete(viewId)
          try { entry.webContentsView.webContents.debugger.detach() } catch { /* already detached */ }
          entry.webContentsView.webContents.close()
          window?.contentView.removeChildView(entry.webContentsView)
        }
        reply(msg.id, { ok: true })
        return
      }
      case 'showView': {
        const viewId = msg.viewId
        if (viewId === undefined) throw new Error('showView missing viewId')
        const entry = views.get(viewId)
        if (entry !== undefined) {
          // Hide every other view, then show and RAISE the target so the
          // human actually sees the active tab/session (topmost child wins).
          for (const v of views.values()) {
            if (v === entry) continue
            try { v.webContentsView.setVisible(false) } catch { /* destroyed */ }
          }
          entry.webContentsView.setVisible(true)
          if (window !== undefined) {
            window.contentView.removeChildView(entry.webContentsView)
            window.contentView.addChildView(entry.webContentsView)
          }
        }
        reply(msg.id, { ok: true })
        return
      }
      case 'command': {
        const viewId = msg.viewId
        if (viewId === undefined) throw new Error('command missing viewId')
        const entry = views.get(viewId)
        if (entry === undefined) throw new Error(`command: unknown view ${viewId}`)
        const method = msg.method
        if (typeof method !== 'string') throw new Error('command missing method')
        const result = await entry.webContentsView.webContents.debugger.sendCommand(method, msg.params ?? {})
        reply(msg.id, { ok: true, result })
        return
      }
      case 'capture': {
        const viewId = msg.viewId
        if (viewId === undefined) throw new Error('capture missing viewId')
        const entry = views.get(viewId)
        if (entry === undefined) throw new Error(`capture: unknown view ${viewId}`)
        // Two complementary paths, because each has a failure mode:
        //  - capturePage: fast and reliable with several WebContentsViews in
        //    the window, but needs a live display surface (fails when the
        //    window is minimized/occluded/unpainted).
        //  - CDP Page.captureScreenshot: works without a display surface, but
        //    can hang when another hidden WebContentsView exists in the window.
        // Try capturePage first (show/focus/restore + one retry), then CDP.
        if (window !== undefined) {
          try { if (!window.isVisible()) window.show() } catch { /* closing */ }
          try { window.restore() } catch { /* not minimized */ }
          window.focus()
        }
        let base64 = ''
        try {
          let image
          try {
            image = await entry.webContentsView.webContents.capturePage()
          } catch (error) {
            process.stderr.write(`[dsh-browser host] capturePage failed: ${String(error)}\n`)
            await new Promise(resolve => setTimeout(resolve, 400))
            image = await entry.webContentsView.webContents.capturePage()
          }
          const png = image.toPNG()
          if (png.length > 0) base64 = png.toString('base64')
        } catch (error) {
          const state = window !== undefined
            ? JSON.stringify({
              win: { visible: window.isVisible(), minimized: window.isMinimized(), focused: window.isFocused() },
            })
            : 'no-window'
          process.stderr.write(`[dsh-browser host] capturePage retry failed: ${String(error)} state=${state}\n`)
          base64 = ''
        }
        if (base64 === '') {
          // CDP fallback. Page.captureScreenshot can hang when OTHER views
          // (especially hidden attach-first ones) are in the window, so
          // temporarily detach the siblings, capture in single-view state,
          // then restore them (target stays on top).
          const siblings = [...views.values()].filter(v => v !== entry)
          for (const v of siblings) {
            try { window?.contentView.removeChildView(v.webContentsView) } catch { /* already gone */ }
          }
          try {
            const shot = await entry.webContentsView.webContents.debugger.sendCommand('Page.captureScreenshot', {})
            const data = (shot as { data?: unknown }).data
            if (typeof data === 'string' && data.length > 0) base64 = data
          } finally {
            for (const v of siblings) {
              try { window?.contentView.addChildView(v.webContentsView) } catch { /* destroyed */ }
            }
            try {
              window?.contentView.removeChildView(entry.webContentsView)
              window?.contentView.addChildView(entry.webContentsView)
            } catch { /* closing */ }
          }
        }
        if (base64 === '') {
          throw new Error('capture produced no image (view not painted)')
        }
        reply(msg.id, { ok: true, result: { base64, width: 0, height: 0 } })
        return
      }
      case 'download': {
        const viewId = msg.viewId
        const url = msg.url
        const savePath = msg.savePath
        if (viewId === undefined || typeof url !== 'string' || typeof savePath !== 'string') {
          throw new Error('download missing viewId/url/savePath')
        }
        const entry = views.get(viewId)
        if (entry === undefined) throw new Error(`download: unknown view ${viewId}`)
        // Fetch the URL inside the page context (keeps cookies/login), read
        // the body as base64, and return it; the parent writes the file. This
        // avoids Electron's download pipeline entirely (CDP debugger attach
        // can interfere with will-download).
        const result = await entry.webContentsView.webContents.debugger.sendCommand('Runtime.evaluate', {
          // Stream the body through a reader so the size cap is enforced as
          // bytes arrive — never buffer an unbounded download into memory
          // before checking the limit (a huge URL would otherwise OOM the
          // renderer). The declared Content-Length short-circuits large files
          // before any body is read.
          expression: `(async () => {
            const r = await fetch(${JSON.stringify(url)}, { credentials: 'include' })
            if (!r.ok) throw new Error('HTTP ' + r.status)
            const declared = Number(r.headers.get('content-length') || 0)
            if (declared > ${String(MAX_DOWNLOAD_BYTES)}) throw new Error('download too large (limit ' + ${String(MAX_DOWNLOAD_BYTES)} + ' bytes, declared ' + declared + ')')
            if (!r.body || typeof r.body.getReader !== 'function') {
              const b = await r.arrayBuffer()
              const bytes = new Uint8Array(b)
              if (bytes.length > ${String(MAX_DOWNLOAD_BYTES)}) throw new Error('download too large (limit ' + ${String(MAX_DOWNLOAD_BYTES)} + ' bytes, got ' + bytes.length + ')')
              let bin = ''
              for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
              return btoa(bin)
            }
            const reader = r.body.getReader()
            const chunks = []
            let total = 0
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              total += value.length
              if (total > ${String(MAX_DOWNLOAD_BYTES)}) {
                await reader.cancel()
                throw new Error('download too large (limit ' + ${String(MAX_DOWNLOAD_BYTES)} + ' bytes, got ' + total + ')')
              }
              chunks.push(value)
            }
            const bytes = new Uint8Array(total)
            let off = 0
            for (const c of chunks) { bytes.set(c, off); off += c.length }
            let bin = ''
            for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
            return btoa(bin)
          })()`,
          awaitPromise: true,
          returnByValue: true,
        })
        const value = (result as { result?: { value?: unknown } }).result?.value
        if (typeof value !== 'string') {
          const detail = (result as { exceptionDetails?: { exception?: { description?: string } } }).exceptionDetails
          throw new Error(`download failed: ${detail?.exception?.description ?? 'no data'}`)
        }
        reply(msg.id, { ok: true, result: { base64: value, savePath } })
        return
      }
      case 'flushAuth': {
        const viewId = msg.viewId
        if (viewId === undefined) throw new Error('flushAuth missing viewId')
        const entry = views.get(viewId)
        if (entry === undefined) throw new Error(`flushAuth: unknown view ${viewId}`)
        // Export the session's cookies so login state can be saved/restored
        // across browser hosts (or shared with another machine).
        const cookies = await entry.webContentsView.webContents.session.cookies.get({})
        const exported = cookies.map(c => {
          const host = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain
          // IPv6 literal domains need brackets in a URL (e.g. http://[::1]/).
          const hostPart = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
          return {
            url: `http${c.secure ? 's' : ''}://${hostPart}${c.path}`,
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            secure: c.secure,
            httpOnly: c.httpOnly,
            expirationDate: c.expirationDate,
          }
        })
        reply(msg.id, { ok: true, result: { cookies: exported } })
        return
      }
      case 'restoreAuth': {
        const viewId = msg.viewId
        const cookies = msg.cookies
        if (viewId === undefined) throw new Error('restoreAuth missing viewId')
        const entry = views.get(viewId)
        if (entry === undefined) throw new Error(`restoreAuth: unknown view ${viewId}`)
        if (!Array.isArray(cookies)) throw new Error('restoreAuth missing cookies array')
        let restored = 0
        for (const c of cookies as Array<{ url?: string; name?: string; value?: string; domain?: string; path?: string; secure?: boolean; httpOnly?: boolean; expirationDate?: number }>) {
          if (typeof c.url !== 'string' || typeof c.name !== 'string' || typeof c.value !== 'string') continue
          await entry.webContentsView.webContents.session.cookies.set({
            url: c.url,
            name: c.name,
            value: c.value,
            ...typeof c.domain === 'string' ? { domain: c.domain } : {},
            ...typeof c.path === 'string' ? { path: c.path } : {},
            ...typeof c.secure === 'boolean' ? { secure: c.secure } : {},
            ...typeof c.httpOnly === 'boolean' ? { httpOnly: c.httpOnly } : {},
            ...typeof c.expirationDate === 'number' ? { expirationDate: c.expirationDate } : {},
          })
          restored++
        }
        reply(msg.id, { ok: true, result: { restored } })
        return
      }
      default:
        throw new Error(`unknown op ${op}`)
    }
  } catch (error) {
    reply(msg.id, { ok: false, err: String(error) })
  }
}

/**
 * Electron entry: connect back to the parent's RPC server (port from
 * `--rpc-port`) and serve line-delimited JSON-RPC. `ELECTRON_RUN_AS_NODE` is
 * cleared by the parent so `require('electron')` works; this file is loaded as
 * the app entry so `app` is available immediately.
 */
void app.whenReady().then(() => {
  const portArg = process.argv.indexOf('--rpc-port')
  const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : NaN
  if (!Number.isFinite(port)) {
    process.stderr.write('[dsh-browser host] missing --rpc-port\n')
    app.exit(1)
    return
  }
  const socket = createConnection({ host: '127.0.0.1', port })
  rpcSocket = socket
  socket.setEncoding('utf8')
  // Prove we know the parent's spawn token before anything else; the parent
  // refuses a connection whose first line is not this hello.
  socket.write(JSON.stringify({ id: 0, op: 'hello', token: RPC_TOKEN }) + '\n')
  const rl = createInterface({ input: socket })
  rl.on('line', line => {
    const text = line.trim()
    if (text === '') return
    let msg: { id: number; op?: string; viewId?: string; method?: string; params?: Record<string, unknown>; url?: string; savePath?: string; cookies?: unknown[] }
    try {
      msg = JSON.parse(text) as typeof msg
    } catch {
      return // non-protocol noise
    }
    if (typeof msg.id !== 'number' || typeof msg.op !== 'string') return
    void handle(msg.op, msg).catch(() => { /* reply already sent inside handle */ })
  })
  socket.on('error', error => {
    process.stderr.write(`[dsh-browser host] socket error: ${String(error)}\n`)
  })
  // The parent owns our lifetime: when it closes the socket (dispose) or dies
  // without cleanup, exit so no zombie Electron window is left behind.
  socket.on('close', () => {
    process.stderr.write('[dsh-browser host] parent connection closed, exiting\n')
    app.exit(0)
  })
  // Keep the process alive until the parent closes the socket or kills us.
})

// Diagnostics go to stderr, which the parent never parses as protocol.
process.on('uncaughtException', error => {
  process.stderr.write(`[dsh-browser host] uncaught: ${String(error)}\n`)
})
