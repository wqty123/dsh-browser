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
    /**
     * One entry per view this host handed out: the conversation it serves, and the guest backing it.
     *
     * The conversation belongs to the ENTRY, not to this host. A single plugin process serves every
     * conversation — DSH runs them all through one host instance — so an owner held on the host
     * would be one conversation's id applied to all of them, and a page could still land in
     * another's sidebar however carefully the bridge checked it.
     */
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
     *
     * It is now the CONVERSATION id rather than an invented uuid, read from the plugin's ctx by the
     * same path DSH's own desktop host uses. That matters because the shell keeps one sidebar per
     * conversation and writes its session id onto each sidebar container (on the React fiber,
     * measured on the running app) — so the bridge can only answer "is this sidebar mine" if it has
     * a comparable id. With an invented uuid it never could, which is how a command came to be typed
     * into another conversation's address bar.
     *
     * Falls back to a random uuid when the host cannot supply one — an older DSH, or a non-desktop
     * composition. That is no worse than before: the bridge then knows only "this process", and it
     * refuses to operate on a sidebar it cannot prove is its own.
     */
    private readonly owner;
    /**
     * Guests whose view is gone but whose page may still be open in the sidebar, with the
     * conversation each belongs to.
     *
     * The provider destroys its view handles before it asks for a release, so the mapping is dropped
     * by then — keeping the guest ids here is what lets us close only our own tabs when several
     * conversations are running (requirements §4: each session gets its own page). The owner rides
     * along for the same reason it does in {@link views}: a release names one conversation.
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
    static discover(sessionId?: string): Promise<DesktopBridgeViewHost | undefined>;
    /** Whether this host can back views: the bridge already answered `list`. */
    available(): boolean;
    /**
     * The guest backing a view, materialized on first use.
     *
     * The conversation that called owns exactly one sidebar page on this carrier — a human and the
     * agent look at the same page — so every view resolves to that conversation's own guest, and the
     * page does not multiply behind the provider's own tab bookkeeping.
     *
     * A cached guest is used as-is: probing it first cost a round-trip on every command, so liveness
     * is established by the command failing instead.
     * @param viewId - the view whose guest is wanted.
     * @param url - address to use when this conversation has no page yet.
     */
    private guestFor;
    /**
     * @param owner - the conversation this view serves. Recorded WITH the view: one host instance
     *   serves every conversation, so the owner cannot live on the host.
     */
    createView(owner?: string): ElectronViewHandle;
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
     * @param owner - the conversation whose pages to close. Omit to close every conversation's,
     *   which is only correct from a teardown that is itself global.
     * @returns a promise that settles once the shell has been asked.
     */
    releasePage(owner?: string): Promise<void>;
    /**
     * Fold the sidebar away without ending the page (`ui.autoExpandOnce` is off, or
     * the caller wants the screen back while work continues).
     * @returns a promise that settles once the shell has been asked.
     */
    collapse(): Promise<void>;
    /** No child process of our own to stop; close the shared connection instead. */
    dispose(): void;
}
