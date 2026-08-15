/**
 * Self-hosted Electron browser host (parent side): an
 * {@link ElectronBrowserViewHost} implementation that spawns the plugin's own
 * Electron child process (host-main.js) and drives it over line-delimited
 * JSON-RPC on stdio. This is what makes the plugin work on surfaces without a
 * desktop shell's electronViewHost (plain dsh web): installing the plugin is
 * enough — the browser window appears on first use.
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
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
/** How long to wait for the child to signal readiness before failing. */
const READY_TIMEOUT_MS = 20_000;
/**
 * Locate the Electron binary, trying, in order:
 *   1. require('electron') from this module (optional peer dependency),
 *   2. require.resolve('electron') against DSH install anchors (global dsh
 *      package, npm global root) — desktop-shell environments satisfy this,
 *   3. a pnpm virtual store under common workspace layouts,
 *   4. ELECTRON_PATH (explicit override).
 * @returns the path to the Electron executable.
 */
function resolveElectronPath() {
    const require = createRequire(import.meta.url);
    // 1. Optional peer dependency.
    try {
        const resolved = require('electron');
        if (typeof resolved === 'string' && resolved.length > 0)
            return resolved;
    }
    catch {
        // continue probing
    }
    // 2. DSH install anchors: the global dsh package and the npm global root
    // both carry electron junctions under pnpm layouts.
    const anchors = [];
    const globalPrefix = process.env.npm_config_prefix ?? process.env.PREFIX;
    if (globalPrefix !== undefined) {
        anchors.push(join(globalPrefix, 'node_modules'));
        anchors.push(join(globalPrefix, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'));
    }
    if (process.env.DSH_HOME !== undefined) {
        anchors.push(join(process.env.DSH_HOME, 'profiles', 'node_modules'));
    }
    for (const anchor of anchors) {
        try {
            const resolved = require.resolve('electron', { paths: [anchor] });
            if (typeof resolved === 'string' && resolved.length > 0) {
                // electron's index.js is not the binary; find the dist executable
                // next to the package root.
                const exe = electronExeBeside(resolved);
                if (exe !== undefined)
                    return exe;
            }
        }
        catch {
            // continue probing
        }
    }
    // 3. pnpm virtual store, walking up from several candidate roots: this
    // module (its real path may differ from where the profile resolves it when
    // installed via a junction/link), the process CWD, and the Node executable
    // dir (DSH CLI typically runs from the workspace root).
    const roots = new Set([
        fileURLToPath(new URL('.', import.meta.url)),
        process.cwd(),
        dirname(process.execPath),
    ]);
    for (const root of roots) {
        let dir = root;
        for (let depth = 0; depth < 8; depth++) {
            const store = join(dir, 'node_modules', '.pnpm');
            if (existsSync(store)) {
                const exe = findElectronExe(store);
                if (exe !== undefined)
                    return exe;
            }
            const parent = join(dir, '..');
            if (parent === dir)
                break;
            dir = parent;
        }
    }
    // 4. Explicit override.
    const override = process.env.ELECTRON_PATH;
    if (typeof override === 'string' && override.length > 0 && existsSync(override))
        return override;
    throw new Error('dsh-builtin-browser: cannot locate the Electron binary. Install electron in the host profile ' +
        '(e.g. `dsh plugin --profile web add electron`) or set ELECTRON_PATH to the electron executable.');
}
/** From an electron package entry file, find the dist executable beside it. */
function electronExeBeside(entry) {
    const candidates = [
        join(dirname(entry), 'dist', 'electron.exe'),
        join(dirname(entry), 'dist', 'electron'),
        join(dirname(entry), '..', 'dist', 'electron.exe'),
        join(dirname(entry), '..', 'dist', 'electron'),
    ];
    for (const candidate of candidates) {
        if (existsSync(candidate))
            return candidate;
    }
    return undefined;
}
/** dirname without importing node:path's dirname separately. */
function dirname(p) {
    const i = p.lastIndexOf('/');
    const j = p.lastIndexOf('\\');
    const k = Math.max(i, j);
    return k < 0 ? p : p.slice(0, k);
}
/** Search a pnpm virtual store for an Electron dist binary. */
function findElectronExe(store) {
    const entries = existsSync(store) ? readdirSync(store) : [];
    for (const entry of entries) {
        if (!entry.startsWith('electron@'))
            continue;
        const candidates = [
            join(store, entry, 'node_modules', 'electron', 'dist', 'electron.exe'),
            join(store, entry, 'node_modules', 'electron', 'dist', 'electron'),
        ];
        for (const candidate of candidates) {
            if (existsSync(candidate))
                return candidate;
        }
    }
    return undefined;
}
/**
 * Line-delimited JSON-RPC client over a local TCP socket. Electron's main
 * process on Windows does not receive piped stdin, so the parent listens on a
 * loopback port and passes it to the child via `--rpc-port`; the child
 * connects back and speaks the same one-JSON-per-line protocol.
 */
class ElectronChildClient {
    hostMainPath;
    port;
    child;
    pending = new Map();
    nextId = 1;
    buffer = '';
    socket;
    connected = false;
    outbox = [];
    constructor(hostMainPath, port) {
        this.hostMainPath = hostMainPath;
        this.port = port;
        const electron = resolveElectronPath();
        // ELECTRON_RUN_AS_NODE (even an empty string) makes Electron run as plain
        // Node, breaking require('electron'); NODE_OPTIONS can inject flags that
        // break the child. Rebuild the env without either.
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        delete env.NODE_OPTIONS;
        this.child = spawn(electron, [hostMainPath, '--rpc-port', String(port)], {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: false,
            env,
        });
        this.child.stderr.setEncoding('utf8');
        this.child.stderr.on('data', chunk => {
            // Diagnostics only; never parse stderr as protocol.
            process.stderr.write(`[dsh-browser host] ${String(chunk)}`);
        });
        this.child.on('exit', (code, signal) => {
            const err = new Error(`dsh-builtin-browser: browser host exited (code=${String(code)} signal=${String(signal)})`);
            for (const pending of this.pending.values())
                pending.reject(err);
            this.pending.clear();
        });
    }
    /** Accept the child's connection (called by the server). */
    attach(socket) {
        this.socket = socket;
        this.connected = true;
        socket.setEncoding('utf8');
        socket.on('data', chunk => this.onData(chunk));
        socket.on('close', () => {
            this.connected = false;
            const err = new Error('dsh-builtin-browser: browser host connection closed');
            for (const pending of this.pending.values())
                pending.reject(err);
            this.pending.clear();
        });
        // Flush anything queued while disconnected.
        if (this.outbox.length > 0) {
            for (const line of this.outbox)
                socket.write(line + '\n');
            this.outbox = [];
        }
    }
    onData(chunk) {
        this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        let nl;
        while ((nl = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, nl).trim();
            this.buffer = this.buffer.slice(nl + 1);
            if (line === '')
                continue;
            let msg;
            try {
                msg = JSON.parse(line);
            }
            catch {
                // Non-protocol line; ignore.
                continue;
            }
            if (typeof msg.id !== 'number')
                continue;
            const pending = this.pending.get(msg.id);
            if (pending === undefined)
                continue;
            this.pending.delete(msg.id);
            if (msg.ok === true)
                pending.resolve(msg.result);
            else
                pending.reject(new Error(msg.err ?? 'browser host command failed'));
        }
    }
    /** Send one command and await the reply. */
    call(op, payload = {}) {
        const id = this.nextId++;
        const line = JSON.stringify({ id, op, ...payload });
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve: resolve, reject });
            if (this.connected && this.socket !== undefined) {
                this.socket.write(line + '\n');
            }
            else {
                // Not connected yet: queue; attach() flushes on the child's arrival.
                this.outbox.push(line);
            }
        });
    }
    /** Terminate the child. */
    kill() {
        try {
            this.socket?.destroy();
        }
        catch { /* already closed */ }
        this.child.kill();
    }
}
/** One view in the child: its id, used for every command. */
class RemoteView {
    id;
    client;
    constructor(id, client) {
        this.id = id;
        this.client = client;
    }
    sendCommand(method, params) {
        return this.client.call('command', {
            viewId: this.id,
            method,
            params: params ?? {},
        });
    }
    /** Ask the child to download a URL to a local file (keeps cookies/login). */
    async download(url, savePath) {
        const result = await this.client.call('download', { viewId: this.id, url, savePath });
        writeFileSync(savePath, Buffer.from(result.base64, 'base64'));
    }
    /** Export the session's cookies (login state). */
    flushAuth() {
        return this.client.call('flushAuth', { viewId: this.id }).then(r => r.cookies);
    }
    /** Import cookies into the session (restore login state). */
    restoreAuth(cookies) {
        return this.client.call('restoreAuth', { viewId: this.id, cookies }).then(r => r.restored);
    }
}
/**
 * Self-hosted view host: spawns the plugin's Electron child on first use and
 * keeps it alive until dispose(). Fallback when no desktop shell provides
 * ctx.electronViewHost.
 */
export class RemoteElectronViewHost {
    hostMainPath;
    client;
    server;
    pendingSocket;
    views = new Map();
    readyPromise;
    constructor(hostMainPath) {
        this.hostMainPath = hostMainPath;
    }
    /** Ensure the child is up and ready (lazy on first use). */
    ready() {
        if (this.readyPromise !== undefined)
            return this.readyPromise;
        this.readyPromise = this.start();
        return this.readyPromise;
    }
    async start() {
        // Listen on an ephemeral loopback port; the child connects back.
        const server = createServer(socket => {
            if (this.client !== undefined)
                this.client.attach(socket);
            else
                this.pendingSocket = socket;
        });
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => resolve());
        });
        const address = server.address();
        const port = typeof address === 'object' && address !== null ? address.port : 0;
        this.server = server;
        this.client = new ElectronChildClient(this.hostMainPath, port);
        if (this.pendingSocket !== undefined) {
            this.client.attach(this.pendingSocket);
            this.pendingSocket = undefined;
        }
        // Wait for the child's connection + readiness ping.
        await withTimeout(this.client.call('ping'), READY_TIMEOUT_MS, 'browser host did not become ready');
    }
    createView() {
        // The seam is synchronous; the provider uses the handle immediately, so
        // commands are deferred until the child is up and the view materialized.
        const id = `view:${Math.random().toString(36).slice(2, 10)}`;
        const view = new DeferredRemoteView(id, () => this.ensureView(id));
        this.views.set(id, view);
        return view;
    }
    async ensureView(id) {
        await this.ready();
        const client = this.client;
        if (client === undefined)
            throw new Error('browser host unavailable');
        await client.call('createView', { viewId: id });
        const view = new RemoteView(id, client);
        this.views.set(id, view);
        return view;
    }
    showView(handle) {
        void this.ready().then(() => this.client?.call('showView', { viewId: handle.id }));
    }
    destroyView(handle) {
        const view = this.views.get(handle.id);
        if (view === undefined)
            return;
        this.views.delete(handle.id);
        void this.ready()
            .then(() => this.client?.call('destroyView', { viewId: handle.id }))
            .catch(() => { });
    }
    /** Shut the child and the RPC server down. */
    dispose() {
        this.client?.kill();
        this.client = undefined;
        this.server?.close();
        this.server = undefined;
        this.readyPromise = undefined;
        this.views.clear();
    }
}
/** A view handle that waits for child readiness before issuing commands. */
class DeferredRemoteView {
    id;
    materialize;
    materialized;
    constructor(id, materialize) {
        this.id = id;
        this.materialize = materialize;
    }
    async sendCommand(method, params) {
        // Materialize once and cache: every sendCommand on the same handle must
        // target the SAME child view. Re-materializing would re-run createView
        // (duplicate window) and drop the established view.
        this.materialized ??= this.materialize();
        const view = await this.materialized;
        return view.sendCommand(method, params);
    }
    async download(url, savePath) {
        this.materialized ??= this.materialize();
        const view = await this.materialized;
        return view.download(url, savePath);
    }
    async flushAuth() {
        this.materialized ??= this.materialize();
        const view = await this.materialized;
        return view.flushAuth();
    }
    async restoreAuth(cookies) {
        this.materialized ??= this.materialize();
        const view = await this.materialized;
        return view.restoreAuth(cookies);
    }
}
/** Reject a promise if it does not settle within the budget. */
function withTimeout(promise, ms, message) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${message} (${ms}ms)`)), ms);
        promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
}
/** Default host-main path relative to this module's build output. */
export function defaultHostMainPath() {
    return fileURLToPath(new URL('./host-main.js', import.meta.url));
}
