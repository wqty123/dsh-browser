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
 *   <- { id, ok: true, result? } | { id, ok: false, err }
 *
 * The child is Electron's main process; host-main.js owns the BrowserWindow,
 * WebContentsViews, and webContents.debugger (CDP).
 * @module dsh-browser/browser-electron/remote-host
 */
import type { ElectronBrowserViewHost, ElectronViewHandle } from './provider.ts';
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
    constructor(hostMainPath: string);
    /** Ensure the child is up and ready (lazy on first use; restarts after a crash). */
    private ready;
    private start;
    /** The child died: tear down so the next use starts a fresh child. */
    private onChildExit;
    createView(): ElectronViewHandle;
    private ensureView;
    showView(handle: ElectronViewHandle): void;
    destroyView(handle: ElectronViewHandle): void;
    /** Shut the child and the RPC server down. */
    dispose(): void;
}
/** Default host-main path relative to this module's build output. */
export declare function defaultHostMainPath(): string;
