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
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
/** How long to wait for the child to signal readiness before failing. */
const READY_TIMEOUT_MS = 20_000;
/** Safety cap on a single RPC reply line (base64 downloads are the big ones). */
const MAX_RPC_BUFFER_BYTES = 512 * 1024 * 1024;
function resolveElectronPath() {
    return resolveElectronPathImpl({
        override: process.env.ELECTRON_PATH,
        inElectron: typeof process.versions.electron === 'string',
        execPath: process.execPath,
        bundled: bundledElectronBinary,
        anchored: anchoredElectronBinary,
        ancestry: hostElectronViaProcessTree,
    });
}
/**
 * Pure selection over the discovery probes, in order:
 *   0. override (user intent) → 1. bundled package → 2. anchors (newest) →
 *   3. in-process BARE host → 4. process ancestry → throw.
 * Packaged app executables are never reused (steps 3/4 skip them).
 */
function resolveElectronPathImpl(inputs) {
    // 0. Explicit override first: a user-set ELECTRON_PATH is a deliberate
    //    choice and must beat every auto-discovery (including the bundled
    //    package) — auto-discovery is a fallback, not an override.
    const override = inputs.override;
    if (typeof override === 'string' && override.length > 0 && existsSync(override))
        return override;
    // 1. The plugin's own electron package (filesystem probe). Never require():
    //    inside an Electron main process require('electron') is the built-in
    //    API module, not the npm package, and electron 44+ downloads its binary
    //    on first require — probing must stay side-effect free (available()
    //    would otherwise block DSH startup on the download).
    const bundled = inputs.bundled();
    if (bundled !== undefined)
        return bundled;
    // 2. DSH install anchors, newest wins. (The plugin's own tree — plain and
    //    pnpm store layouts — was already scanned in step 1; the anchors cover
    //    electron installed separately, e.g. `dsh plugin add electron` into the
    //    profile or a global prefix.)
    const anchored = inputs.anchored();
    if (anchored !== undefined)
        return anchored;
    // 3. The current process IS a bare Electron (dev hosts, e.g. `electron .`):
    //    reuse the host binary — it cannot be missing because we are running on
    //    it. A PACKAGED app executable (resources/app.asar beside it, e.g. DSH
    //    Desktop.exe) is NOT spawnable as bare electron: it ignores the script
    //    argument, launches the app itself, and typically exits immediately
    //    (single-instance lock) — so it is never reused.
    if (inputs.inElectron) {
        const exe = inputs.execPath;
        if (typeof exe === 'string' && exe.length > 0 && existsSync(exe) && isBareElectron(exe))
            return exe;
    }
    // 4. Last resort for bare-Electron hosts: walk the process ancestry (the
    //    plugin may run in a child Node process of an Electron main process).
    const hostExe = inputs.ancestry();
    if (hostExe !== undefined)
        return hostExe;
    throw new Error('dsh-builtin-browser: cannot locate a spawnable Electron binary. ' +
        'The electron package ships with the plugin (0.1.18+); Electron 44+ downloads its binary on first use, ' +
        'so if the package is installed but the binary is missing, run `npx install-electron` once (needs network) ' +
        'in the profile that installed the plugin, then retry. Alternatively set ELECTRON_PATH to an electron ' +
        'executable. On installs from before electron became a dependency, add it to the active profile ' +
        '(`dsh plugin --profile <your-profile> add electron`; on DSH Desktop the profile is `desktop`). ' +
        'Note: the host\'s own executable cannot be reused when it is a packaged Electron app (e.g. DSH Desktop.exe) ' +
        '— only a real electron binary can be spawned.');
}
/** DSH install anchors: electron installed separately (profile / global prefix), newest wins. */
function anchoredElectronBinary() {
    const require = createRequire(import.meta.url);
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
            // Inside an Electron main process resolve('electron') yields the
            // built-in module NAME (not a path) — requiring an absolute path keeps
            // electronExeBeside from probing cwd-relative garbage like ./dist/.
            if (typeof resolved === 'string' && resolved.length > 0 && isAbsolute(resolved)) {
                add(versionOf(resolved), electronExeBeside(resolved));
            }
        }
        catch {
            // continue probing
        }
    }
    return pickNewest(candidates);
}
/**
 * The plugin's own electron package binary, found by a pure filesystem walk
 * (never require(), whose semantics differ inside an Electron main process —
 * there `require('electron')` is the built-in API module, not the npm package
 * — and which would trigger electron 44+'s lazy binary download when the dist
 * is missing). Checks every `node_modules/electron` above this module,
 * including pnpm virtual-store layouts, and returns the NEWEST ready binary.
 * Scan ONLY the plugin's own install tree: never cwd or the executable's
 * directory, which can sit inside an unrelated project whose node_modules may
 * hold a different electron (executing the newest random binary in the
 * filesystem is a supply-chain hazard with no benefit).
 */
function bundledElectronBinary() {
    const candidates = [];
    const consider = (pkgRoot, versionHint) => {
        const exe = electronDistExe(pkgRoot);
        if (exe !== undefined)
            candidates.push({ version: versionHint || pkgVersion(pkgRoot), path: exe });
    };
    let dir = fileURLToPath(new URL('.', import.meta.url));
    for (let depth = 0; depth < 8; depth++) {
        // Plain (npm/yarn, hoisted) layout: <ancestor>/node_modules/electron.
        const plain = join(dir, 'node_modules', 'electron');
        if (existsSync(join(plain, 'package.json')))
            consider(plain, '');
        // pnpm layout: <ancestor>/node_modules/.pnpm or <ancestor>/.pnpm, with
        // electron@<version>/node_modules/electron entries.
        for (const storeRoot of [join(dir, 'node_modules', '.pnpm'), join(dir, '.pnpm')]) {
            if (!existsSync(storeRoot))
                continue;
            for (const entry of readdirSync(storeRoot)) {
                if (!entry.startsWith('electron@'))
                    continue;
                const pkg = join(storeRoot, entry, 'node_modules', 'electron');
                // Strip pnpm's peer-dependency suffix (electron@44.0.0_@types+node@22).
                if (existsSync(join(pkg, 'package.json')))
                    consider(pkg, entry.slice('electron@'.length).split('_')[0]);
            }
        }
        const parent = join(dir, '..');
        if (parent === dir)
            break;
        dir = parent;
    }
    return pickNewest(candidates);
}
/** The electron version from a package root's package.json, or '0.0.0'. */
function pkgVersion(pkgRoot) {
    try {
        const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
        return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : '0.0.0';
    }
    catch {
        return '0.0.0';
    }
}
/** The highest-versioned candidate's path, or undefined when none. */
function pickNewest(candidates) {
    let best;
    for (const c of candidates) {
        if (best === undefined || compareVersions(c.version, best.version) > 0)
            best = c;
    }
    return best?.path;
}
/**
 * Last-resort Electron discovery: walk this process's ancestry looking for a
 * parent process whose executable is a BARE Electron binary (only bare
 * electron can be spawned with a script argument). Covers hosts that run the
 * plugin in a child Node process of their own Electron main process: the host
 * binary is already on disk and running, so reusing it needs no extra
 * install. Filesystem-only on POSIX (/proc); on Windows a best-effort
 * PowerShell CIM query is used — this path only runs when every other lookup
 * failed, so its latency never touches the happy path, and a
 * missing/blocked powershell simply yields nothing.
 */
function hostElectronViaProcessTree() {
    let pid = process.ppid;
    for (let depth = 0; depth < 6 && pid !== undefined && pid > 1; depth++) {
        const exe = processExecutable(pid);
        if (exe !== undefined && isBareElectron(exe))
            return exe;
        pid = processParent(pid);
    }
    return undefined;
}
/** The executable path of a running process, or undefined when unknown. */
function processExecutable(pid) {
    try {
        if (process.platform === 'win32') {
            const out = execFileSync('powershell.exe', [
                '-NoProfile', '-NonInteractive', '-Command',
                `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ExecutablePath`,
            ], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
            const line = out.trim().split(/\r?\n/)[0] ?? '';
            return line.length > 0 ? line : undefined;
        }
        const exe = readlinkSync(`/proc/${pid}/exe`);
        return exe.length > 0 ? exe : undefined;
    }
    catch {
        return undefined;
    }
}
/** The parent pid of a running process, or undefined when unknown. */
function processParent(pid) {
    try {
        if (process.platform === 'win32') {
            const out = execFileSync('powershell.exe', [
                '-NoProfile', '-NonInteractive', '-Command',
                `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`,
            ], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
            const n = Number(out.trim().split(/\r?\n/)[0]);
            return Number.isInteger(n) && n > 1 ? n : undefined;
        }
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        // Format: pid (comm) state ppid ... — comm is parenthesized and may
        // itself contain spaces/parens, so parse from the LAST ')'; ppid is the
        // second field after it.
        const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
        const n = Number(fields[1]);
        return Number.isInteger(n) && n > 1 ? n : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * True when the given executable is an Electron binary. The name match
 * covers dev binaries (electron, electron.exe); the resources marker covers
 * packaged apps whose exe carries the product name (e.g. "DSH Desktop.exe") —
 * every Electron distribution ships `resources/electron.asar`,
 * `resources/app.asar`, or `resources/default_app.asar` beside the binary.
 */
function isElectronBinary(exe) {
    if (basename(exe).toLowerCase().includes('electron'))
        return true;
    const resources = join(dirname(exe), 'resources');
    return existsSync(join(resources, 'electron.asar'))
        || existsSync(join(resources, 'app.asar'))
        || existsSync(join(resources, 'default_app.asar'));
}
/**
 * True when the executable is a BARE (unpackaged) Electron that can be
 * spawned with a script argument (`exe script.js --rpc-port N`). Packaged
 * apps carry their code inside a resources dir (`app.asar`, or an unpacked
 * `app` dir) and are NOT spawnable as bare electron: they ignore the script
 * argument and launch the app itself, typically exiting immediately via the
 * single-instance lock — spawning e.g. DSH Desktop.exe is exactly the
 * "browser host exited (code=0)" failure. A portable single-file build (no
 * resources dir at all) likewise cannot run a script argument.
 */
function isBareElectron(exe) {
    const dir = dirname(exe);
    // Windows/Linux keep resources beside the binary; macOS app bundles keep
    // them in Contents/Resources, one level above the binary's MacOS dir.
    const resourcesList = process.platform === 'darwin'
        ? [join(dir, '..', 'Resources'), join(dir, 'resources')]
        : [join(dir, 'resources')];
    for (const resources of resourcesList) {
        if (existsSync(join(resources, 'app.asar')) || existsSync(join(resources, 'app')))
            return false;
    }
    // A real electron always ships a resources dir somewhere; requiring one
    // keeps every not-actually-spawnable layout out.
    if (!resourcesList.some(p => existsSync(p)))
        return false;
    return isElectronBinary(exe);
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
 * Thrown whenever the browser host (the Electron child) is gone — it exited,
 * failed to start, or its RPC connection dropped. Operations against a dead
 * host can never succeed, so the view layer treats this as "rebuild against a
 * fresh host" instead of a page-level error. Kept module-private: callers
 * observe the behavior (auto-restart), not the class.
 */
class HostGoneError extends Error {
    constructor(message) {
        super(message);
        this.name = 'HostGoneError';
    }
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
    executable;
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
    constructor(hostMainPath, port, token, onExit, onUserAction, 
    /** Test seam: the executable to spawn instead of the resolved Electron
     *  binary. Absent -> resolveElectronPath() (production behavior). */
    executable) {
        this.hostMainPath = hostMainPath;
        this.port = port;
        this.token = token;
        this.onExit = onExit;
        this.onUserAction = onUserAction;
        this.executable = executable;
        const electron = this.executable ?? resolveElectronPath();
        process.stderr.write(`[dsh-browser host] spawning electron: ${electron}\n`);
        // ELECTRON_RUN_AS_NODE (even an empty string) makes Electron run as plain
        // Node, breaking require('electron'); NODE_OPTIONS can inject flags that
        // break the child. Rebuild the env without either.
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        delete env.NODE_OPTIONS;
        // Windows GUI-subsystem processes (Electron included) never receive piped
        // stdin, so the token written below is silently lost there. Pass it as an
        // environment variable too (hidden from the process-listing tools that
        // expose argv, and preferred over stdin only when stdin cannot deliver):
        // the child reads env only as a fallback after stdin yields nothing.
        env.DSH_BROWSER_RPC_TOKEN = token;
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
        // Tag every failure as "host gone" so the view layer can tell a dead host
        // apart from a page-level error and rebuild against a fresh child.
        const wrapped = err instanceof HostGoneError ? err : new HostGoneError(err.message);
        for (const pending of this.pending.values())
            pending.reject(wrapped);
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
            return Promise.reject(new HostGoneError('dsh-builtin-browser: browser host is not running'));
        }
        const id = this.nextId++;
        const line = JSON.stringify({ id, op, ...payload });
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve: resolve, reject });
            if (this.connected && this.socket !== undefined) {
                try {
                    this.socket.write(line + '\n');
                }
                catch {
                    // The socket died between the dead check and the write; the 'close'
                    // handler fails the rest. Reject THIS call as host-gone so the
                    // caller can recover immediately instead of hanging.
                    this.pending.delete(id);
                    reject(new HostGoneError('dsh-builtin-browser: browser host connection closed'));
                }
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
    spawnExecutable;
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
    constructor(hostMainPath, 
    /** Test seam: the executable to spawn instead of the resolved Electron
     *  binary. Absent -> resolveElectronPath() (production behavior). */
    spawnExecutable) {
        this.hostMainPath = hostMainPath;
        this.spawnExecutable = spawnExecutable;
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
            catch (error) {
                this.electronAvailable = false;
                // The provider will be reported unavailable, so the detailed
                // resolution error (install-electron / ELECTRON_PATH guidance) would
                // otherwise never reach the user — surface it on stderr.
                process.stderr.write(`[dsh-browser host] electron unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
            }
        }
        return this.electronAvailable;
    }
    /** Ensure the child is up and ready (lazy on first use; restarts after a crash). */
    ready() {
        // Fail fast on a disposed host: a recovery path can re-enter ready() after
        // dispose() cleared its state, and starting fresh here would spawn a child
        // nobody will ever kill.
        if (this.disposed)
            throw new HostGoneError('browser host disposed');
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
                this.pendingSocket?.destroy();
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
        this.client = new ElectronChildClient(this.hostMainPath, port, token, () => this.onChildExit(), action => this.userActionHandler?.(action), this.spawnExecutable);
        if (this.pendingSocket !== undefined) {
            this.client.attach(this.pendingSocket);
            this.pendingSocket = undefined;
        }
        // dispose() can race this spawn (it may run while start() is suspended
        // between the listen and the client creation): re-check here so a host
        // that was torn down mid-start does not leak a child nobody will kill.
        if (this.disposed) {
            this.client.kill();
            this.client = undefined;
            try {
                server.close();
            }
            catch { /* already closed */ }
            if (this.server === server)
                this.server = undefined;
            throw new HostGoneError('browser host disposed');
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
        process.stderr.write('[dsh-browser host] browser host gone; will restart on next use\n');
        this.client = undefined;
        this.server?.close();
        this.server = undefined;
        this.pendingSocket?.destroy();
        this.pendingSocket = undefined;
        this.readyPromise = undefined;
        // Keep the views map: handles still resolve to ids, and
        // DeferredRemoteView re-materializes them against the fresh child on
        // their next use — sessions opened before the crash stay usable instead
        // of going stale (only the page state is lost).
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
        // A rebuild in flight during dispose() must not spawn a fresh child that
        // would then outlive the host (a zombie window nobody disposes).
        if (this.disposed)
            throw new HostGoneError('browser host disposed');
        await this.ready();
        // dispose() may have landed while the host was starting (ready() resolved
        // after dispose cleared its state): never materialize into a dead host.
        if (this.disposed)
            throw new HostGoneError('browser host disposed');
        const client = this.client;
        if (client === undefined)
            throw new HostGoneError('browser host unavailable');
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
        this.pendingSocket?.destroy();
        this.pendingSocket = undefined;
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
     * Materialize once and cache: every operation on the same handle must
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
    /**
     * Run one operation against this view's backing child, automatically
     * recovering from a dead host. The cached materialization is bound to the
     * child it was created on; once that child is gone (exited, crashed, or its
     * connection dropped — e.g. the DSH process that spawned it was restarted),
     * any further operation on the same handle would otherwise fail forever
     * with "browser host is not running". Instead: drop the cache, rebuild the
     * view against a freshly spawned child, and retry the operation exactly
     * once — so sessions that survive a host death self-heal on their FIRST
     * call after it, without a manual browser_reset_session. Page-level errors
     * are never retried (the view itself is fine).
     */
    async withRecovery(op) {
        try {
            const view = await this.materializeOnce();
            return await op(view);
        }
        catch (error) {
            if (!(error instanceof HostGoneError))
                throw error;
            // The backing child is gone: a retry on the same materialization can
            // never succeed. Rebuild against a fresh child and retry once; a second
            // failure (fresh host also failing to start) surfaces to the caller.
            this.materialized = undefined;
            const fresh = await this.materializeOnce();
            return op(fresh);
        }
    }
    async sendCommand(method, params) {
        return this.withRecovery(view => view.sendCommand(method, params));
    }
    async download(url, savePath) {
        return this.withRecovery(view => view.download(url, savePath));
    }
    async capture(opts) {
        return this.withRecovery(view => view.capture(opts));
    }
    async flushAuth() {
        return this.withRecovery(view => view.flushAuth());
    }
    async restoreAuth(cookies) {
        return this.withRecovery(view => view.restoreAuth(cookies));
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
/**
 * Test/diagnostic hooks (mirrors tool-browser's `internals` convention).
 * `isBareElectron` is the packaged-app discriminator behind the host-reuse
 * steps; `resolveElectronPath` is the full resolution order.
 */
export const internals = {
    isBareElectron,
    resolveElectronPath,
    resolveElectronPathImpl,
};
