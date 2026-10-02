/**
 * Drive the browser the user already has (Chrome / Edge / any Chromium) instead of
 * the Electron we ship — the same approach Codex Browser Use takes.
 *
 * WHY
 * The bundled Electron is a private copy with its own profile, so it can never see
 * the logins the user already has in Chrome, and on a managed machine the user may
 * simply prefer their own browser. Launching their browser with a *separate*
 * `--user-data-dir` gives us a real Chromium we can drive over CDP without touching
 * their everyday profile, bookmarks or windows: nothing of theirs is opened, locked
 * or modified, and closing us never closes them.
 *
 * HOW
 * Chromium exposes CDP on `--remote-debugging-port=0`, and writes the port it chose
 * into `<profile>/DevToolsActivePort`. That file is the discovery mechanism — no
 * port guessing, no collisions. From there everything is CDP over one WebSocket:
 * `Target.createTarget` makes a page, `Target.attachToTarget` (flattened) gives a
 * session for it, and the plugin's commands ride that session. Node 22 ships a global
 * `WebSocket`, so this needs no dependency at all.
 *
 * WHAT IT IMPLEMENTS
 * The same `ElectronBrowserViewHost` seam as the self-hosted and sidebar hosts, so
 * the provider, the tools, history, the cursor and teardown rules are unchanged —
 * only the carrier differs.
 * @module dsh-browser/browser-electron/system-browser
 */
import { readFileSync, rmSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
/**
 * Launcher names to look for on PATH, per product and per platform.
 *
 * The names genuinely differ: Linux distributions package the launcher under a
 * versioned name (`microsoft-edge-stable`, `google-chrome-stable`), Windows puts
 * `chrome.exe` in an Application directory that may or may not be on PATH, and macOS
 * ships the executable inside the .app bundle. PATH is still consulted first on every
 * platform — it is what reflects how the user actually installed the browser.
 */
const PATH_NAMES = {
    chrome: {
        win32: ['chrome'],
        darwin: ['Google Chrome', 'Chromium'],
        linux: ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'],
    },
    edge: {
        win32: ['msedge'],
        darwin: ['Microsoft Edge'],
        linux: ['microsoft-edge-stable', 'microsoft-edge', 'microsoft-edge-dev'],
    },
    brave: {
        win32: ['brave'],
        darwin: ['Brave Browser'],
        linux: ['brave-browser', 'brave'],
    },
};
/**
 * Where each product installs when its launcher is not on PATH.
 *
 * Windows keeps the executable inside a version-less Application directory; macOS
 * keeps it inside the .app bundle; Linux distributions that do not use a launcher
 * put it under /usr/bin or /opt. All are checked, and anything missed can be named
 * explicitly with DSH_BROWSER_<KIND>_PATH.
 */
const INSTALL_LOCATIONS = {
    chrome: {
        win32: [
            String.raw `C:\Program Files\Google\Chrome\Application\chrome.exe`,
            String.raw `C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`,
        ],
        darwin: [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ],
        linux: [
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome',
            '/usr/bin/chromium',
            '/opt/google/chrome/chrome',
            '/snap/bin/chromium',
        ],
    },
    edge: {
        win32: [
            String.raw `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
            String.raw `C:\Program Files\Microsoft\Edge\Application\msedge.exe`,
        ],
        darwin: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
        linux: [
            '/usr/bin/microsoft-edge-stable',
            '/usr/bin/microsoft-edge',
            '/usr/bin/microsoft-edge-dev',
        ],
    },
    brave: {
        win32: [
            String.raw `C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe`,
            String.raw `C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe`,
        ],
        darwin: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
        linux: ['/usr/bin/brave-browser', '/usr/bin/brave', '/snap/bin/brave'],
    },
};
/**
 * Find an executable by name on PATH.
 *
 * PATH is read from the supplied environment rather than the process's own, so the
 * detection stays testable. On Windows a bare name needs its extension; elsewhere
 * the launcher is the file itself.
 * @param names - candidate launcher names, in preference order.
 * @param env - the environment to read PATH from.
 * @param platform - the platform whose PATH and extension conventions apply.
 * @returns the first existing absolute path, or undefined.
 */
function findOnPath(names, env, platform) {
    // Windows spells it Path as often as PATH; the separator differs too.
    const raw = env.PATH ?? env.Path ?? env.path ?? '';
    const separator = platform === 'win32' ? ';' : ':';
    const directories = raw.split(separator).map(entry => entry.trim()).filter(entry => entry !== '');
    const suffixes = platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
    for (const name of names) {
        for (const directory of directories) {
            for (const suffix of suffixes) {
                const candidate = join(directory, `${name}${suffix}`);
                if (existsSync(candidate))
                    return candidate;
            }
        }
    }
    return undefined;
}
/**
 * Find an installed Chromium browser.
 *
 * `auto` prefers Chrome, then Edge, then Brave — the order reflects how likely each
 * is to be the browser a user actually chose rather than one the system shipped.
 * Each candidate is looked up in three places, most specific first: an explicit
 * environment override, then PATH, then the platform's conventional install
 * locations. PATH comes before the fixed paths because it is what actually reflects
 * how the browser was installed.
 * @param channel - the configured choice; `bundled` never resolves to a system browser.
 * @param env - environment lookup, injected so tests need no real machine.
 * @param platform - the platform to use conventions for; injected for the same reason.
 * @returns the detected browser, or undefined when the choice is unavailable.
 */
export function detectBrowser(channel, env = process.env, platform = process.platform) {
    if (channel === 'bundled')
        return undefined;
    const order = channel === 'auto' ? ['chrome', 'edge', 'brave'] : [channel];
    for (const kind of order) {
        const fromEnv = (kind === 'chrome' ? env.DSH_BROWSER_CHROME_PATH : kind === 'edge' ? env.DSH_BROWSER_EDGE_PATH : undefined);
        if (fromEnv !== undefined && fromEnv !== '' && existsSync(fromEnv))
            return { kind, path: fromEnv };
        const onPath = findOnPath(PATH_NAMES[kind]?.[platform] ?? [], env, platform);
        if (onPath !== undefined)
            return { kind, path: onPath };
        for (const candidate of INSTALL_LOCATIONS[kind]?.[platform] ?? []) {
            if (existsSync(candidate))
                return { kind, path: candidate };
        }
    }
    return undefined;
}
/**
 * Everything that was checked for one product, for reporting a miss.
 *
 * Detection returns undefined with no explanation, which left the caller able to say
 * only "not found". This gives the user the actual list so they can see whether the
 * plugin looked somewhere their browser is not.
 * @param kind - the product to describe.
 * @param platform - the platform whose names and locations apply.
 * @returns the launcher names (as PATH lookups) and the fixed locations checked.
 */
export function searchSummary(kind, platform = process.platform) {
    const onPath = (PATH_NAMES[kind]?.[platform] ?? []).map(name => `${name} (on PATH)`);
    const located = INSTALL_LOCATIONS[kind]?.[platform] ?? [];
    return [...onPath, ...located];
}
/** One CDP connection to a browser-level WebSocket, with flattened sessions. */
class CdpClient {
    nextId = 1;
    pending = new Map();
    ready;
    /**
     * @param url - the browser's `webSocketDebuggerUrl`.
     */
    constructor(url) {
        // Node 22 provides WebSocket globally; no dependency is added for this.
        const socket = new WebSocket(url);
        this.socket = socket;
        this.ready = new Promise((resolve, reject) => {
            socket.addEventListener('open', () => resolve());
            socket.addEventListener('error', () => reject(new Error('dsh-builtin-browser: could not reach the browser over CDP')));
        });
        socket.addEventListener('message', event => this.onMessage(String(event.data)));
        socket.addEventListener('close', () => this.fail(new Error('dsh-builtin-browser: the browser closed the CDP connection')));
    }
    socket;
    /** Resolve once the socket is open. */
    async whenReady() {
        await this.ready;
    }
    /**
     * Send one CDP command, optionally on an attached session.
     * @param method - the CDP method.
     * @param params - its parameters.
     * @param sessionId - the flattened session to target, when this is a page command.
     * @returns the CDP result.
     */
    async send(method, params, sessionId) {
        await this.ready;
        const id = this.nextId++;
        const message = { id, method, ...params !== undefined ? { params } : {}, ...sessionId !== undefined ? { sessionId } : {} };
        return await new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.socket.send(JSON.stringify(message));
            setTimeout(() => {
                if (this.pending.delete(id))
                    reject(new Error(`dsh-builtin-browser: ${method} timed out`));
            }, 30_000).unref?.();
        });
    }
    /** Close the socket. */
    close() {
        try {
            this.socket.close();
        }
        catch { /* already closed */ }
    }
    /** Route one CDP message to its waiter. */
    onMessage(raw) {
        let message;
        try {
            message = JSON.parse(raw);
        }
        catch {
            return;
        }
        if (message.id === undefined)
            return;
        const entry = this.pending.get(message.id);
        if (entry === undefined)
            return;
        this.pending.delete(message.id);
        if (message.error !== undefined)
            entry.reject(new Error(`dsh-builtin-browser: CDP error: ${message.error.message ?? 'unknown'}`));
        else
            entry.resolve(message.result);
    }
    /** Fail everything in flight. */
    fail(error) {
        const pending = [...this.pending.values()];
        this.pending.clear();
        for (const entry of pending)
            entry.reject(error);
    }
}
/** A system browser driven over CDP, presented as a browser view host. */
export class SystemBrowserViewHost {
    browser;
    profileDir;
    extraArgs;
    ephemeralDir;
    views = new Map();
    disposed = false;
    /**
     * The browser is started on FIRST USE, never on construction.
     *
     * A plugin that launches Chrome the moment its host loads is a plugin that takes
     * over the machine before anyone asked it to: simply starting DSH would spawn a
     * browser window. Registration must therefore be inert, and the process is only
     * spawned when a view is actually needed.
     */
    client;
    child;
    starting;
    /**
     * @param browser - the detected installation to launch on first use.
     * @param profileDir - a plugin-owned directory; the user's own profile is never touched.
     * @param extraArgs - additional Chromium switches.
     * @param ephemeralDir - a directory to delete on release, when the user has turned
     *   persistence off so no login state outlives the session.
     */
    constructor(browser, profileDir, extraArgs = [], ephemeralDir) {
        this.browser = browser;
        this.profileDir = profileDir;
        this.extraArgs = extraArgs;
        this.ephemeralDir = ephemeralDir;
    }
    /** Which product this host would drive (for diagnostics). */
    get kind() {
        return this.browser.kind;
    }
    /** Whether the browser has actually been started yet (diagnostics and tests). */
    get started() {
        return this.child !== undefined;
    }
    /**
     * The CDP client, starting the browser on first use.
     * @returns the connected client.
     */
    async ensureClient() {
        // A disposed host must never start a browser: doing so would spawn a process
        // nobody owns and nobody will kill.
        if (this.disposed)
            throw new Error('dsh-builtin-browser: this browser host was released');
        if (this.client !== undefined)
            return this.client;
        // Concurrent first calls share one startup rather than racing two browsers.
        this.starting ??= this.start().finally(() => { this.starting = undefined; });
        return await this.starting;
    }
    /**
     * Launch the browser with a private profile and connect over CDP.
     *
     * `--remote-debugging-port=0` plus the `DevToolsActivePort` file is the only
     * reliable way to learn the port: a fixed port collides with whatever else the
     * machine is running, and parsing stderr is fragile across versions.
     * @returns the connected client.
     */
    async start() {
        const args = [
            '--remote-debugging-port=0',
            `--user-data-dir=${this.profileDir}`,
            // Behave like a fresh, unattended browser: no first-run UI, no default-browser
            // prompt, no restore bubble, and no "Chrome is being controlled" infobar.
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-features=Translate,MediaRouter',
            '--disable-session-crashed-bubble',
            '--hide-crash-restore-bubble',
            ...this.extraArgs,
            'about:blank',
        ];
        const child = spawn(this.browser.path, args, { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: false });
        this.child = child;
        const portFile = join(this.profileDir, 'DevToolsActivePort');
        const deadline = Date.now() + 30_000;
        for (;;) {
            // Released while we were starting: stop here rather than keep polling for a
            // browser that dispose() has already killed, which would leave a connection
            // to a dead process behind.
            if (this.disposed) {
                child.kill();
                if (this.child === child)
                    this.child = undefined;
                break;
            }
            if (Date.now() > deadline) {
                child.kill();
                if (this.child === child)
                    this.child = undefined;
                break;
            }
            if (child.exitCode !== null) {
                if (this.child === child)
                    this.child = undefined;
                break;
            }
            if (existsSync(portFile)) {
                try {
                    const port = readFileSync(portFile, 'utf8').split('\n')[0]?.trim() ?? '';
                    if (port !== '') {
                        const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
                        if (typeof version.webSocketDebuggerUrl === 'string') {
                            const client = new CdpClient(version.webSocketDebuggerUrl);
                            await client.whenReady();
                            // Still wanted? A dispose() during the handshake has already killed the
                            // process, so publishing the client would leave a dangling connection.
                            if (this.disposed) {
                                client.close();
                                break;
                            }
                            this.client = client;
                            return client;
                        }
                    }
                }
                catch {
                    // The file can exist a moment before the port answers; poll again.
                }
            }
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        throw new Error(`dsh-builtin-browser: ${this.browser.kind} did not expose CDP within 30s (${this.browser.path})`);
    }
    /**
     * Whether this host can back views.
     *
     * True while the host is usable — including before the browser has been started,
     * since the first command is what starts it. Reporting "unavailable" here would
     * make the plugin fall back for no reason.
     */
    available() {
        return !this.disposed;
    }
    createView() {
        const viewId = randomUUID();
        return {
            id: viewId,
            sendCommand: async (method, params) => {
                const client = await this.ensureClient();
                const session = this.views.get(viewId) ?? await this.ensureSession(viewId);
                const result = await client.send(method, params, session);
                return (result ?? {});
            },
        };
    }
    destroyView(handle) {
        const session = this.views.get(handle.id);
        this.views.delete(handle.id);
        if (session === undefined)
            return;
        // A session id is not a target id: closing the page needs the target the session
        // was attached to, which is why they are tracked separately.
        const targetId = this.sessions.get(session);
        this.sessions.delete(session);
        // Nothing to close if the browser was never started.
        if (targetId !== undefined && this.client !== undefined) {
            // Best-effort: a page that is already gone is not an error.
            void this.client.send('Target.closeTarget', { targetId }).catch(() => undefined);
        }
    }
    /** Nothing to show: the browser owns its own windows. */
    showView() { }
    /** Same as {@link showView}. */
    async presentView() { }
    /** The browser owns window grouping. */
    groupView() { }
    /**
     * Bring the browser's window forward.
     *
     * The browser is a separate application, so there is no view to raise; focusing
     * the process is the closest honest equivalent, and failing to do so (a minimized
     * window, a locked session) is never worth an error.
     */
    async focus() {
        try {
            this.child?.kill('SIGCONT');
        }
        catch { /* not supported on Windows; harmless */ }
    }
    /** The browser reports its own window lifecycle. */
    onUserAction() { }
    /** The browser reports its own window lifecycle. */
    onViewClosed() { }
    /**
     * Close the browser we launched, if we ever launched one.
     *
     * The user's own windows belong to a different process and are never touched. A
     * host whose browser was never started (the common case when nobody used the
     * browser) simply tears down its bookkeeping.
     */
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.views.clear();
        this.sessions.clear();
        this.client?.close();
        try {
            this.child?.kill();
        }
        catch { /* already gone */ }
        const ephemeral = this.ephemeralDir;
        if (ephemeral !== undefined && this.child !== undefined) {
            // The browser flushes its profile while shutting down, so deleting later avoids
            // racing it. Leftovers are only a stray temp directory, never a live credential.
            setTimeout(() => { try {
                rmSync(ephemeral, { recursive: true, force: true });
            }
            catch { /* best effort */ } }, 3_000).unref?.();
        }
        else if (ephemeral !== undefined) {
            // Never started, so nothing can be holding it open.
            try {
                rmSync(ephemeral, { recursive: true, force: true });
            }
            catch { /* best effort */ }
        }
    }
    /** The flattened session for a view, creating its page on first use. */
    async ensureSession(viewId) {
        const existing = this.views.get(viewId);
        if (existing !== undefined)
            return existing;
        const client = await this.ensureClient();
        const created = await client.send('Target.createTarget', { url: 'about:blank' });
        const targetId = created?.targetId;
        if (typeof targetId !== 'string')
            throw new Error('dsh-builtin-browser: the browser did not create a page');
        const attached = await client.send('Target.attachToTarget', { targetId, flatten: true });
        const sessionId = attached?.sessionId;
        if (typeof sessionId !== 'string')
            throw new Error('dsh-builtin-browser: the browser did not attach to the new page');
        // The session id is what page commands ride; the target id is what closes it.
        this.sessions.set(sessionId, targetId);
        this.views.set(viewId, sessionId);
        return sessionId;
    }
    /** sessionId -> targetId, so a destroyed view can close the right page. */
    sessions = new Map();
}
