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
 * child nor inject replies — it is disconnected as soon as its first line
 * arrives. Commands are only written after the hello authenticates, and every
 * other inbound op (including the fire-and-forget `userAction` / `viewClosed`
 * notifications) is dispatched only once that check has passed, so an
 * unauthenticated peer can neither read traffic nor drive a session.
 * @module dsh-browser/browser-electron/remote-host
 */
import type { BrowserUserAction, ElectronBrowserViewHost, ElectronViewHandle } from './provider.js';
/**
 * Locate a SPAWNABLE Electron binary — one that runs a script given as an
 * argument, i.e. a BARE electron, never a packaged app executable:
 *   0. ELECTRON_PATH (explicit override — user intent beats auto-discovery),
 *   1. the plugin's own electron package (a real dependency since 0.1.18),
 *      found by a pure filesystem walk — never require(), whose semantics
 *      differ inside an Electron main process (there it is the built-in API
 *      module, not the npm package) and which would trigger electron 44+'s
 *      lazy binary download;
 *   2. every DSH install anchor (electron installed separately, e.g.
 *      `dsh plugin add electron` into the profile or a global prefix),
 *      choosing the NEWEST version found. Older Electron releases (e.g.
 *      33.x) have a compositor defect that intermittently breaks page
 *      capture, so prefer the newest binary available in the environment,
 *   3. the current process, when it IS a bare Electron (dev hosts, e.g.
 *      `electron .`): reuse the host binary. Packaged app executables
 *      (resources/app.asar beside the exe) are never reused — they ignore
 *      the script argument and launch the app itself, typically exiting
 *      immediately via the single-instance lock, which is exactly the
 *      "browser host exited (code=0)" failure on DSH Desktop;
 *   4. last resort: the process ancestry, for hosts that run this plugin in a
 *      child Node process of their own bare-Electron main process.
 * @returns the path to the Electron executable.
 */
/** The discovery inputs {@link resolveElectronPathImpl} selects over, injectable for tests. */
interface ElectronPathInputs {
    /** ELECTRON_PATH (may be unset, empty, or pointing at a missing file). */
    readonly override: string | undefined;
    /** True when running inside an Electron main process. */
    readonly inElectron: boolean;
    /** process.execPath (candidate for in-process host reuse). */
    readonly execPath: string;
    /** The plugin's own electron package probe (bundled). */
    readonly bundled: () => string | undefined;
    /** The DSH install-anchor probe. */
    readonly anchored: () => string | undefined;
    /** The process-ancestry probe (last resort). */
    readonly ancestry: () => string | undefined;
}
declare function resolveElectronPath(): string;
/**
 * Pure selection over the discovery probes, in order:
 *   0. override (user intent) → 1. bundled package → 2. anchors (newest) →
 *   3. in-process BARE host → 4. process ancestry → throw.
 * Packaged app executables are never reused (steps 3/4 skip them).
 */
declare function resolveElectronPathImpl(inputs: ElectronPathInputs): string;
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
declare function isBareElectron(exe: string): boolean;
/** Candidate executable layouts used by the Electron npm package on one platform. */
declare function electronDistCandidates(pkgRoot: string, platform?: NodeJS.Platform): string[];
/** From an electron package entry file, find the dist executable beside it. */
declare function electronExeBeside(entry: string, platform?: NodeJS.Platform): string | undefined;
/** From an electron package root, find its dist executable. */
declare function electronDistExe(pkgRoot: string, platform?: NodeJS.Platform): string | undefined;
/**
 * Self-hosted view host: spawns the plugin's Electron child on first use and
 * keeps it alive until dispose(). Fallback when no desktop shell provides
 * ctx.electronViewHost.
 */
export declare class RemoteElectronViewHost implements ElectronBrowserViewHost {
    private readonly hostMainPath;
    /** Test seam: the executable to spawn instead of the resolved Electron
     *  binary. Absent -> resolveElectronPath() (production behavior). */
    private readonly spawnExecutable?;
    /** Test seam: the binary probe behind `available()`. Absent ->
     *  resolveElectronPath(). */
    private readonly probe;
    private client;
    private server;
    private pendingSocket;
    private readonly views;
    private readyPromise;
    private disposed;
    /** Last probe result. A success is kept for the host's lifetime; a failure
     *  is retried after `PROBE_RETRY_MS` (see `available()`). */
    private electronAvailable;
    /** Earliest time the next probe may run after a negative one. */
    private nextProbeAt;
    /** Consecutive child starts that did not survive; drives {@link startRetryAt}. */
    private startFailures;
    /** Earliest time `ready()` may spawn another child after a failed start. */
    private startRetryAt;
    /** When the last start failure was reported, used to keep one death to one log line. */
    private lastStartFailureAt;
    /** Window groups (windowId per view), re-sent on every materialization so
     *  a restarted child still places views in the right windows. */
    private readonly groups;
    /** The provider's user-action handler; routes toolbar actions into sessions. */
    private userActionHandler;
    /**
     * The provider's handler for a window the human closed. Closing the interface
     * ends the session it showed: history and login state stay on disk, so the
     * next open starts clean instead of resuming a window nobody can see.
     */
    private viewClosedHandler;
    constructor(hostMainPath: string, 
    /** Test seam: the executable to spawn instead of the resolved Electron
     *  binary. Absent -> resolveElectronPath() (production behavior). */
    spawnExecutable?: string | undefined, 
    /** Test seam: the binary probe behind `available()`. Absent ->
     *  resolveElectronPath(). */
    probe?: () => void);
    /**
     * Cheap usability probe: can we find an Electron binary to spawn? The scan
     * is filesystem-only (no network), per the seam's contract, so a missing
     * binary surfaces as `BROWSER_PROVIDER_UNAVAILABLE` at provider selection
     * instead of a confusing spawn failure on first use.
     *
     * A success is cached for the host's lifetime. A failure is NOT: an install
     * (`npm i electron`, or the postinstall that fetches the binary) can land
     * long after DSH started, and provider selection happens once per process —
     * caching "no" permanently reported "no usable browser provider is
     * registered" until DSH restarted, with no way back short of that. Retrying
     * on a cooldown heals it by itself while keeping the scan off the hot path.
     */
    available(): boolean;
    /**
     * Ensure the child is up and ready (lazy on first use; restarts after a crash).
     *
     * Never throws synchronously. Callers are fire-and-forget
     * (`void this.ready().then(…).catch(…)`), and a synchronous throw escapes their
     * `.catch` entirely — the shape that let a failed toolbar report take the whole
     * DSH host down (issue #16). A disposed host is reported as a rejected promise
     * instead, which those callers already handle.
     */
    private ready;
    /**
     * Record one child that did not survive, and set the earliest retry time.
     *
     * `available()` answers "is there a binary to spawn" from the FILESYSTEM, and a success
     * there is cached for the host's lifetime (correctly — rescanning on every tool call was
     * the bug). That probe therefore cannot see the failure mode where the binary exists and
     * crashes on every launch: the signature `code=1` with empty stderr that host-log.test.mjs
     * asserts. Each browser call then spawned a child that died within milliseconds, with no
     * backoff and nothing that ever gives up — an endless crash loop, each iteration a window
     * flashing on screen.
     *
     * The first retry is immediate, so the ordinary transient death (the DSH restart in
     * remote-host-recovery.test.mjs) still heals on the very next call. After that the delay
     * grows: once {@link START_FAILURES_MAX} attempts have failed, every later attempt is
     * spaced by the table's last entry — the host keeps trying, but a permanently broken
     * install now costs one spawn per 30s instead of one per tool call. Nothing is marked
     * dead for good: a repaired installation heals on the next attempt, and `dispose()`
     * still stops everything immediately.
     * @param error - what the failed attempt reported.
     */
    private noteStartFailure;
    private start;
    /** The child died: tear down so the next use starts a fresh child. */
    private onChildExit;
    createView(): ElectronViewHandle;
    private ensureView;
    showView(handle: ElectronViewHandle, label?: string): void;
    /**
     * (Re)present a view and WAIT for the child to confirm it, so the provider
     * can dispatch CDP `Input.*` knowing the view has a display surface.
     *
     * Two things this fixes, both silent before:
     *  - showing a view that does not exist yet is a no-op in the child, so the
     *    view must be materialized first (a fresh tab's createView races the
     *    provider's showActive);
     *  - a view whose renderer was replaced by a navigation is \"already\n   *    visible\" and therefore skipped by the child's flicker-avoidance fast
     *    path, leaving the new renderer without a surface.
     *
     * The barrier ping is meaningful because the child handles messages strictly
     * in order: its reply is queued behind the showView and so only arrives once
     * the visibility change has been applied.
     */
    presentView(handle: ElectronViewHandle, label?: string): Promise<void>;
    /** Route a view into its session's own window (one window per session). */
    groupView(handle: ElectronViewHandle, windowId: string, label?: string): void;
    /** Register the provider's handler for user-initiated toolbar actions. */
    onUserAction(handler: (action: BrowserUserAction) => void): void;
    /** Register the provider's handler for windows the human closed. */
    onViewClosed(handler: (windowId: string) => void): void;
    /** Surface a failed user action to the child's toolbar (address bar etc.). */
    notifyUserActionError(windowId: string, message: string): void;
    destroyView(handle: ElectronViewHandle): void;
    /** Shut the child and the RPC server down. */
    dispose(): void;
}
/** Default host-main path relative to this module's build output. */
export declare function defaultHostMainPath(): string;
/**
 * Test/diagnostic hooks (mirrors tool-browser's `internals` convention).
 * `isBareElectron` is the packaged-app discriminator behind the host-reuse
 * steps; `resolveElectronPath` is the full resolution order.
 */
export declare const internals: {
    electronDistCandidates: typeof electronDistCandidates;
    electronDistExe: typeof electronDistExe;
    electronExeBeside: typeof electronExeBeside;
    isBareElectron: typeof isBareElectron;
    resolveElectronPath: typeof resolveElectronPath;
    resolveElectronPathImpl: typeof resolveElectronPathImpl;
};
export {};
