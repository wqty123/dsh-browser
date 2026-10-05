/**
 * Desktop-sidebar browser host: drive the page the desktop shell shows in its
 * sidebar, instead of spawning a second, parallel Electron window.
 *
 * WHY
 * The plugin runs inside the desktop's Node-mode host, where there is no Electron
 * API — which is why it self-hosts a whole browser today. The shell, however, can
 * own views, and its sidebar already displays real web pages. This host borrows
 * that page over the shell's bridge (see apps/desktop/bridge/plugin-browser-bridge.js),
 * so the agent and the human end up on ONE page instead of two.
 *
 * CONTRACT
 * It implements the same `ElectronBrowserViewHost` seam the self-hosted host does,
 * so the provider, the tools, browsing history, the synthetic cursor and the
 * teardown rules are all unchanged: only the carrier differs. Everything is
 * lazily materialized — a fresh shell has no sidebar guest until something asks
 * for a page, and the bridge creates one on demand.
 *
 * FALLBACK
 * `discover()` returns undefined whenever the shell offers no usable bridge
 * (older desktop build, plain `dsh web`, bridge not started), and the entry point
 * then keeps the self-hosted Electron it has always used.
 * @module dsh-browser/browser-electron/desktop-bridge-host
 */
import type { ElectronBrowserViewHost, ElectronViewHandle } from './provider.js';
import type { BrowserUserAction } from './provider.js';
/** Absolute path of the endpoint file the shell writes. */
export declare function bridgeEndpointPath(): string;
/**
 * The desktop sidebar, presented as a browser view host.
 *
 * One sidebar exists per shell window, so every view this host hands out refers
 * to the same guest: the provider keeps its tab bookkeeping, and the tabs simply
 * share the visible page. That is the intended behaviour for this carrier — the
 * point is a single page both parties can see.
 */
export declare class DesktopBridgeViewHost implements ElectronBrowserViewHost {
    private readonly connection;
    private readonly views;
    /**
     * This process's identity with the bridge, for tab ownership.
     *
     * Every DSH session is its own plugin process, and the sidebar is one surface they all share.
     * A session can only see its own `views` map, so before the bridge kept a ledger it adopted
     * whichever tab it found — including one another session had opened, which is how a URL from
     * one session appeared in another's sidebar. The id is per process, so two sessions never
     * collide and one session's tabs are never handed to another; it is deliberately not the DSH
     * session id, which this layer has no access to and does not need.
     *
     * The whole ledger rests on that premise, so it was measured rather than assumed: with two
     * sessions running, the desktop had TWO host processes (plus one main, two renderers and a
     * gpu/utility pair). If sessions ever shared a process, every owner check in the bridge would
     * compare equal and the bleed would return in a new shape — so a change to how DSH spawns
     * sessions invalidates this file, not just this comment.
     */
    private readonly owner;
    /**
     * Guests whose view is gone but whose page may still be open in the sidebar.
     *
     * The provider destroys its view handles before it asks for a release, so the
     * mapping is dropped by then — keeping the guest ids here is what lets us close
     * only our own tabs when several sessions are running (requirements §4: each
     * session gets its own page).
     */
    private readonly orphaned;
    /**
     * Registered by the provider, and deliberately never invoked on this carrier.
     *
     * The sidebar is the shell's own interface: a human clicking inside that page is an
     * event the shell owns, and the bridge exposes no operation that reports it. The
     * handler is stored anyway so the interface contract holds (a caller may register
     * one and must not be surprised) and so a future bridge operation can deliver it
     * without changing the provider. Consequently no user-action event is emitted while
     * the desktop sidebar is the carrier — by design, not by omission.
     */
    private userActionHandler;
    /**
     * @param endpoint - the shell's published bridge endpoint.
     */
    private constructor();
    /**
     * Find a usable desktop bridge, if this surface has one.
     *
     * A stale endpoint (a shell that already exited, leaving its file behind) is
     * rejected here rather than surfacing later as a mysterious ECONNREFUSED: the
     * caller falls back to self-hosting, which always works.
     * @returns the host, or undefined when no bridge is available.
     */
    static discover(): Promise<DesktopBridgeViewHost | undefined>;
    /** Whether this host can back views: the bridge already answered `list`. */
    available(): boolean;
    /**
     * The guest id backing a view, materialized on first use.
     *
     * The sidebar browser is itself a multi-tab surface, so each view gets its own
     * tab's guest: the provider's tab bookkeeping then maps onto real tabs the human
     * can see and switch between. Two rules keep that honest:
     *   - a cached guest is used as-is: probing it first cost a round-trip on every
     *     command, so liveness is established by the command failing instead;
     *   - a fresh view takes an unclaimed guest, growing the tab strip only when
     *     every existing guest is already spoken for.
     * @param viewId - the view whose guest is wanted.
     * @param url - address to use when a sidebar browser has to be opened first.
     */
    private guestFor;
    /**
     * Ask for at least `count` tabs belonging to this session and return their guest ids.
     * @param count - minimum number of tabs.
     */
    private guestIds;
    createView(): ElectronViewHandle;
    destroyView(handle: ElectronViewHandle): void;
    /**
     * Bring this view's tab to the front in the sidebar.
     *
     * This used to be empty, on the reasoning that the sidebar is already on screen so there is
     * nothing to show. That confused "the sidebar is visible" with "this page is the one being
     * looked at": opening a page left it behind whatever the human had in front, which is issue
     * #23. The other two carriers both do this — the self-hosted window re-adds the view and the
     * system browser calls `Page.bringToFront` — so this carrier was the odd one out.
     *
     * Best-effort by design: the tab strip belongs to the shell's renderer, and failing to raise
     * it must not fail the navigation that has already happened.
     * @param handle - the view to bring forward.
     */
    showView(handle: ElectronViewHandle): void;
    onUserAction(handler: (action: BrowserUserAction) => void): void;
    /**
     * Release the sidebar's browser pages (requirements §3, `ui.closeWithSession`).
     *
     * Destroying our own view handles is not enough on this carrier: the sidebar
     * belongs to the shell and would happily keep the page (and its renderer) alive.
     * Closing the tabs is what actually ends the page — and only the page: cookies
     * live in the partition, history on disk, so both survive.
     * @returns a promise that settles once the shell has been asked.
     */
    releasePage(): Promise<void>;
    /**
     * Fold the sidebar away without ending the page (`ui.autoExpandOnce` is off, or
     * the caller wants the screen back while work continues).
     * @returns a promise that settles once the shell has been asked.
     */
    collapse(): Promise<void>;
    /** No child process of our own to stop; close the shared connection instead. */
    dispose(): void;
}
