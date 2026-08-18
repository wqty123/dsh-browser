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
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
/** How long to wait for the child to signal readiness before failing. */
const READY_TIMEOUT_MS = 20_000;
/** Safety cap on a single RPC reply line (base64 downloads are the big ones). */
const MAX_RPC_BUFFER_BYTES = 512 * 1024 * 1024;
/**
 * Locate the Electron binary:
 *   1. require('electron') from this module (optional peer dependency),
 *   2. ELECTRON_PATH (explicit override),
 *   3. every DSH install anchor + pnpm virtual store candidate, choosing the
 *      NEWEST version found. Older Electron releases (e.g. 33.x) have a
 *      compositor defect that intermittently breaks page capture, so prefer
 *      the newest binary available in the environment.
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
    // 2. Explicit override (user intent wins).
    const override = process.env.ELECTRON_PATH;
    if (typeof override === 'string' && override.length > 0 && existsSync(override))
        return override;
    // 3. Collect every candidate (anchors + pnpm stores), then pick the newest.
    const candidates = [];
    const add = (version, path) => {
        if (path !== undefined)
            candidates.push({ version, path });
    };
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
                add(versionOf(resolved), electronExeBeside(resolved));
            }
        }
        catch {
            // continue probing
        }
    }
    // Scan ONLY the plugin's own install tree (plus the explicit DSH anchors
    // above). Never cwd or the executable's directory: those can sit inside an
    // unrelated project whose node_modules may hold a different electron, and
    // executing the newest random binary in the filesystem is a supply-chain
    // hazard with no benefit.
    const roots = new Set([
        fileURLToPath(new URL('.', import.meta.url)),
    ]);
    for (const root of roots) {
        let dir = root;
        for (let depth = 0; depth < 8; depth++) {
            const store = join(dir, 'node_modules', '.pnpm');
            if (existsSync(store)) {
                for (const entry of readdirSync(store)) {
                    if (!entry.startsWith('electron@'))
                        continue;
                    const exe = electronDistExe(join(store, entry, 'node_modules', 'electron'));
                    add(entry.slice('electron@'.length), exe);
                }
            }
            const parent = join(dir, '..');
            if (parent === dir)
                break;
            dir = parent;
        }
    }
    if (candidates.length > 0) {
        candidates.sort((a, b) => compareVersions(b.version, a.version));
        const best = candidates[0];
        if (best !== undefined)
            return best.path;
    }
    throw new Error('dsh-builtin-browser: cannot locate the Electron binary. Install electron in the host profile ' +
        '(e.g. `dsh plugin --profile web add electron`) or set ELECTRON_PATH to the electron executable.');
}
/** Extract an electron version like "43.4.0" from a path containing it. */
function versionOf(path) {
    const match = /electron@(\d+\.\d+\.\d+)/.exec(path);
    return match?.[1] ?? '0.0.0';
}
/** Compare dotted numeric versions; higher wins. */
function compareVersions(a, b) {
    const pa = a.split('.').map(n => Number(n) || 0);
    const pb = b.split('.').map(n => Number(n) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0)
            return d;
    }
    return 0;
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
/** From an electron package root, find its dist executable. */
function electronDistExe(pkgRoot) {
    for (const candidate of [join(pkgRoot, 'dist', 'electron.exe'), join(pkgRoot, 'dist', 'electron')]) {
        if (existsSync(candidate))
            return candidate;
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
    token;
    onExit;
    onUserAction;
    child;
    pending = new Map();
    nextId = 1;
    buffer = '';
    socket;
    connected = false;
    outbox = [];
    /** Set once the child has exited; further calls fail fast instead of queueing. */
    dead = false;
    /**
     * True until the first message proves the child knows the spawn token.
     * Commands are queued (not written) until then, so a spoofed socket never
     * sees any traffic.
     */
    awaitingHello = true;
    helloTimer;
    constructor(hostMainPath, port, token, onExit, onUserAction) {
        this.hostMainPath = hostMainPath;
        this.port = port;
        this.token = token;
        this.onExit = onExit;
        this.onUserAction = onUserAction;
        const electron = resolveElectronPath();
        process.stderr.write(`[dsh-browser host] spawning electron: ${electron}\n`);
        // ELECTRON_RUN_AS_NODE (even an empty string) makes Electron run as plain
        // Node, breaking require('electron'); NODE_OPTIONS can inject flags that
        // break the child. Rebuild the env without either.
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        delete env.NODE_OPTIONS;
        this.child = spawn(electron, [hostMainPath, '--rpc-port', String(port)], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: false,
            env,
        });
        this.child.stderr.setEncoding('utf8');
        this.child.stderr.on('data', chunk => {
            // Diagnostics only; never parse stderr as protocol.
            process.stderr.write(`[dsh-browser host] ${String(chunk)}`);
        });
        // Send the spawn token over stdin (first line). The child reads it from
        // stdin instead of argv so the token is never visible in the process
        // listing (WMI / Process Explorer / /proc/*). After writing, close stdin
        // so the child knows the token has been fully delivered.
        this.child.stdin?.write(token + '\n');
        this.child.stdin?.end();
        // A failed spawn (bad/corrupt binary) emits 'error' — without a listener
        // that would crash the whole DSH process.
        this.child.on('error', error => {
            process.stderr.write(`[dsh-browser host] spawn error: ${String(error)}\n`);
            this.fail(new Error(`dsh-builtin-browser: browser host failed to start: ${String(error)}`));
        });
        this.child.on('exit', (code, signal) => {
            this.fail(new Error(`dsh-builtin-browser: browser host exited (code=${String(code)} signal=${String(signal)})`));
        });
    }
    /** Reject everything in flight, mark the client dead, and notify the host. */
    fail(err) {
        if (this.dead)
            return;
        this.dead = true;
        this.connected = false;
        for (const pending of this.pending.values())
            pending.reject(err);
        this.pending.clear();
        this.outbox = [];
        this.onExit?.();
    }
    /** Whether a connection (authenticated or still authenticating) is held. */
    isAttached() {
        return this.socket !== undefined;
    }
    /**
     * Accept the child's connection (called by the server). Exactly one socket
     * is ever attached; the server drops any further connection. Commands stay
     * queued until the child's first line authenticates with the spawn token.
     */
    attach(socket) {
        if (this.socket !== undefined) {
            // Already attached: this is a second connection; reject it.
            socket.destroy();
            return;
        }
        this.socket = socket;
        socket.setEncoding('utf8');
        // Without an 'error' listener a remote reset (ECONNRESET/EPIPE) throws an
        // uncaught 'error' event and crashes the whole DSH process; 'close' below
        // does the cleanup.
        socket.on('error', error => {
            process.stderr.write(`[dsh-browser host] socket error: ${String(error)}\n`);
        });
        socket.on('data', chunk => this.onData(chunk));
        socket.on('close', () => {
            this.connected = false;
            if (!this.dead) {
                this.fail(new Error('dsh-builtin-browser: browser host connection closed'));
            }
        });
        // The child must authenticate within the readiness budget; otherwise the
        // connection is treated as hostile and torn down.
        this.helloTimer = setTimeout(() => {
            if (this.awaitingHello) {
                socket.destroy();
                this.fail(new Error('dsh-builtin-browser: browser host did not authenticate'));
            }
        }, READY_TIMEOUT_MS);
    }
    onData(chunk) {
        this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        // Safety net: a pathological child (or a reply larger than expected)
        // must not grow the parent's memory without bound. The child caps
        // downloads at 256 MiB, so a healthy stream never approaches this.
        if (this.buffer.length > MAX_RPC_BUFFER_BYTES) {
            this.buffer = '';
            this.fail(new Error(`dsh-builtin-browser: RPC reply exceeded ${MAX_RPC_BUFFER_BYTES} bytes`));
            return;
        }
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
            if (msg.op === 'userAction') {
                // Fire-and-forget notification from the child's own UI (toolbar):
                // there is no reply and no pending id — route it straight to the
                // host's user-action handler (which the provider registered).
                this.onUserAction?.(msg.action);
                continue;
            }
            if (this.awaitingHello) {
                // The FIRST line must be the child's hello carrying the spawn token.
                // Anything else (or a wrong token) means a spoofed connection: drop
                // it and fail every pending call rather than trust the line.
                this.awaitingHello = false;
                if (this.helloTimer !== undefined) {
                    clearTimeout(this.helloTimer);
                    this.helloTimer = undefined;
                }
                if (msg.op !== 'hello' || msg.token !== this.token) {
                    this.socket?.destroy();
                    this.fail(new Error('dsh-builtin-browser: browser host authentication failed'));
                    return;
                }
                this.connected = true;
                // Flush anything queued while disconnected — now that the peer is
                // authenticated, it is safe to send commands.
                if (this.outbox.length > 0) {
                    for (const line of this.outbox)
                        this.socket?.write(line + '\n');
                    this.outbox = [];
                }
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
        if (this.dead) {
            return Promise.reject(new Error('dsh-builtin-browser: browser host is not running'));
        }
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
        // The child writes the file itself (temp + rename); only a small
        // confirmation crosses the RPC, so large downloads never balloon the
        // parent's memory or hit the single-line cap.
        await this.client.call('download', { viewId: this.id, url, savePath });
    }
    /** Native capturePage snapshot of the view (base64 + mime). */
    capture(opts) {
        return this.client.call('capture', { viewId: this.id, ...opts ?? {} });
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
    disposed = false;
    /** Cached probe result so `available()` stays cheap after the first call. */
    electronAvailable;
    /** Window groups (windowId per view), re-sent on every materialization so
     *  a restarted child still places views in the right windows. */
    groups = new Map();
    /** The provider's user-action handler; routes toolbar actions into sessions. */
    userActionHandler;
    constructor(hostMainPath) {
        this.hostMainPath = hostMainPath;
    }
    /**
     * Cheap usability probe: can we find an Electron binary to spawn? The scan
     * is filesystem-only (no network), per the seam's contract, and the result
     * is cached for the host's lifetime — a missing binary surfaces as
     * `BROWSER_PROVIDER_UNAVAILABLE` at provider selection instead of a
     * confusing spawn failure on first use.
     */
    available() {
        if (this.electronAvailable === undefined) {
            try {
                resolveElectronPath();
                this.electronAvailable = true;
            }
            catch {
                this.electronAvailable = false;
            }
        }
        return this.electronAvailable;
    }
    /** Ensure the child is up and ready (lazy on first use; restarts after a crash). */
    ready() {
        if (this.readyPromise !== undefined)
            return this.readyPromise;
        const started = this.start();
        const wrapped = started.catch(error => {
            // A failed startup must not poison the host forever: tear down whatever
            // was half-created and let the next call retry from scratch.
            if (this.readyPromise === wrapped) {
                this.readyPromise = undefined;
                this.client?.kill();
                this.client = undefined;
                this.server?.close();
                this.server = undefined;
                this.pendingSocket = undefined;
            }
            throw error;
        });
        this.readyPromise = wrapped;
        return wrapped;
    }
    async start() {
        // Listen on an ephemeral loopback port; the child connects back. The
        // server accepts exactly one connection: the child's. Any further
        // connection (a local process probing the port) is destroyed at once.
        const server = createServer(socket => {
            if (this.client !== undefined && this.client.isAttached()) {
                // A live child connection already exists — reject the extra one.
                socket.destroy();
                return;
            }
            if (this.client !== undefined) {
                // The child's first connection arrived after the client was created.
                this.client.attach(socket);
                return;
            }
            if (this.pendingSocket !== undefined) {
                // Only one connection may wait for the client; drop the older one.
                this.pendingSocket.destroy();
            }
            this.pendingSocket = socket;
        });
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => resolve());
        });
        // A later server error (rare on a loopback ephemeral port) must not crash
        // the process; the client's fail path handles the actual recovery.
        server.on('error', error => {
            process.stderr.write(`[dsh-browser host] rpc server error: ${String(error)}\n`);
        });
        const address = server.address();
        const port = typeof address === 'object' && address !== null ? address.port : 0;
        this.server = server;
        // Random per-spawn token: the child must prove knowledge of it (via
        // stdin hello) before any command is written to the socket.
        const token = randomBytes(24).toString('hex');
        this.client = new ElectronChildClient(this.hostMainPath, port, token, () => this.onChildExit(), action => this.userActionHandler?.(action));
        if (this.pendingSocket !== undefined) {
            this.client.attach(this.pendingSocket);
            this.pendingSocket = undefined;
        }
        // Wait for the child's connection + authentication + readiness ping. The
        // ping is queued until the hello authenticates, so a spoofed socket
        // never observes it.
        await withTimeout(this.client.call('ping'), READY_TIMEOUT_MS, 'browser host did not become ready');
    }
    /** The child died: tear down so the next use starts a fresh child. */
    onChildExit() {
        if (this.disposed)
            return;
        this.client = undefined;
        this.server?.close();
        this.server = undefined;
        this.pendingSocket = undefined;
        this.readyPromise = undefined;
        // Keep the views map: handles still resolve to ids; a fresh child simply
        // has no such views yet, and reset_session reopens clean sessions.
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
        // Re-send the window group before creating the view: the child routes the
        // view into its session's own window. Re-sending every materialization
        // also covers a child restart (the new child has no assignments yet).
        const group = this.groups.get(id);
        if (group !== undefined) {
            await client.call('groupView', { viewId: id, windowId: group.windowId, ...group.label !== undefined ? { label: group.label } : {} });
        }
        await client.call('createView', { viewId: id });
        // If the view was destroyed while the createView RPC was in flight, do
        // not re-insert a stale entry that would resurrect a dead child view.
        if (this.views.get(id) === undefined) {
            throw new Error('browser: view destroyed while starting');
        }
        const view = new RemoteView(id, client);
        this.views.set(id, view);
        return view;
    }
    showView(handle, label) {
        // Fire-and-forget by design (visibility is best-effort), but a rejected
        // promise must not become an unhandled rejection (crash on Node >= 15).
        // The label (session/task id) rides along so the child can show it in the
        // window title — a human can then tell which task's page is visible.
        void this.ready()
            .then(() => this.client?.call('showView', { viewId: handle.id, ...label !== undefined ? { label } : {} }))
            .catch(() => { });
    }
    /** Route a view into its session's own window (one window per session). */
    groupView(handle, windowId, label) {
        this.groups.set(handle.id, { windowId, ...label !== undefined ? { label } : {} });
        // Fire-and-forget: the child may not exist yet; ensureView re-sends the
        // group before every createView anyway.
        void this.ready()
            .then(() => this.client?.call('groupView', { viewId: handle.id, windowId, ...label !== undefined ? { label } : {} }))
            .catch(() => { });
    }
    /** Register the provider's handler for user-initiated toolbar actions. */
    onUserAction(handler) {
        this.userActionHandler = handler;
    }
    /** Surface a failed user action to the child's toolbar (address bar etc.). */
    notifyUserActionError(windowId, message) {
        void this.ready()
            .then(() => this.client?.call('userActionError', { windowId, message }))
            .catch(() => { });
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
        this.disposed = true;
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
    /**
     * Materialize once and cache: every sendCommand on the same handle must
     * target the SAME child view (re-materializing would re-run createView and
     * duplicate the window). A FAILED materialization is reset so a later call
     * (e.g. after the host restarted) can retry instead of being poisoned.
     */
    materializeOnce() {
        if (this.materialized === undefined) {
            const pending = this.materialize();
            this.materialized = pending.catch(error => {
                if (this.materialized === pending)
                    this.materialized = undefined;
                throw error;
            });
        }
        return this.materialized;
    }
    async sendCommand(method, params) {
        const view = await this.materializeOnce();
        return view.sendCommand(method, params);
    }
    async download(url, savePath) {
        const view = await this.materializeOnce();
        return view.download(url, savePath);
    }
    async capture(opts) {
        const view = await this.materializeOnce();
        return view.capture(opts);
    }
    async flushAuth() {
        const view = await this.materializeOnce();
        return view.flushAuth();
    }
    async restoreAuth(cookies) {
        const view = await this.materializeOnce();
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
