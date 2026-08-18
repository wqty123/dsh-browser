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
import type { BrowserUserAction, ElectronBrowserViewHost, ElectronViewHandle } from './provider.js';
/**
 * Self-hosted view host: spawns the plugin's Electron child on first use and
 * keeps it alive until dispose(). Fallback when no desktop shell provides
 * ctx.electronViewHost.
 */
export declare class RemoteElectronViewHost implements ElectronBrowserViewHost {
    private readonly hostMainPath;
    private client;
    private server;
    private pendingSocket;
    private readonly views;
    private readyPromise;
    private disposed;
    /** Cached probe result so `available()` stays cheap after the first call. */
    private electronAvailable;
    /** Window groups (windowId per view), re-sent on every materialization so
     *  a restarted child still places views in the right windows. */
    private readonly groups;
    /** The provider's user-action handler; routes toolbar actions into sessions. */
    private userActionHandler;
    constructor(hostMainPath: string);
    /**
     * Cheap usability probe: can we find an Electron binary to spawn? The scan
     * is filesystem-only (no network), per the seam's contract, and the result
     * is cached for the host's lifetime — a missing binary surfaces as
     * `BROWSER_PROVIDER_UNAVAILABLE` at provider selection instead of a
     * confusing spawn failure on first use.
     */
    available(): boolean;
    /** Ensure the child is up and ready (lazy on first use; restarts after a crash). */
    private ready;
    private start;
    /** The child died: tear down so the next use starts a fresh child. */
    private onChildExit;
    createView(): ElectronViewHandle;
    private ensureView;
    showView(handle: ElectronViewHandle, label?: string): void;
    /** Route a view into its session's own window (one window per session). */
    groupView(handle: ElectronViewHandle, windowId: string, label?: string): void;
    /** Register the provider's handler for user-initiated toolbar actions. */
    onUserAction(handler: (action: BrowserUserAction) => void): void;
    /** Surface a failed user action to the child's toolbar (address bar etc.). */
    notifyUserActionError(windowId: string, message: string): void;
    destroyView(handle: ElectronViewHandle): void;
    /** Shut the child and the RPC server down. */
    dispose(): void;
}
/** Default host-main path relative to this module's build output. */
export declare function defaultHostMainPath(): string;
