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
import type { HeadlessMode } from './settings-store.js';
/**
 * Starts a browser process and returns a handle to it.
 *
 * Injectable so tests can supply something that speaks CDP — the seam a recovery test needs
 * and could not have while the launch was hardcoded to a stub that rejects Chromium's args.
 * @param path - the executable to run.
 * @param args - its arguments.
 * @returns the child process.
 */
export type BrowserLauncher = (path: string, args: readonly string[]) => ReturnType<typeof spawn>;
import { spawn } from 'node:child_process';
import type { ElectronBrowserViewHost, ElectronViewHandle } from './provider.js';
import type { CarrierPage } from '../browser/types.js';
/** Which browser the user asked for. */
export type BrowserChannel = 'bundled' | 'chrome' | 'edge' | 'auto' | 'sidebar';
/** A resolved browser installation. */
export interface DetectedBrowser {
    /** Which product this is. */
    readonly kind: 'chrome' | 'edge' | 'brave';
    /** Absolute path to the executable. */
    readonly path: string;
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
export declare function detectBrowser(channel: BrowserChannel, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): DetectedBrowser | undefined;
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
export declare function searchSummary(kind: DetectedBrowser['kind'], platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv): string[];
/** A system browser driven over CDP, presented as a browser view host. */
export declare class SystemBrowserViewHost implements ElectronBrowserViewHost {
    private readonly browser;
    private readonly profileDir;
    private readonly extraArgs;
    private readonly ephemeralDir?;
    private readonly launcher;
    /**
     * Whether this launch should get a window. See {@link resolveLaunchMode} for how `auto` decides
     * and why a display-less host needs headless at all (issue #32).
     */
    private readonly headlessMode;
    /**
     * viewId -> the session that view rides, and the client that issued it.
     *
     * The client is part of the value on purpose. A session id means nothing to a browser other
     * than the one that handed it out, and this host replaces browsers routinely: the process
     * dies, or its debugging socket closes while the process lives on. Keeping only the id meant
     * the host could start a NEW browser successfully and then send every command to it carrying
     * a session the old one had issued — `Session with given id not found`, on every call, with a
     * browser that answers /json/version perfectly well and nothing the user can do short of
     * restarting DSH. Comparing identity catches it with no round trip; validating each cached
     * session against the browser would put one on every page command.
     */
    private readonly views;
    private disposed;
    /**
     * The browser is started on FIRST USE, never on construction.
     *
     * A plugin that launches Chrome the moment its host loads is a plugin that takes
     * over the machine before anyone asked it to: simply starting DSH would spawn a
     * browser window. Registration must therefore be inert, and the process is only
     * spawned when a view is actually needed.
     */
    private client;
    /**
     * Set when a command went unanswered rather than being refused.
     *
     * A timeout says nothing about the connection: the page may simply be slow. It marks the
     * client for a cheap check before the next command trusts it, which keeps a slow page
     * from being mistaken for a dead browser while still catching one that has truly stopped
     * answering.
     */
    private clientSuspect;
    private child;
    /**
     * True when the browser in use was adopted from a previous run rather than launched here.
     *
     * Worth recording because the two differ on teardown: a browser this host spawned is its to
     * kill, while one it merely took over belongs to a process that is already gone — closing it is
     * still right (it holds the profile nobody else can use), but it is a decision, not cleanup.
     */
    private adoptedRunning;
    /** Whether this connection's surplus blank pages have been collapsed already. */
    private blanksNormalized;
    private starting;
    /**
     * Browsers that ignored a kill.
     *
     * They are no longer this host's child — a replacement has taken that slot — but they
     * are still running, still holding the profile, and still something release must try to
     * stop. Forgetting them is what allowed a launch this host could not undo.
     */
    private readonly stubborn;
    /**
     * @param browser - the detected installation to launch on first use.
     * @param profileDir - a plugin-owned directory; the user's own profile is never touched.
     * @param extraArgs - additional Chromium switches.
     * @param ephemeralDir - a directory to delete on release, when the user has turned
     *   persistence off so no login state outlives the session.
     * @param launcher - how to start the browser, for tests.
     *
     *   Recovery after the browser dies was untestable without this: the suite spawns a stub
     *   with Chromium's arguments, and a stub that is not a browser rejects them and exits, so
     *   no CDP endpoint ever appears and no session is ever created. Verified by mutation —
     *   removing every sessions.clear() left the recovery tests green. A launcher lets a test
     *   provide something that actually speaks CDP, so the state those tests describe exists.
     */
    constructor(browser: DetectedBrowser, profileDir: string, extraArgs?: readonly string[], ephemeralDir?: string | undefined, launcher?: BrowserLauncher, 
    /**
     * Whether this launch should get a window. See {@link resolveLaunchMode} for how `auto` decides
     * and why a display-less host needs headless at all (issue #32).
     */
    headlessMode?: HeadlessMode);
    /** Which product this host would drive (for diagnostics). */
    get kind(): DetectedBrowser['kind'];
    /** Whether the browser has actually been started yet (diagnostics and tests). */
    get started(): boolean;
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
    private probeClient;
    /**
     * Forget which browser issued what, after that browser is gone.
     *
     * The two maps must move together: `views` maps a view id to a session id and `sessions`
     * maps a session id to a target id, so clearing one alone leaves a mapping the next command
     * will act on. Every path that abandons a browser calls this rather than spelling the pair
     * out — four separate copies is how the third one came to be missing.
     */
    private forgetBrowserState;
    private ensureClient;
    /**
     * Take over a browser already serving this profile, instead of racing it.
     *
     * A previous DSH process leaves its browser running: the child handle died with that process, so
     * nothing here knows about it, and `start()`'s cleanup branch is skipped because it keys on
     * `this.child`. Launching then does something worse than fail — on Windows Chrome hands the
     * request to the instance already holding the profile and exits 0, and that exit is read as a
     * launch failure. The user is told to go kill the leftovers by hand, on every restart, which is
     * exactly what was reported.
     *
     * The launch loop deliberately refuses to trust a `<profile>/DevToolsActivePort` left by a
     * previous launch, and it is right to: a stale port number can be reused by something that is
     * not a browser at all. What makes adoption safe HERE is that this runs BEFORE launching, on a
     * file that lives inside this plugin's own profile directory — only a browser started with this
     * `--user-data-dir` writes it — and the endpoint is then asked to identify itself.
     * @param why - a short phrase for the log, naming which attempt this is.
     * @returns a connected client for the running browser, or undefined when there is none.
     */
    private adoptRunningBrowser;
    /**
     * Launch the browser with a private profile and connect over CDP.
     *
     * `--remote-debugging-port=0` plus the `DevToolsActivePort` file is the only
     * reliable way to learn the port: a fixed port collides with whatever else the
     * machine is running, and parsing stderr is fragile across versions.
     * @returns the connected client.
     */
    private start;
    /**
     * Whether this host can back views.
     *
     * True while the host is usable — including before the browser has been started,
     * since the first command is what starts it. Reporting "unavailable" here would
     * make the plugin fall back for no reason.
     */
    available(): boolean;
    /**
     * Every page the browser currently holds, including ones this plugin did not create.
     *
     * Chrome and Edge own their own page creation. A click on a link that opens a new page — or any
     * `window.open` — produces a page the provider never asked for, and nothing reports it back.
     * Those pages are real: they hold memory and stay until something closes them. Measured on a real
     * window: four pages present while `dsh_browser_list_tabs` reported one.
     *
     * Discovery is already on at connection time (see the blank-page normalisation), so
     * `Target.getTargets` also lists pages that existed before this client connected.
     * @returns the browser's pages, or an empty list when it cannot answer.
     */
    /**
     * Every page the browser holds that THIS HOST did not open.
     *
     * Chrome and Edge own their own page creation. A click on a link that opens a new page — or any
     * `window.open` — produces a page the provider never asked for, and nothing reports it back.
     * Those pages are real: they hold memory and stay until something closes them. Measured on a real
     * window: four pages present while `dsh_browser_list_tabs` reported one.
     *
     * Pages this host opened are EXCLUDED here rather than deduplicated by the caller, because the
     * caller cannot do it: the provider knows a tab by its own id, the carrier knows a page by its
     * CDP target id, and the two never match. The first version returned everything and relied on the
     * caller to filter, which reported the same page twice.
     *
     * Discovery is already on at connection time (see the blank-page normalisation), so
     * `Target.getTargets` also lists pages that existed before this client connected.
     * @returns the browser's pages that are not ours, or an empty list when it cannot answer.
     */
    listPages(): Promise<readonly CarrierPage[]>;
    /**
     * Close one page by the target id {@link listPages} reported.
     *
     * `Target.closeTarget` is the browser's own close, so it works for pages this plugin never
     * created. The page may already be gone if the human closed it in the meantime — the caller
     * asked for it to be closed and it is, so that is not an error.
     * @param id - the CDP target id.
     */
    closePage(id: string): Promise<void>;
    createView(): ElectronViewHandle;
    destroyView(handle: ElectronViewHandle): void;
    /** Nothing to show: the browser owns its own windows. */
    showView(): void;
    /**
     * Bring the target's page to the front, then report success.
     *
     * The comment on `focus` below used to say this was impossible — that raising the page needs
     * `Page.bringToFront` on a target session, which is a view-level concern the host cannot
     * reach. The handle this method is handed IS that view, and it can send commands, so the
     * capability was here all along; it just was not used. Without it `presentView` was an empty
     * async method, so the provider's whole presentation barrier — the one that stops
     * `Input.*` from being silently dropped for a view with no display surface, and reports
     * `BROWSER_VIEW_NOT_PRESENTED` when it cannot present — never ran on this carrier.
     *
     * A failure is swallowed rather than propagated: a real Chrome window that refuses to come
     * forward is not a reason to refuse the click that follows. The barrier exists to order the
     * two, and the order is honoured either way.
     * @param handle - the view to present.
     */
    presentView(handle: ElectronViewHandle): Promise<void>;
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
    focus(): Promise<void>;
    /**
     * Close the browser we launched, if we ever launched one.
     *
     * The user's own windows belong to a different process and are never touched. A
     * host whose browser was never started (the common case when nobody used the
     * browser) simply tears down its bookkeeping.
     */
    dispose(): void;
    /**
     * The flattened session for a view, creating its page on first use.
     *
     * No cache check here: the only caller has already established that the cached session does
     * not belong to the client it is about to use. Re-checking would mean either a round trip or
     * a second copy of that rule.
     */
    private ensureSession;
    /** Create and attach the target for one view. Serialised by {@link ensureSession}. */
    private buildSession;
    /**
     * Take an unclaimed blank page, if the browser has one to spare.
     *
     * "Unclaimed" is what matters: a blank page the plugin is already driving belongs to a view, and
     * handing the same target to a second view would make two views share one page. The page kept by
     * {@link normalizeBlankPages} is exactly the unclaimed one this is looking for.
     * @param client - the connected browser.
     * @returns the target id to reuse, or undefined when a new page has to be created.
     */
    private adoptBlankTarget;
    /** Create one page, refusing to go on without an id. */
    private createTarget;
    /**
     * Collapse the blank pages a freshly started browser comes with down to one.
     *
     * Chrome opens more than one page when it is given a URL on top of its own start page, and this
     * is the browser's behaviour rather than a session restore: measured on a cleanly exited profile
     * as well as a crashed one, both pages appear within a second of launch. There is nothing to
     * configure away — by the time a client can talk to the browser, both already exist.
     *
     * Left alone the surplus page is invisible to the plugin's tab model and therefore unclosable
     * through the tools, so it survives every navigation and accumulates for as long as the window
     * lives. One is kept deliberately: {@link buildSession} adopts it instead of creating a third.
     *
     * `Target.setDiscoverTargets` has to come first. Without it the browser may omit pages that
     * existed before this client connected — which is precisely the page that needs closing, and the
     * reason the first attempt at this fix failed silently.
     * @param client - the connected browser.
     * @returns how many surplus blank pages were closed.
     */
    private normalizeBlankPages;
    /** Views whose session is being created right now, so a second caller waits for the first. */
    private readonly sessionBuilding;
    /** Serialises page selection/creation and attachment for each browser connection. */
    private readonly targetBuilds;
    /** sessionId -> targetId, so a destroyed view can close the right page. */
    private readonly sessions;
}
