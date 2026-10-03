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
    /**
     * Resolve once the socket is open.
     *
     * Bounded on purpose. `ready` settles on the socket's own `open` or `error` events, and
     * a connection that is dropped by something in between may deliver neither — in which
     * case an unbounded await here would hang the tool call forever, because the caller's
     * own deadline is only checked between polls and this await happens inside one of them.
     * @returns when the handshake completed.
     */
    /**
     * Whether the socket is still usable.
     *
     * A dropped connection is not reported to the caller of send(); the pending command
     * would simply never complete. Asking the socket directly is what lets a cached client
     * be discarded instead of reused, which is the difference between a restart and a 30s
     * hang on every subsequent call.
     * @returns true while the socket is open.
     */
    isAlive() {
        return this.socket.readyState === WebSocket.OPEN;
    }
    async whenReady() {
        const timeoutMs = 30_000;
        let timer;
        try {
            await Promise.race([
                this.ready,
                new Promise((_resolve, reject) => {
                    timer = setTimeout(() => reject(new Error(`dsh-builtin-browser: the browser did not complete the CDP handshake within ${timeoutMs / 1000}s`)), timeoutMs);
                }),
            ]);
        }
        finally {
            if (timer !== undefined)
                clearTimeout(timer);
        }
    }
    /**
     * Send one CDP command, optionally on an attached session.
     * @param method - the CDP method.
     * @param params - its parameters.
     * @param sessionId - the flattened session to target, when this is a page command.
     * @returns the CDP result.
     */
    async send(method, params, sessionId) {
        // Fail fast and say why. Waiting out the timeout on a closed socket produced
        // only "timed out", which reads as a slow page and hides the real cause.
        if (!this.isAlive()) {
            throw new Error('dsh-builtin-browser: the browser connection is closed (the browser window was probably closed); the next command will start it again');
        }
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
    /**
     * Set when a command went unanswered rather than being refused.
     *
     * A timeout says nothing about the connection: the page may simply be slow. It marks the
     * client for a cheap check before the next command trusts it, which keeps a slow page
     * from being mistaken for a dead browser while still catching one that has truly stopped
     * answering.
     */
    clientSuspect = false;
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
    /**
     * Whether a client that reports itself open is actually answering.
     *
     * An open socket proves nothing: a browser can hold the connection and never reply, and
     * that state must not be cached, or every later command waits out its own timeout. Asking
     * the browser something cheap is a fact; reading the failure text is a guess, and the
     * guess was wrong in both directions (it killed healthy browsers on a slow page, and it
     * mistook the browser's own free text for a verdict).
     *
     * This is only reached when the socket is open, so the common path costs nothing.
     * @param client - the client to question.
     * @returns true when it answered.
     */
    async probeClient(client) {
        try {
            await client.send('Browser.getVersion', {});
            return true;
        }
        catch {
            // No answer within the budget, or the socket failed while asking: unusable either way.
            return false;
        }
    }
    async ensureClient() {
        // A disposed host must never start a browser: doing so would spawn a process
        // nobody owns and nobody will kill.
        if (this.disposed)
            throw new Error('dsh-builtin-browser: this browser host was released');
        // The exit listener clears this, but a socket can also die without the process doing so
        // (the browser closing its debugging endpoint, a dropped connection). Checking the
        // socket's own state costs nothing and turns a 30s hang into a restart.
        if (this.client !== undefined) {
            // A closed socket means the browser is gone; an OPEN socket proves nothing, because
            // a browser can hold the connection and never answer. Only probe when the socket is
            // closed or a previous command went unanswered without being refused — probing every
            // call would add a round trip to the common path for nothing.
            const current = this.client;
            if (current.isAlive() && !this.clientSuspect)
                return current;
            if (current.isAlive() && await this.probeClient(current)) {
                this.clientSuspect = false;
                return current;
            }
            current.close();
            this.client = undefined;
            this.clientSuspect = false;
        }
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
        // A browser from a previous attempt may still be running with this same
        // --user-data-dir. On Windows the new one would merely hand off to it and exit, and that
        // exit would then be treated as the launch failing.
        if (this.child !== undefined) {
            try {
                this.child.kill();
            }
            catch { /* already gone */ }
            this.child = undefined;
            // Whatever the old browser issued is worthless now, and its exit listener cannot clean
            // up after itself: this.child is reassigned below, so the old child's exit event returns
            // early and the session ids it handed out would be reused against a browser that never
            // heard of them — the "Session with given id not found" loop, which never clears.
            this.client?.close();
            this.client = undefined;
            this.views.clear();
            this.sessions.clear();
        }
        let child;
        try {
            child = spawn(this.browser.path, args, { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: false });
        }
        catch (error) {
            // spawn throws synchronously for some targets (a .cmd on Windows, a path that cannot
            // be executed). Without this the exception escaped start() and skipped every
            // diagnostic below it.
            throw new Error(`dsh-builtin-browser: could not launch ${this.browser.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.child = child;
        /**
         * A launch that fails (ENOENT, no permission, a broken binary) is reported by an
         * asynchronous 'error' event on the child, NOT by a throw here and NOT by exitCode.
         * Without this listener Node treats it as unhandled and takes the whole host process
         * down — one bad browser path would kill DSH, not just fail a tool call.
         */
        let launchError;
        child.on('error', error => { launchError = error; });
        // A browser that exits later is as unusable as one that never started, and the failure
        // has to reach the NEXT call rather than being swallowed: clearing the client here is
        // what makes ensureClient() start a fresh browser instead of returning a socket to a
        // dead process and letting every command time out.
        child.on('exit', () => {
            if (this.child !== child)
                return;
            this.client?.close();
            this.client = undefined;
            this.child = undefined;
            // The pages this client opened belong to the process that just died; keeping their
            // session ids means every later command is sent to a browser that never issued them.
            // Clearing these is what makes the restart usable rather than merely alive.
            this.views.clear();
            this.sessions.clear();
        });
        const portFile = join(this.profileDir, 'DevToolsActivePort');
        const deadline = Date.now() + 30_000;
        /**
         * Why the loop stopped, so the failure can say what actually happened. Reporting
         * every ending as "did not expose CDP within 30s" was wrong three ways: the cause,
         * the words, and the elapsed time — a browser that cannot be launched says so in
         * half a second, and the caller then looks for a CDP problem that does not exist.
         */
        let stopped = 'timeout';
        for (;;) {
            // Released while we were starting: stop here rather than keep polling for a
            // browser that dispose() has already killed, which would leave a connection
            // to a dead process behind. The child is killed here too — dispose() may have
            // run before this child was recorded, leaving nobody else to do it.
            if (this.disposed) {
                child.kill();
                if (this.child === child)
                    this.child = undefined;
                stopped = 'released';
                break;
            }
            if (launchError !== undefined) {
                if (this.child === child)
                    this.child = undefined;
                stopped = 'launch-failed';
                break;
            }
            if (Date.now() > deadline) {
                child.kill();
                if (this.child === child)
                    this.child = undefined;
                stopped = 'timeout';
                break;
            }
            if (child.exitCode !== null) {
                if (this.child === child)
                    this.child = undefined;
                stopped = 'exited';
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
        // Each ending gets its own message. The old single message blamed a CDP timeout for
        // all of them, which sent the reader looking for a port problem when the browser had
        // simply failed to launch.
        const target = `${this.browser.kind} (${this.browser.path})`;
        if (stopped === 'launch-failed') {
            throw new Error(`dsh-builtin-browser: could not launch ${target}: ${launchError?.message ?? 'unknown error'}`);
        }
        if (stopped === 'exited') {
            throw new Error(`dsh-builtin-browser: ${target} exited immediately after launch (exit code ${child.exitCode}); check that the path is a runnable browser`);
        }
        if (stopped === 'released') {
            throw new Error(`dsh-builtin-browser: ${target} was released while it was starting`);
        }
        throw new Error(`dsh-builtin-browser: ${target} did not expose CDP within 30s`);
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
            // This is the real browser, not Electron: CDP's JPEG encoder works here, so the
            // provider may pass format and quality through instead of falling back to PNG.
            supportsCdpJpeg: true,
            sendCommand: async (method, params) => {
                // A command that never answered is the only signal that a client has wedged — the
                // socket can stay OPEN while nothing comes back, which is the form the reporter saw with
                // a live, healthy-looking Edge. Dropping the client here means the next call starts a new
                // browser rather than hanging again, and the error names the cause instead of a timeout.
                const client = await this.ensureClient();
                const session = this.views.get(viewId) ?? await this.ensureSession(viewId);
                try {
                    const result = await client.send(method, params, session);
                    return (result ?? {});
                }
                catch (error) {
                    // A CDP protocol error means the browser ANSWERED and refused this one command, so the
                    // connection is healthy and must be kept. Deciding by the error TEXT misfires both
                    // ways: the inner timeout rejects with "… timed out", so a slow but healthy page read
                    // as a dead browser, the client was dropped, and the next call's start() killed the
                    // running child — the human's tabs and half-filled forms gone, which is worse than the
                    // bug that change was fixing. The browser's own free text is interpolated into
                    // protocol errors too, so any message containing those words misfired the same way.
                    // Unanswered versus refused. 'timed out' is the inner client's own budget expiring,
                    // which says the page was slow, not that the browser died — so it only marks the client
                    // for a probe. Being wrong here costs a two-second check; being wrong about the
                    // browser being dead cost the user their open tabs.
                    if (error instanceof Error && /timed out/.test(error.message))
                        this.clientSuspect = true;
                    if (!client.isAlive()) {
                        // Only THIS call's client. Under concurrency the field may already hold a
                        // connection another call just published, and closing that would kill a healthy one.
                        if (this.client === client)
                            this.client = undefined;
                        client.close();
                    }
                    throw error;
                }
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
     * Best effort at bringing the browser's window forward.
     *
     * The browser is a separate application, so there is no view to raise. What this can
     * actually do is ask its process to continue from a stopped state — which is a no-op on
     * Windows, where `SIGCONT` is not a supported signal and the call throws. It is kept
     * because it costs nothing and does help on POSIX (a process stopped with SIGSTOP
     * resumes), but it must not be read as a promise that the window comes to the front;
     * importantly, it does NOT raise a window that is merely behind another. Raising the
     * page properly would need `Page.bringToFront` on a specific target session, which is a
     * view-level concern and not available to the host.
     */
    async focus() {
        try {
            this.child?.kill('SIGCONT');
        }
        catch { /* Windows has no SIGCONT; nothing to do */ }
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
            //
            // The timer is unref'd, so it never holds the process open — which also means that a
            // process which exits inside this 3s window (a CLI probe, a DSH restart) leaves the
            // directory behind for good, silently contradicting the user's "keep no profile"
            // choice. The exit hook below is the same delete, run synchronously as a last resort;
            // the callback is idempotent, so whichever runs first wins and the other is a no-op.
            const removeEphemeral = () => {
                try {
                    rmSync(ephemeral, { recursive: true, force: true });
                }
                catch { /* best effort */ }
            };
            setTimeout(removeEphemeral, 3_000).unref?.();
            process.once('exit', removeEphemeral);
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
