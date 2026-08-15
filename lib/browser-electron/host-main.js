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
 *   -> { id, ok: true, result? } | { id, ok: false, err }
 *
 * The parent never parses stderr, so diagnostics may go there freely.
 * @module dsh-browser/browser-electron/host-main
 */
import { app, BrowserWindow, WebContentsView } from 'electron';
import { createInterface } from 'node:readline';
import { createConnection } from 'node:net';
/** CDP protocol version attached to every view's debugger. */
const CDP_VERSION = '1.3';
/** Download cap: the body is shipped base64 as one JSON line; bound the memory. */
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
/** Views by the id the parent assigned at createView time. */
const views = new Map();
/** The single browser window; created lazily on first createView. */
let window;
/** The RPC socket to the parent; set when the connection is established. */
let rpcSocket;
/** Reply to the parent over the RPC socket. */
function reply(id, payload) {
    if (rpcSocket === undefined) {
        process.stderr.write(`[dsh-browser host] reply without socket (id=${id})\n`);
        return;
    }
    rpcSocket.write(JSON.stringify({ id, ...payload }) + '\n');
}
/** Handle one command. */
async function handle(op, msg) {
    try {
        switch (op) {
            case 'ping':
                reply(msg.id, { ok: true });
                return;
            case 'createView': {
                const viewId = msg.viewId;
                if (viewId === undefined)
                    throw new Error('createView missing viewId');
                if (window === undefined) {
                    window = new BrowserWindow({ width: 1400, height: 900, show: true, title: 'dsh-browser' });
                    window.on('closed', () => { window = undefined; });
                }
                const view = new WebContentsView();
                // Attach the debugger BEFORE the view can be seen: an attach failure
                // then leaves nothing in the window (no visible ghost view).
                view.webContents.debugger.attach(CDP_VERSION);
                // New views start hidden: with several sessions/tabs only the shown
                // one may be visible (they stack in contentView child order).
                view.setVisible(false);
                window.contentView.addChildView(view);
                const [width, height] = window.getContentSize();
                view.setBounds({ x: 0, y: 0, width: width ?? 0, height: height ?? 0 });
                if (views.size === 0)
                    view.setVisible(true);
                views.set(viewId, { webContentsView: view });
                reply(msg.id, { ok: true });
                return;
            }
            case 'destroyView': {
                const viewId = msg.viewId;
                if (viewId === undefined)
                    throw new Error('destroyView missing viewId');
                const entry = views.get(viewId);
                if (entry !== undefined) {
                    views.delete(viewId);
                    try {
                        entry.webContentsView.webContents.debugger.detach();
                    }
                    catch { /* already detached */ }
                    entry.webContentsView.webContents.close();
                    window?.contentView.removeChildView(entry.webContentsView);
                }
                reply(msg.id, { ok: true });
                return;
            }
            case 'showView': {
                const viewId = msg.viewId;
                if (viewId === undefined)
                    throw new Error('showView missing viewId');
                const entry = views.get(viewId);
                if (entry !== undefined) {
                    // Hide every other view, then show and RAISE the target so the
                    // human actually sees the active tab/session (topmost child wins).
                    for (const v of views.values()) {
                        if (v === entry)
                            continue;
                        try {
                            v.webContentsView.setVisible(false);
                        }
                        catch { /* destroyed */ }
                    }
                    entry.webContentsView.setVisible(true);
                    if (window !== undefined) {
                        window.contentView.removeChildView(entry.webContentsView);
                        window.contentView.addChildView(entry.webContentsView);
                    }
                }
                reply(msg.id, { ok: true });
                return;
            }
            case 'command': {
                const viewId = msg.viewId;
                if (viewId === undefined)
                    throw new Error('command missing viewId');
                const entry = views.get(viewId);
                if (entry === undefined)
                    throw new Error(`command: unknown view ${viewId}`);
                const method = msg.method;
                if (typeof method !== 'string')
                    throw new Error('command missing method');
                const result = await entry.webContentsView.webContents.debugger.sendCommand(method, msg.params ?? {});
                reply(msg.id, { ok: true, result });
                return;
            }
            case 'download': {
                const viewId = msg.viewId;
                const url = msg.url;
                const savePath = msg.savePath;
                if (viewId === undefined || typeof url !== 'string' || typeof savePath !== 'string') {
                    throw new Error('download missing viewId/url/savePath');
                }
                const entry = views.get(viewId);
                if (entry === undefined)
                    throw new Error(`download: unknown view ${viewId}`);
                // Fetch the URL inside the page context (keeps cookies/login), read
                // the body as base64, and return it; the parent writes the file. This
                // avoids Electron's download pipeline entirely (CDP debugger attach
                // can interfere with will-download).
                const result = await entry.webContentsView.webContents.debugger.sendCommand('Runtime.evaluate', {
                    expression: `(async () => {
            const r = await fetch(${JSON.stringify(url)}, { credentials: 'include' })
            if (!r.ok) throw new Error('HTTP ' + r.status)
            const b = await r.arrayBuffer()
            const bytes = new Uint8Array(b)
            if (bytes.length > ${String(MAX_DOWNLOAD_BYTES)}) throw new Error('download too large (limit ' + ${String(MAX_DOWNLOAD_BYTES)} + ' bytes, got ' + bytes.length + ')')
            let bin = ''
            for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
            return btoa(bin)
          })()`,
                    awaitPromise: true,
                    returnByValue: true,
                });
                const value = result.result?.value;
                if (typeof value !== 'string') {
                    const detail = result.exceptionDetails;
                    throw new Error(`download failed: ${detail?.exception?.description ?? 'no data'}`);
                }
                reply(msg.id, { ok: true, result: { base64: value, savePath } });
                return;
            }
            case 'flushAuth': {
                const viewId = msg.viewId;
                if (viewId === undefined)
                    throw new Error('flushAuth missing viewId');
                const entry = views.get(viewId);
                if (entry === undefined)
                    throw new Error(`flushAuth: unknown view ${viewId}`);
                // Export the session's cookies so login state can be saved/restored
                // across browser hosts (or shared with another machine).
                const cookies = await entry.webContentsView.webContents.session.cookies.get({});
                const exported = cookies.map(c => {
                    const host = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
                    // IPv6 literal domains need brackets in a URL (e.g. http://[::1]/).
                    const hostPart = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
                    return {
                        url: `http${c.secure ? 's' : ''}://${hostPart}${c.path}`,
                        name: c.name,
                        value: c.value,
                        domain: c.domain,
                        path: c.path,
                        secure: c.secure,
                        httpOnly: c.httpOnly,
                        expirationDate: c.expirationDate,
                    };
                });
                reply(msg.id, { ok: true, result: { cookies: exported } });
                return;
            }
            case 'restoreAuth': {
                const viewId = msg.viewId;
                const cookies = msg.cookies;
                if (viewId === undefined)
                    throw new Error('restoreAuth missing viewId');
                const entry = views.get(viewId);
                if (entry === undefined)
                    throw new Error(`restoreAuth: unknown view ${viewId}`);
                if (!Array.isArray(cookies))
                    throw new Error('restoreAuth missing cookies array');
                let restored = 0;
                for (const c of cookies) {
                    if (typeof c.url !== 'string' || typeof c.name !== 'string' || typeof c.value !== 'string')
                        continue;
                    await entry.webContentsView.webContents.session.cookies.set({
                        url: c.url,
                        name: c.name,
                        value: c.value,
                        ...typeof c.domain === 'string' ? { domain: c.domain } : {},
                        ...typeof c.path === 'string' ? { path: c.path } : {},
                        ...typeof c.secure === 'boolean' ? { secure: c.secure } : {},
                        ...typeof c.httpOnly === 'boolean' ? { httpOnly: c.httpOnly } : {},
                        ...typeof c.expirationDate === 'number' ? { expirationDate: c.expirationDate } : {},
                    });
                    restored++;
                }
                reply(msg.id, { ok: true, result: { restored } });
                return;
            }
            default:
                throw new Error(`unknown op ${op}`);
        }
    }
    catch (error) {
        reply(msg.id, { ok: false, err: String(error) });
    }
}
/**
 * Electron entry: connect back to the parent's RPC server (port from
 * `--rpc-port`) and serve line-delimited JSON-RPC. `ELECTRON_RUN_AS_NODE` is
 * cleared by the parent so `require('electron')` works; this file is loaded as
 * the app entry so `app` is available immediately.
 */
void app.whenReady().then(() => {
    const portArg = process.argv.indexOf('--rpc-port');
    const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : NaN;
    if (!Number.isFinite(port)) {
        process.stderr.write('[dsh-browser host] missing --rpc-port\n');
        app.exit(1);
        return;
    }
    const socket = createConnection({ host: '127.0.0.1', port });
    rpcSocket = socket;
    socket.setEncoding('utf8');
    const rl = createInterface({ input: socket });
    rl.on('line', line => {
        const text = line.trim();
        if (text === '')
            return;
        let msg;
        try {
            msg = JSON.parse(text);
        }
        catch {
            return; // non-protocol noise
        }
        if (typeof msg.id !== 'number' || typeof msg.op !== 'string')
            return;
        void handle(msg.op, msg).catch(() => { });
    });
    socket.on('error', error => {
        process.stderr.write(`[dsh-browser host] socket error: ${String(error)}\n`);
    });
    // The parent owns our lifetime: when it closes the socket (dispose) or dies
    // without cleanup, exit so no zombie Electron window is left behind.
    socket.on('close', () => {
        process.stderr.write('[dsh-browser host] parent connection closed, exiting\n');
        app.exit(0);
    });
    // Keep the process alive until the parent closes the socket or kills us.
});
// Diagnostics go to stderr, which the parent never parses as protocol.
process.on('uncaughtException', error => {
    process.stderr.write(`[dsh-browser host] uncaught: ${String(error)}\n`);
});
