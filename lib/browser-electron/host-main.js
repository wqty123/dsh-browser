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
                view.setVisible(false);
                window.contentView.addChildView(view);
                const [width, height] = window.getContentSize();
                view.setBounds({ x: 0, y: 0, width: width ?? 0, height: height ?? 0 });
                view.setVisible(true);
                view.webContents.debugger.attach(CDP_VERSION);
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
                if (entry !== undefined)
                    entry.webContentsView.setVisible(true);
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
    // Keep the process alive until the parent closes the socket or kills us.
});
// Diagnostics go to stderr, which the parent never parses as protocol.
process.on('uncaughtException', error => {
    process.stderr.write(`[dsh-browser host] uncaught: ${String(error)}\n`);
});
