/**
 * Electron-backed browser provider: `WebContentsView` sessions driven over
 * `webContents.debugger` (CDP). The provider itself does not import Electron — it operates through the {@link ElectronBrowserViewHost} seam, which the
 * desktop shell implements with real Electron objects. That keeps this
 * package testable under plain Node and leaves the Electron dependency to the
 * shell that owns the `BrowserWindow`.
 * @module dsh-browser/browser-electron
 */
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { HistoryStore } from './history-store.js';
import { forgetCursor, paintCursor } from './virtual-cursor.js';
import { BrowserError } from '../browser/types.js';
/**
 * Page-context human-verification (CAPTCHA / bot-detection) detection. Runs
 * inside the page; returns `{ blocked, kind?, reason? }`. Marker-based and
 * best-effort: checks for Cloudflare's interstitial, hCaptcha, reCAPTCHA,
 * Turnstile, and generic challenge wording.
 */
const CHALLENGE_DETECT_EXPRESSION = `(() => {
  const title = (document.title || '').trim()
  const bodyText = (document.body && document.body.innerText || '').slice(0, 4000)
  // Challenge widgets often live in same-origin iframes or shadow roots;
  // scan those too (cross-origin frames stay opaque).
  let extraText = ''
  try {
    const seen = new Set()
    const scan = (doc) => {
      if (seen.has(doc)) return
      seen.add(doc)
      for (const el of doc.querySelectorAll('*')) {
        if (el.shadowRoot) {
          extraText += (el.shadowRoot.textContent || '').slice(0, 2000)
          scan(el.shadowRoot)
        }
        if (el.tagName === 'IFRAME') {
          try {
            const d = el.contentDocument
            if (d) {
              extraText += ((d.body && d.body.innerText) || '').slice(0, 2000)
              scan(d)
            }
          } catch { /* cross-origin */ }
        }
      }
    }
    scan(document)
  } catch { /* never fail the challenge check */ }
  const lower = (title + '\\n' + bodyText + '\\n' + extraText).toLowerCase()
  const frameSrcs = [...document.querySelectorAll('iframe')].map(f => f.src || '').join(' ')
  const framesLower = frameSrcs.toLowerCase()
  const hasCfInterstitial = /just a moment|checking your browser|attention required|cf_chl/i.test(lower)
    || !!document.querySelector('#challenge-running, #challenge-stage, #cf-chl-container')
  const hasHCaptcha = !!window.hcaptcha || !!document.querySelector('.h-captcha') || /hcaptcha\\.com/i.test(framesLower)
  const hasRecaptcha = !!window.grecaptcha || !!document.querySelector('.g-recaptcha') || /recaptcha\\/api|google\\.com\\/recaptcha/i.test(framesLower)
  const hasTurnstile = !!window.turnstile || /challenges\\.cloudflare\\.com/i.test(framesLower) || /turnstile|challenge-platform/i.test(lower)
  const verifyWording = /verify you are human|verify you are not a robot|\\u4eba\\u673a\\u9a8c\\u8bc1|\\u5b89\\u5168\\u9a8c\\u8bc1|enable javascript and cookies|\\u8bf7.*\\u9a8c\\u8bc1/i.test(lower)
  if (hasCfInterstitial) return { blocked: true, kind: 'cloudflare', reason: 'Cloudflare "Just a moment" interstitial' }
  if (hasHCaptcha) return { blocked: true, kind: 'hcaptcha', reason: 'hCaptcha verification' }
  if (hasRecaptcha) return { blocked: true, kind: 'recaptcha', reason: 'Google reCAPTCHA verification' }
  if (hasTurnstile) return { blocked: true, kind: 'turnstile', reason: 'Cloudflare Turnstile verification' }
  if (verifyWording && /challenge|captcha|verification|security check|access denied|blocked|\\u9a8c\\u8bc1/i.test(lower)) {
    return { blocked: true, kind: 'generic', reason: 'Human-verification challenge' }
  }
  return { blocked: false }
})()`;
/** Stable provider id registered with `ctx.browser`. */
export const ELECTRON_BROWSER_PROVIDER_ID = 'electron';
/** CDP method for a full-page screenshot capture. */
export const CDP_PAGE_CAPTURE_SCREENSHOT = 'Page.captureScreenshot';
/**
 * The document size out of a `Page.getLayoutMetrics` response.
 *
 * CDP returns `cssContentSize` (the whole document) and `cssLayoutViewport` (what is
 * visible); the newer spellings `contentSize` / `layoutViewport` appear on some
 * versions, so both are accepted. Returns undefined when neither is usable, leaving the
 * caller to capture unscaled rather than guess.
 * @param metrics - the raw CDP response.
 * @returns the document and viewport size in CSS pixels.
 */
export function layoutSize(metrics) {
    const pick = (candidates) => {
        for (const candidate of candidates) {
            if (typeof candidate !== 'object' || candidate === null)
                continue;
            const box = candidate;
            if (typeof box.width === 'number' && typeof box.height === 'number' && box.width > 0 && box.height > 0) {
                return { width: box.width, height: box.height };
            }
        }
        return undefined;
    };
    const content = pick([metrics.cssContentSize, metrics.contentSize]);
    const viewport = pick([metrics.cssLayoutViewport, metrics.layoutViewport]);
    if (content === undefined)
        return undefined;
    return { width: content.width, height: content.height, viewportHeight: viewport?.height ?? content.height };
}
/**
 * Map CDP cookies onto the shape `browser_auth` exports.
 *
 * CDP reports a cookie as domain + path rather than a URL, and in seconds rather than
 * milliseconds, so both are converted. Entries missing a name, value or domain are
 * dropped rather than exported as broken cookies the caller cannot restore.
 * @param raw - the `cookies` array from a CDP response, of unknown shape.
 * @returns the mappable cookies.
 */
export function toExportedCookies(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    for (const entry of raw) {
        if (typeof entry !== 'object' || entry === null)
            continue;
        const cookie = entry;
        // An empty domain is as unusable as a missing one: it cannot form a cookie URL, so
        // exporting it would hand the caller something that fails to restore.
        if (typeof cookie.name !== 'string' || cookie.name === '')
            continue;
        if (typeof cookie.value !== 'string')
            continue;
        if (typeof cookie.domain !== 'string' || cookie.domain === '')
            continue;
        const path = typeof cookie.path === 'string' && cookie.path !== '' ? cookie.path : '/';
        // A leading dot means "this domain and its subdomains"; a cookie URL must not keep it.
        const host = cookie.domain.replace(/^\./, '');
        out.push({
            url: `${cookie.secure === true ? 'https' : 'http'}://${host}${path}`,
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path,
            ...cookie.secure === true ? { secure: true } : {},
            ...cookie.httpOnly === true ? { httpOnly: true } : {},
            ...typeof cookie.expires === 'number' && cookie.expires > 0 ? { expirationDate: cookie.expires } : {},
        });
    }
    return out;
}
/**
 * Map an exported cookie onto the fields `Storage.setCookies` expects.
 *
 * An exported cookie may carry only a URL, so the domain and path are recovered from it
 * when they are absent; without either, CDP cannot place the cookie and it is skipped.
 * @param cookie - the cookie to convert.
 * @returns the CDP cookie, or undefined when it lacks a usable domain.
 */
export function toCdpCookie(cookie) {
    let domain = cookie.domain;
    let path = cookie.path;
    if (domain === undefined || domain === '') {
        try {
            const parsed = new URL(cookie.url);
            domain = parsed.hostname;
            if (path === undefined || path === '')
                path = parsed.pathname === '' ? '/' : parsed.pathname;
        }
        catch {
            return undefined;
        }
    }
    if (typeof domain !== 'string' || domain === '')
        return undefined;
    return {
        name: cookie.name,
        value: cookie.value,
        domain,
        path: path === undefined || path === '' ? '/' : path,
        ...cookie.secure === true ? { secure: true } : {},
        ...cookie.httpOnly === true ? { httpOnly: true } : {},
        ...typeof cookie.expirationDate === 'number' ? { expires: cookie.expirationDate } : {},
    };
}
/** CDP method for runtime evaluation (the execute path). */
export const CDP_RUNTIME_EVALUATE = 'Runtime.evaluate';
/** CDP method for navigation. */
export const CDP_PAGE_NAVIGATE = 'Page.navigate';
/** Cap on content returned by a snapshot fetch to keep the wire bounded. */
const SNAPSHOT_LABEL_MAX = 120;
/** Named-key table for `key()`: CDP key/code names + Windows virtual key codes. */
const KEY_SPECS = {
    Enter: { key: 'Enter', code: 'Enter', vk: 13 },
    Tab: { key: 'Tab', code: 'Tab', vk: 9 },
    Escape: { key: 'Escape', code: 'Escape', vk: 27 },
    Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
    Delete: { key: 'Delete', code: 'Delete', vk: 46 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
    Home: { key: 'Home', code: 'Home', vk: 36 },
    End: { key: 'End', code: 'End', vk: 35 },
    PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
    PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
    // Space is the one printable key: CDP needs `text` on the keyDown for the
    // character to land in a focused input; without it the key only scrolls.
    Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
};
/** Supported key names, exported for the tool's enum and error messages. */
export const BROWSER_KEY_NAMES = Object.keys(KEY_SPECS);
/**
 * Localized names a system Downloads folder may carry, in probe order: the
 * English default first, then the Chinese spellings — a zh-CN desktop calls
 * the folder `下载`, a zh-TW one `下載`, and neither is `Downloads`.
 */
const DOWNLOAD_DIR_NAMES = ['Downloads', '下载', '下載'];
/**
 * Resolve the default download directory when the config names none: an
 * existing `XDG_DOWNLOAD_DIR` wins (the freedesktop standard, which is what a
 * localized Linux desktop writes), then the first localized `Downloads` folder
 * that exists under the home directory, and finally the English name — created
 * on first use — when none exists yet.
 * @returns the absolute default download directory.
 */
function defaultDownloadDir() {
    const xdg = process.env.XDG_DOWNLOAD_DIR;
    if (typeof xdg === 'string' && xdg !== '' && existsSync(xdg))
        return xdg;
    for (const name of DOWNLOAD_DIR_NAMES) {
        const candidate = join(homedir(), name);
        if (existsSync(candidate))
            return candidate;
    }
    return join(homedir(), DOWNLOAD_DIR_NAMES[0] ?? 'Downloads');
}
/**
 * Whether a directory entry exists at `path`, judging the ENTRY rather than what it
 * points at.
 *
 * `existsSync` follows links, so a DANGLING symlink — a link whose target does not
 * exist — reads as "nothing here", and a write to that path creates the target
 * instead: outside `downloadDir` whenever the link points out of it. `lstatSync`
 * sees the link itself, which is the only correct answer to "is this name free".
 * @param path - the path to judge.
 * @returns true when any entry (file, directory, link) occupies the name.
 */
function entryExists(path) {
    try {
        lstatSync(path);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * The real path of the deepest existing ancestor of `path` — `path` itself when it
 * exists, otherwise the nearest directory above it that does.
 *
 * `resolve()` normalizes `..` but never follows a link, so nothing textual can tell
 * that `<downloadDir>/link/x.png` leaves the directory through `link`. The first
 * ancestor that exists (judged by lstat, so a dangling link counts — the write would
 * go through it) is the last component whose real location still determines where
 * the bytes land, so that is the one to resolve and check.
 * @param path - an absolute path that may not exist yet.
 * @returns the resolved real path of its deepest existing ancestor.
 */
function realAncestorOf(path) {
    let current = path;
    for (let depth = 0; depth < 64; depth += 1) {
        if (entryExists(current)) {
            try {
                return realpathSync(current);
            }
            catch {
                // The entry vanished between the two calls, or cannot be resolved: the
                // textual path is the best available answer, and the write reports the rest.
                return current;
            }
        }
        const parent = dirname(current);
        if (parent === current)
            return current;
        current = parent;
    }
    return current;
}
/**
 * Browser provider over Electron views. Sessions hold an ordered list of
 * tabs; each tab is one view created by the host. The active tab receives
 * every operation; switching tabs calls the host's optional `showView` and
 * never loses state. Navigation is admitted only for HTTP(S) targets unless
 * {@link ElectronBrowserProviderConfig.httpOnly} is disabled.
 */
export class ElectronBrowserProvider {
    host;
    id = ELECTRON_BROWSER_PROVIDER_ID;
    sessions = new Map();
    httpOnly;
    snapshotMaxElements;
    contentMaxChars;
    downloadDir;
    /**
     * Persistent browsing history, or `undefined` when the user turned it off.
     * Sessions come and go; this record outlives all of them.
     */
    historyStore;
    /** Live settings source; absent when nothing owns a settings document. */
    settingsSource;
    constructor(host, config = {}) {
        this.host = host;
        this.httpOnly = config.httpOnly ?? true;
        this.snapshotMaxElements = config.snapshotMaxElements ?? 60;
        this.contentMaxChars = config.contentMaxChars;
        // Confine downloads AND screenshot saves to a dedicated directory by
        // default: the OS Downloads folder is the human-visible, browser-natural
        // place for written files, and it is the one directory the DSH file
        // sandbox does not have to arbitrate. The localized name is probed so a
        // Chinese desktop (`~/下载`) works without configuring `downloadDir`.
        this.downloadDir = config.downloadDir ?? defaultDownloadDir();
        this.settingsSource = config.settings;
        // Browsing history follows the browser profile's persistence rules (close
        // the interface, lose nothing), and can be switched off from settings.
        this.historyStore = config.history?.enabled === false
            ? undefined
            : new HistoryStore(config.history?.file, {
                ...config.history?.maxEntries !== undefined ? { maxEntries: config.history.maxEntries } : {},
                ...config.history?.maxAgeDays !== undefined ? { maxAgeDays: config.history.maxAgeDays } : {},
            });
        // Route toolbar (host UI) actions into the session model: the human and
        // the agent then always drive the same tabs, history, and navigation.
        this.host.onUserAction?.(action => { void this.handleUserAction(action); });
        // A window the human closed ends the session it showed: the next call opens a
        // clean one instead of driving a page nobody can see.
        this.host.onViewClosed?.(windowId => { void this.handleViewClosed(windowId); });
    }
    /**
     * Usable when the host says it can back views (the self-hosted host probes
     * for a usable Electron binary; the desktop shell is assumed usable).
     */
    available() {
        return this.host.available?.() ?? true;
    }
    /**
     * Open a NEW browser session with its own view. Every call mints a fresh
     * session id and backing view; per-task reuse is owned by the caller (the
     * tool layer caches one session per DSH task). Sessions are isolated from
     * each other: each keeps its own tabs, active tab, and history, and only
     * the active tab of a session is made visible.
     * @param label - optional human-readable label (e.g. the DSH task id) shown
     * in the window title so a human can tell which task's page is visible.
     */
    open(label) {
        const handle = this.host.createView();
        const id = `browser:${randomUUID()}`;
        // Group the session's views under its own window (one window per
        // session), carrying the label for the window title. Hosts without
        // groupView keep the shared-window behavior.
        this.host.groupView?.(handle, id, label);
        this.sessions.set(id, { id, label, tabs: [{ id: `tab:${randomUUID()}`, handle }], activeIndex: 0, history: [], nextSeq: 1 });
        return Promise.resolve(id);
    }
    /** Open a URL in the active tab (default) or a new tab. */
    async openUrl(session, request, signal) {
        const s = this.session(session);
        if (request.newTab === true) {
            this.newTab(s);
        }
        await this.navigate(session, { url: request.url }, signal);
    }
    /** List the session's tabs with their titles. */
    async listTabs(session) {
        const s = this.session(session);
        const result = [];
        for (let i = 0; i < s.tabs.length; i++) {
            const tab = s.tabs[i];
            if (tab === undefined)
                continue; // defensive: array can shift under concurrency
            result.push({
                id: tab.id,
                url: await this.currentUrl(tab.handle).catch(() => ''),
                active: i === s.activeIndex,
            });
        }
        return result;
    }
    /** Switch to a tab by id, making its view visible. */
    switchTab(session, tabId) {
        const found = this.locateTab(session, tabId);
        found.s.activeIndex = found.index;
        this.showActive(found.s);
        return Promise.resolve();
    }
    /** Close one tab; closing the active tab activates the next. */
    closeTab(session, tabId) {
        const found = this.locateTab(session, tabId);
        const s = found.s;
        const index = found.index;
        const removed = s.tabs[index];
        if (removed !== undefined) {
            s.tabs.splice(index, 1);
            this.host.destroyView(removed.handle);
        }
        if (s.tabs.length === 0) {
            // Session keeps one blank tab so it stays usable.
            this.newTab(s);
        }
        else if (index < s.activeIndex) {
            // Closing a tab before the active one shifts the array left; keep the
            // same tab active by decrementing the index.
            s.activeIndex -= 1;
        }
        else if (index === s.activeIndex) {
            // The active tab itself was closed; activate the next tab (the one that
            // shifted into its place), or the last one when the closed tab was the
            // last.
            s.activeIndex = Math.min(index, s.tabs.length - 1);
        }
        this.showActive(s);
        return Promise.resolve();
    }
    /**
     * Find a tab by id, preferring the calling session. Tab ids are globally
     * unique UUIDs, so when the calling session does not hold the tab (the tool
     * layer's session resolution can drift from the session that opened it),
     * fall back to locating it in any other session instead of failing — the
     * caller explicitly named a tab, so acting on it is what they want. Throws
     * BROWSER_TAB_UNKNOWN with the session's actual tabs when the id exists
     * nowhere.
     */
    locateTab(session, tabId) {
        const s = this.session(session);
        // Accept the bare uuid as well as the "tab:<uuid>" form the tools print:
        // ids are globally unique, so requiring the printed prefix only produced a
        // misleading "is not open in this session" error that listed the very tab
        // the caller had just named.
        const wanted = stripTabPrefix(tabId);
        const own = s.tabs.findIndex(tab => stripTabPrefix(tab.id) === wanted);
        if (own >= 0)
            return { s, index: own };
        // Deliberately NOT searched across other sessions. Accepting a bare uuid and
        // searching elsewhere are different things: ids are globally unique, so the first is
        // harmless convenience, but the second lets a stale id close or switch a tab that
        // belongs to another task — or to the human — while reporting success, which
        // contradicts the isolation the tools promise.
        const ownIds = s.tabs.map(t => t.id).join(', ') || '(none)';
        throw new BrowserError(`browser: tab "${tabId}" is not open in this session (session tabs: ${ownIds})`, 'BROWSER_TAB_UNKNOWN');
    }
    /** Close every tab and reset to one blank tab. */
    reset(session) {
        const s = this.session(session);
        for (const tab of s.tabs)
            this.host.destroyView(tab.handle);
        s.tabs.length = 0;
        this.newTab(s);
        s.activeIndex = 0;
        this.showActive(s);
        return Promise.resolve();
    }
    /** Navigate the active tab's view to a URL, honoring HTTP(S)-only admission. */
    async navigate(session, request, signal) {
        const s = this.session(session);
        const { handle } = this.activeTab(s);
        const url = request.url;
        try {
            if (this.httpOnly) {
                let parsed;
                try {
                    parsed = new URL(url);
                }
                catch {
                    throw new BrowserError(`browser: refusing navigation to unparseable URL "${url}"`, 'BROWSER_NAVIGATION_BLOCKED');
                }
                if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                    throw new BrowserError(`browser: refusing navigation to non-HTTP(S) URL "${url}"`, 'BROWSER_NAVIGATION_BLOCKED');
                }
            }
            signal?.throwIfAborted();
            // Page.navigate can hang on an unreachable/slow host; bound it like the
            // evaluate paths so a wedged navigation surfaces as an error instead of
            // blocking the tool call forever.
            const timeoutMs = 30_000;
            // Document identity of the page we are leaving (see settleDocument).
            const before = await this.documentStamp(handle);
            const result = await withTimeout(handle.sendCommand(CDP_PAGE_NAVIGATE, { url }), timeoutMs, signal, `browser: navigation timed out after ${timeoutMs}ms`, 
            // Best-effort: cancel the in-flight navigation so a wedged load does
            // not leave the debugger queue busy.
            () => { void handle.sendCommand('Page.stopLoading').catch(() => { }); });
            // Page.navigate resolves even when the navigation fails; surface the
            // failure instead of leaving a silent white screen.
            const errorText = result.errorText;
            if (typeof errorText === 'string' && errorText !== '') {
                throw new BrowserError(`browser: navigation to "${url}" failed: ${errorText}`, 'BROWSER_NAVIGATION_FAILED');
            }
            // Record as soon as the navigation has committed: history bookkeeping must
            // not wait on the best-effort settle below (which only delays what the
            // NEXT observation sees, not whether this action happened).
            // The page has already moved by now, so a caller that aborted must be told that rather
            // than handed a success: settleDocument returns quietly on abort by design, so without
            // this the whole path completes exception-free — success reported, success recorded, and
            // the visit written to the persistent history for a navigation nobody awaits any more.
            signal?.throwIfAborted();
            this.record(s, 'navigate', { url }, true);
            await this.settleDocument(handle, before, signal);
            this.recordVisit(s, handle);
            this.showActive(s);
        }
        catch (error) {
            if (!(error instanceof BrowserError && error.code === 'BROWSER_NAVIGATION_BLOCKED')) {
                this.record(s, 'navigate', { url }, false, { error: String(error) });
            }
            throw error;
        }
    }
    /**
     * A per-document stamp: `performance.timeOrigin` is unique per document load,
     * so it tells a same-URL reload and an A→B→A redirect apart from the document
     * that was current before the navigation. Empty string when unreadable.
     */
    async documentStamp(handle) {
        const probe = await this.documentProbe(handle);
        return probe?.stamp ?? '';
    }
    /**
     * One cheap in-page reading of the document's identity and parse state.
     *
     * Returns null when the page did NOT answer (mid-commit, execution context
     * destroyed) — the caller keeps waiting. A page that answered with an
     * unexpected shape (an override or a non-conforming host; the production
     * expression always yields a string) is reported as `unknown` rather than as
     * "no answer": blocking the navigation for the whole budget on a page that
     * demonstrably responded has no upside.
     */
    async documentProbe(handle) {
        try {
            const result = await withTimeout(handleSendEvaluate(handle, 'String(performance.timeOrigin) + "|" + document.readyState'), 3_000, undefined, 'browser: document probe timed out');
            if (!result.ok)
                return null;
            if (typeof result.value !== 'string')
                return { stamp: '', readyState: 'unknown' };
            const [stamp = '', readyState = ''] = result.value.split('|');
            return { stamp, readyState };
        }
        catch {
            return null;
        }
    }
    /**
     * Page.navigate resolves at navigation COMMIT, not at load: the new document
     * is already current (so location.href and document.title are the new page's)
     * while its DOM is still being parsed. browser_open snapshots immediately
     * after navigating, which is why it could report the right title with zero
     * interactive elements — and why a separate browser_snapshot right after
     * always found them.
     *
     * Wait — bounded, best-effort — for the new document to settle: readyState
     * must reach interactive/complete AND the document identity must have
     * changed. A page that never settles must not fail a navigation that already
     * succeeded, so a timeout here is swallowed.
     */
    async settleDocument(handle, before, signal) {
        const started = Date.now();
        const deadline = started + SETTLE_TIMEOUT_MS;
        // The document is being replaced, so the synthetic pointer drawn into the old one
        // is gone. Dropping the remembered position is what lets it be painted again:
        // without this, a paint at coincidentally identical coordinates would be skipped
        // and the pointer would never come back after a navigation.
        forgetCursor(handle);
        for (;;) {
            if (signal?.aborted === true)
                return;
            // A probe failure is expected while the navigation commits (the context is
            // being destroyed) — keep polling rather than giving up.
            const probe = await this.documentProbe(handle);
            if (probe !== null) {
                const settled = probe.readyState === 'interactive'
                    || probe.readyState === 'complete'
                    || probe.readyState === 'unknown';
                const isNewDocument = before === '' || probe.stamp === '' || probe.stamp !== before;
                // The common case: the new document exists and is parsed — return now.
                if (settled && isNewDocument)
                    return;
                // Same document (hash navigation, cancelled/aborted load): there is no
                // parse to wait for, so do not burn the budget. Outlast the brief
                // window in which the OUTGOING document may still answer instead.
                if (settled && Date.now() - started >= SETTLE_GRACE_MS)
                    return;
            }
            if (Date.now() >= deadline)
                return;
            await delay(SETTLE_POLL_MS, signal);
        }
    }
    /**
     * Make sure the active tab's view can actually receive synthesized input.
     * Chromium drops `Input.*` events for a view with no display surface, so this
     * runs before click/type/key and fails loudly (BROWSER_VIEW_NOT_PRESENTED)
     * rather than reporting a success the page never saw.
     * @param s - the session whose active view must be presented.
     * @param signal - optional cancellation.
     * @returns the view the session's active tab has AFTER the presentation barrier.
     */
    async present(s, signal) {
        const { handle } = this.activeTab(s);
        const present = this.host.presentView?.bind(this.host);
        if (present === undefined) {
            this.showActive(s);
            return this.activeTab(s).handle;
        }
        signal?.throwIfAborted();
        const timeoutMs = 10_000;
        try {
            await withTimeout(present(handle, s.label), timeoutMs, signal, `browser: presenting the page view timed out after ${timeoutMs}ms`);
            this.showActive(s);
        }
        catch (error) {
            throw new BrowserError(`browser: the page view is not presented, so synthesized input would be silently dropped (${String(error)})`, 'BROWSER_VIEW_NOT_PRESENTED', { cause: error });
        }
        // Read the active tab AGAIN. `present` is a round-trip that can take up to the budget
        // above, and the human is invited to drive the same window (a toolbar tab switch, a
        // closed window) while the agent waits. Chromium answers `Input.*` with success even
        // for a view that has no display surface, so dispatching to a handle that is no longer
        // the visible one does not fail — it silently lands nowhere, or on the wrong page.
        //
        // Returning the re-read handle was wrong, though: `handle` above is the one that was
        // actually presented, and if the active tab changed during the round trip then the
        // re-read one was never presented at all. Handing it back meant the caller dispatched
        // to a view with no display surface — the exact failure this method exists to prevent,
        // arrived at from the other side. Either the presented view is still the active one, or
        // the caller must be told rather than given something else to aim at.
        const live = this.activeTab(s).handle;
        if (live !== handle) {
            throw new BrowserError('browser: the active tab changed while the page view was being presented, so synthesized input would go to an unshown view — retry, and the new page will be presented instead', 'BROWSER_VIEW_CHANGED');
        }
        return handle;
    }
    /**
     * Refuse to send synthesized input to a view that is no longer the one it was located
     * against.
     *
     * `locateHandle` was captured before a page-side locate that can consume its whole
     * 10s budget; the session's active tab is re-read afterwards. If they differ, the human
     * switched tabs mid-flight (the product's whole point is that they can take over), and
     * the coordinates belong to one page while the dispatch would go to another. Comparing
     * the handles turns that into a loud, retryable error instead of input the caller
     * believes landed.
     * @param session - the session id, for the message.
     * @param locateHandle - the view the locate ran in.
     * @param liveHandle - the view that is active now.
     */
    assertSameView(session, locateHandle, liveHandle) {
        if (locateHandle === liveHandle)
            return;
        throw new BrowserError(`browser: the session's active view changed while the element was being located (session ${session}); the operation was not dispatched — retry it`, 'BROWSER_VIEW_CHANGED');
    }
    /**
     * Give the view web focus before synthesizing keyboard input.
     *
     * A renderer only delivers key events to the view that holds web focus. A
     * view that was created but never clicked holds none — and `Input` events
     * injected over CDP do not grant it — so the FIRST `browser_key` of a fresh
     * session vanished inside the renderer while the command still answered
     * success. Hosts that cannot focus a view (a test double, a different shell
     * adapter) simply have no `focus`, and nothing changes for them.
     */
    async focusView(handle) {
        if (handle.focus === undefined)
            return;
        try {
            // Bounded, unlike the rest of this call: the child RPC has no timeout of its own,
            // and this runs before typing, so an unresponsive child would hang browser_key for
            // good. A timeout is caught below exactly like any other focus failure, so the
            // best-effort contract is unchanged.
            await withTimeout(handle.focus(), 5_000, undefined, 'browser: focusing the view timed out');
        }
        catch {
            // Best-effort: a view that refuses focus must not fail the caller's key
            // press; the dispatch below reports a real channel failure itself.
        }
    }
    /** Execute JS in the active tab's page context. */
    async execute(session, request, signal) {
        this.assertActionAllowed('execute');
        const s = this.session(session);
        const { handle } = this.activeTab(s);
        signal?.throwIfAborted();
        try {
            // Wrap the script in a Function so `return` statements are legal and
            // request.args arrive as `arguments[0..n]`. A bare script handed to CDP
            // Runtime.evaluate is an expression context — a leading `return` would
            // be a syntax error, and an object-literal script (`{...}`) would parse
            // as a block. So: if the script already starts with `return`, use it as
            // the body verbatim; otherwise wrap it as `return (expr)` so both
            // expression and object-literal forms evaluate to their value. Args are
            // embedded as a JSON array literal; unserializable members become null.
            const body = /^\s*return\b/.test(request.script)
                ? request.script
                : `return (${request.script})`;
            const hasArgs = request.args !== undefined && request.args.length > 0;
            const expression = hasArgs
                ? `(function(){ const __dshArgs = ${JSON.stringify(request.args)}; return Function(${JSON.stringify(body)}).apply(null, __dshArgs) })()`
                : `(function(){ return Function(${JSON.stringify(body)})() })()`;
            // CDP Runtime.evaluate can hang indefinitely on a not-yet-loaded page
            // (navigate returned but the renderer has not committed). Bound it so a
            // stuck call surfaces as BROWSER_EXECUTE_TIMEOUT instead of wedging the
            // whole tool call. The caller's signal wins when it fires first.
            const timeoutMs = request.timeoutMs ?? 30_000;
            const result = await withTimeout(handle.sendCommand(CDP_RUNTIME_EVALUATE, {
                expression,
                returnByValue: true,
                awaitPromise: true,
            }), timeoutMs, signal, `browser: execute timed out after ${timeoutMs}ms`, 
            // Best-effort: kill the wedged page script so the renderer (and the
            // debugger queue) is not stuck behind a busy loop forever.
            () => terminatePage(handle));
            if (result.exceptionDetails !== undefined) {
                const detail = result.exceptionDetails;
                const exception = detail.exception?.description ?? detail.text ?? 'unknown exception';
                this.record(s, 'execute', { script: request.script }, false, { error: exception });
                return { ok: false, exception };
            }
            const value = result.result?.value ?? null;
            this.record(s, 'execute', {
                script: request.script,
                ...request.args !== undefined && request.args.length > 0 ? { args: request.args } : {},
            }, true, { result: typeof value === 'string' ? value.slice(0, 500) : JSON.stringify(value).slice(0, 500) });
            return { ok: true, value };
        }
        catch (error) {
            // A caller that aborted is not a failure of the page: report its own reason, or the
            // cancellation surfaces as "execute failed: AbortError" and — if the caller's reason
            // happens to be named TimeoutError — as "timed out after 30000ms", quoting a budget
            // that belongs to the caller rather than to this call.
            if (signal?.aborted)
                throw signal.reason;
            if (error instanceof Error && error.name === 'TimeoutError') {
                throw new BrowserError(`browser: execute timed out after ${request.timeoutMs ?? 30_000}ms`, 'BROWSER_EXECUTE_TIMEOUT', { cause: error });
            }
            throw new BrowserError(`browser: execute failed: ${String(error)}`, 'BROWSER_EXECUTE_FAILED', { cause: error });
        }
    }
    /**
     * Poll until the active tab's page is ready (and optional URL/selector
     * match), or the budget runs out. Returns a verdict instead of throwing on
     * timeout — the caller (model) decides what a miss means. Polling evaluates
     * in the CURRENT document, so after a navigation the old document may
     * briefly answer; pass the expected `url` to disambiguate.
     */
    async waitFor(session, request, signal) {
        const tab = this.activeTab(this.session(session));
        signal?.throwIfAborted();
        const timeoutMs = request.timeoutMs ?? 30_000;
        const deadline = Date.now() + timeoutMs;
        const url = request.url ?? '';
        const selector = request.selector ?? '';
        const checkLoaded = request.loaded !== false;
        const expression = `(() => {
      const wantUrl = ${JSON.stringify(url)}
      const wantSelector = ${JSON.stringify(selector)}
      const inDoc = (doc, sel) => {
        if (doc.querySelector(sel)) return true
        for (const el of doc.querySelectorAll('iframe')) {
          try { const d = el.contentDocument; if (d && inDoc(d, sel)) return true } catch { /* cross-origin */ }
        }
        return false
      }
      const href = location.href
      // Exact match wins; otherwise prefix-match within the SAME origin only,
      // so wantUrl "https://a.com" never matches a cross-origin page whose
      // host merely starts with the same characters ("https://a.com.evil.com").
      let urlOk = wantUrl === '' || href === wantUrl
      if (!urlOk && wantUrl !== '') {
        try {
          const want = new URL(wantUrl)
          const got = new URL(href)
          urlOk = want.origin === got.origin && href.startsWith(wantUrl)
        } catch { urlOk = false }
      }
      const loadedOk = document.readyState === 'complete' || document.readyState === 'interactive'
      const foundOk = wantSelector === '' || inDoc(document, wantSelector)
      return { urlOk, loadedOk, foundOk }
    })()`;
        for (;;) {
            const result = await withTimeout(handleSendEvaluate(tab.handle, expression), Math.min(5_000, Math.max(250, deadline - Date.now())), signal, 'browser: wait poll timed out', () => terminatePage(tab.handle));
            if (!result.ok) {
                throw new BrowserError(`browser: wait failed: ${result.exception}`, 'BROWSER_WAIT_FAILED');
            }
            const state = result.value;
            const urlOk = url === '' || state.urlOk === true;
            const loadedOk = !checkLoaded || state.loadedOk === true;
            const foundOk = selector === '' || state.foundOk === true;
            if (urlOk && loadedOk && foundOk) {
                return { ready: true, reason: 'condition met' };
            }
            if (Date.now() >= deadline) {
                const misses = [];
                if (!urlOk)
                    misses.push(`url not yet "${url}"`);
                if (!loadedOk)
                    misses.push('page not loaded');
                if (!foundOk)
                    misses.push(`selector "${selector}" not found`);
                return { ready: false, reason: misses.join('; ') };
            }
            // Sleep between polls, abortable by the caller.
            // Sleep between polls; delay() removes its abort listener on both paths, which the
            // hand-rolled version here did not — a 30s wait leaked about 150 of them.
            await delay(200, signal);
        }
    }
    /** Produce an AI-friendly snapshot of the active tab. */
    async snapshot(session, signal) {
        const s = this.session(session);
        const tab = this.activeTab(s);
        signal?.throwIfAborted();
        const script = `(() => {
      const cap = ${String(this.snapshotMaxElements)}
      const url = location.href
      const title = document.title || undefined
      // Collect interactive elements from the top document AND from shadow
      // roots and same-origin iframes (cross-origin iframes stay opaque — the
      // browser forbids reading them, and so does this snapshot). Elements
      // inside iframes carry a frame flag so the model knows DOM selectors
      // are frame-scoped; coordinates below are always top-document.
      const SELECTOR = 'input, textarea, select, button, a[href], [role="button"], [role="searchbox"], [contenteditable="true"]'
      const els = []
      const seen = new Set()
      const collect = (doc, inFrame) => {
        if (seen.has(doc)) return
        seen.add(doc)
        const hosts = []
        for (const el of doc.querySelectorAll('*')) {
          if (el.matches(SELECTOR)) els.push({ el, inFrame })
          if (el.shadowRoot) hosts.push({ doc: el.shadowRoot, inFrame })
          if (el.tagName === 'IFRAME') {
            try { const d = el.contentDocument; if (d) hosts.push({ doc: d, inFrame: true }) } catch { /* cross-origin */ }
          }
        }
        for (const h of hosts) collect(h.doc, h.inFrame)
      }
      collect(document, false)
      // Absolute viewport coordinates in the TOP document: iframe content is
      // offset by each ancestor iframe's rect, so coordinate clicks land on
      // the right element no matter which frame it lives in.
      const absRect = (el, doc) => {
        const r = el.getBoundingClientRect()
        let x = r.x, y = r.y
        let d = doc
        while (d && d.defaultView && d.defaultView.frameElement) {
          const fr = d.defaultView.frameElement.getBoundingClientRect()
          x += fr.x; y += fr.y
          d = d.defaultView.frameElement.ownerDocument
        }
        return { x, y, w: r.width, h: r.height }
      }
      const out = []
      for (const { el, inFrame } of els) {
        if (out.length >= cap) break
        const r = el.getBoundingClientRect()
        // Cheap layout check first; only force style recalc when it passes.
        if (r.width < 4 || r.height < 4) continue
        const cs = getComputedStyle(el)
        if (cs.visibility === 'hidden' || cs.display === 'none') continue
        const kind = el.tagName === 'INPUT' ? (el.type === 'checkbox' ? 'checkbox' : (el.type === 'submit' || el.type === 'button' ? 'button' : 'input'))
          : el.tagName === 'TEXTAREA' ? 'textarea'
          : el.tagName === 'SELECT' ? 'select'
          : el.tagName === 'BUTTON' ? 'button'
          : el.tagName === 'A' ? 'link' : 'other'
        const label = (el.getAttribute('aria-label') || el.placeholder || el.textContent || el.value || el.name || el.id || '').toString().replace(/\\s+/g, ' ').trim().slice(0, ${String(SNAPSHOT_LABEL_MAX)})
        if (!label && kind !== 'link') continue
        const a = absRect(el, el.ownerDocument)
        out.push({
          ref: out.length + 1,
          kind,
          label,
          selector: el.id ? '#' + CSS.escape(el.id) : (el.name ? '[name=' + JSON.stringify(el.name) + ']' : ''),
          x: Math.round(a.x + a.w / 2),
          y: Math.round(a.y + a.h / 2),
          ...inFrame ? { frame: true } : {},
        })
      }
      const challenge = ${CHALLENGE_DETECT_EXPRESSION}
      return { url, title, elements: out, truncated: out.length >= cap, challenge }
    })()`;
        // Same hang guard as execute: a renderer that has not committed after
        // navigate would otherwise block snapshot forever.
        const timeoutMs = 30_000;
        const result = await withTimeout(handleSendEvaluate(tab.handle, script), timeoutMs, signal, `browser: snapshot timed out after ${timeoutMs}ms`, () => terminatePage(tab.handle));
        if (!result.ok)
            throw new BrowserError(`browser: snapshot evaluation failed: ${result.exception}`, 'BROWSER_SNAPSHOT_FAILED');
        const value = result.value;
        return value;
    }
    /**
     * Read the active tab's accessibility tree: semantic roles/names/states for
     * every interactive node (Chrome's `computedRole`/`computedName` when
     * available, tag/attribute inference otherwise). Pierces same-origin
     * iframes and shadow roots like the snapshot; cross-origin frames stay
     * opaque. Coordinates are top-document viewport-relative, so a node can
     * also be driven by click/type.
     */
    async a11y(session, request, signal) {
        const s = this.session(session);
        const tab = this.activeTab(s);
        signal?.throwIfAborted();
        const includeHidden = request.includeHidden === true;
        // 150 rather than 500. The cap fills on any real page, and 500 nodes measured 38,953
        // characters — 10k-13k tokens for a single call. A caller that needs more asks for it.
        const maxNodes = Math.max(10, Math.min(5000, Math.floor(request.maxNodes ?? 150)));
        const script = `(() => {
      const includeHidden = ${String(includeHidden)}
      const maxNodes = ${String(maxNodes)}
      const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE'])
      const ACTIONABLE = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'slider', 'spinbutton', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'switch', 'option', 'summary', 'treeitem', 'scrollbar'])
      const CONTENT_NAMED = new Set(['button', 'link', 'heading', 'summary', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'treeitem', 'option', 'listitem', 'switch', 'checkbox', 'radio', 'searchbox', 'textbox'])
      const out = []
      const seen = new Set()
      const ownText = (el) => Array.from(el.childNodes).filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent || '').join('').trim()
      const visible = (el) => {
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        return r.width >= 4 && r.height >= 4 && cs.visibility !== 'hidden' && cs.display !== 'none'
      }
      const roleOf = (el) => {
        const computed = el.computedRole
        if (typeof computed === 'string' && computed && computed !== 'none' && computed !== 'generic') return computed
        const tag = el.tagName.toLowerCase()
        if (el instanceof HTMLAnchorElement) return el.hasAttribute('href') ? 'link' : 'generic'
        if (tag === 'button') return 'button'
        if (tag === 'textarea') return 'textbox'
        if (tag === 'select') return el.hasAttribute('multiple') ? 'listbox' : 'combobox'
        if (tag === 'img') return el.getAttribute('alt') === '' ? 'presentation' : 'img'
        if (/^h[1-6]$/.test(tag)) return 'heading'
        if (tag === 'ul' || tag === 'ol') return 'list'
        if (tag === 'li') return 'listitem'
        if (tag === 'nav') return 'navigation'
        if (tag === 'main') return 'main'
        if (tag === 'form') return 'form'
        if (tag === 'table') return 'table'
        if (tag === 'tr') return 'row'
        if (tag === 'td') return 'cell'
        if (tag === 'th') return 'columnheader'
        if (tag === 'dialog') return 'dialog'
        if (tag === 'summary') return 'button'
        if (tag === 'input') {
          const t = el.type
          if (t === 'checkbox') return 'checkbox'
          if (t === 'radio') return 'radio'
          if (t === 'range') return 'slider'
          if (t === 'number') return 'spinbutton'
          if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image') return 'button'
          if (t === 'hidden') return 'none'
          if (t === 'search') return 'searchbox'
          return 'textbox'
        }
        return 'generic'
      }
      const nameOf = (el, role) => {
        const computed = el.computedName
        if (typeof computed === 'string' && computed && computed.trim() !== '') return computed.trim()
        const aria = el.getAttribute('aria-label')
        if (aria) return aria
        const labelledby = el.getAttribute('aria-labelledby')
        if (labelledby) {
          const ref = document.getElementById(labelledby.split(/\\s+/)[0])
          if (ref) {
            const t = (ref.textContent || '').trim()
            if (t) return t
          }
        }
        if (el.hasAttribute('alt')) return el.getAttribute('alt')
        if (el.hasAttribute('title')) return el.getAttribute('title')
        if (el.placeholder) return el.placeholder
        if (CONTENT_NAMED.has(role)) {
          const t = ownText(el)
          if (t) return t
        }
        if (el.id) {
          const lbl = document.querySelector('label[for=' + JSON.stringify(el.id) + ']')
          if (lbl) {
            const t = (lbl.textContent || '').trim()
            if (t) return t
          }
        }
        return ''
      }
      const valueOf = (el) => {
        if (el instanceof HTMLInputElement) return el.type === 'checkbox' || el.type === 'radio' ? null : el.value
        if (el instanceof HTMLTextAreaElement) return el.value
        if (el instanceof HTMLSelectElement) {
          const o = el.options[el.selectedIndex]
          return o ? (o.textContent || '').trim() : null
        }
        if (el.isContentEditable) return (el.textContent || '').trim()
        return null
      }
      const statesOf = (el) => {
        const st = []
        if (!el.disabled) st.push('enabled'); else st.push('disabled')
        if (el.checked) st.push('checked'); else if (el.getAttribute('aria-checked') === 'false') st.push('unchecked')
        const expanded = el.getAttribute('aria-expanded')
        if (expanded === 'true') st.push('expanded')
        if (expanded === 'false') st.push('collapsed')
        if (el.required) st.push('required')
        if (el.readOnly) st.push('readonly')
        if (el.selected) st.push('selected')
        const pressed = el.getAttribute('aria-pressed')
        if (pressed === 'true') st.push('pressed')
        return st
      }
      const depthOf = (el) => {
        let d = 0
        let p = el.parentElement
        while (p) { d++; p = p.parentElement }
        return d
      }
      const absRect = (el, doc) => {
        const r = el.getBoundingClientRect()
        let x = r.x, y = r.y
        let d = doc
        while (d && d.defaultView && d.defaultView.frameElement) {
          const fr = d.defaultView.frameElement.getBoundingClientRect()
          x += fr.x; y += fr.y
          d = d.defaultView.frameElement.ownerDocument
        }
        return { x, y, w: r.width, h: r.height }
      }
      const walk = (doc, inFrame, baseDepth) => {
        if (seen.has(doc)) return
        seen.add(doc)
        for (const el of doc.querySelectorAll('*')) {
          if (out.length >= maxNodes) return
          if (SKIP.has(el.tagName)) continue
          if (el.shadowRoot) walk(el.shadowRoot, inFrame, baseDepth + 1)
          if (el.tagName === 'IFRAME') {
            try { const d = el.contentDocument; if (d) walk(d, true, baseDepth + 1) } catch { /* cross-origin */ }
          }
          const role = roleOf(el)
          if (role === 'none' || role === 'presentation' || role === 'generic') continue
          if (!includeHidden && !visible(el)) continue
          const name = nameOf(el, role)
          if (!name && !ACTIONABLE.has(role)) continue
          const a = absRect(el, el.ownerDocument)
          out.push({
            ref: out.length + 1,
            role,
            name: name.slice(0, 120),
            value: valueOf(el),
            states: statesOf(el),
            depth: baseDepth + depthOf(el),
            // Same derivation as the snapshot collector: an id or a name is what makes a node
            // something the caller can point at without guessing at its text. The tool-layer
            // schema declared this field before this line existed, so the schema was promising
            // a value the tool never sent.
            selector: el.id ? '#' + CSS.escape(el.id) : (el.name ? '[name=' + JSON.stringify(el.name) + ']' : ''),
            tag: el.tagName.toLowerCase(),
            x: Math.round(a.x + a.w / 2),
            y: Math.round(a.y + a.h / 2),
            ...inFrame ? { frame: true } : {},
          })
        }
      }
      walk(document, false, 0)
      return { url: location.href, title: document.title || undefined, count: out.length, nodes: out, truncated: out.length >= maxNodes }
    })()`;
        const timeoutMs = 30_000;
        const result = await withTimeout(handleSendEvaluate(tab.handle, script), timeoutMs, signal, `browser: a11y timed out after ${timeoutMs}ms`, () => terminatePage(tab.handle));
        if (!result.ok)
            throw new BrowserError(`browser: a11y evaluation failed: ${result.exception}`, 'BROWSER_A11Y_FAILED');
        const value = result.value;
        this.record(s, 'a11y', { includeHidden, maxNodes }, true, { result: `${value.count} nodes` });
        return value;
    }
    /** Check whether a human-verification challenge is blocking the active tab. */
    async detectChallenge(session, signal) {
        const s = this.session(session);
        const tab = this.activeTab(s);
        signal?.throwIfAborted();
        const timeoutMs = 15_000;
        const result = await withTimeout(handleSendEvaluate(tab.handle, CHALLENGE_DETECT_EXPRESSION), timeoutMs, signal, `browser: challenge detection timed out after ${timeoutMs}ms`, () => terminatePage(tab.handle));
        if (!result.ok) {
            throw new BrowserError(`browser: challenge detection failed: ${result.exception}`, 'BROWSER_CHALLENGE_DETECT_FAILED');
        }
        const value = result.value;
        return { blocked: value.blocked === true, kind: value.kind, reason: value.reason };
    }
    /** Fetch page content in a requested format. */
    async content(session, request, signal) {
        const tab = this.activeTab(this.session(session));
        signal?.throwIfAborted();
        const selector = request.selector ?? '';
        const format = request.format;
        // Per-format caps. A full HTML document is enormous, but the same limit applied to
        // plain text is no limit at all (a whole page of text measured 25,882 characters).
        // This bounds the common case instead of letting one call spend 25k-33k tokens.
        //
        // The plugin config overrides the lot when it is set — see `contentMaxChars`. The caller's
        // own `maxChars` still outranks both: an explicit per-call bound is the most specific
        // statement of intent there is.
        const maxChars = request.maxChars
            ?? this.contentMaxChars
            ?? (format === 'html' || format === 'json' ? 50_000 : 20_000);
        const script = `(() => {
      const root = ${selector === '' ? 'document.body' : `document.querySelector(${JSON.stringify(selector)})`}
      if (!root) return { ok: false, reason: 'selector not found' }
      const fmt = ${JSON.stringify(format)}
      // Both walkers pierce shadow roots and same-origin iframes (cross-origin
      // iframes stay opaque — the browser forbids reading them).
      let content = ''
      if (fmt === 'txt') {
        // Prefer the browser's own rendered text.
        //
        // Walking text nodes and joining them is not equivalent: pages that wrap
        // every character in its own element — one-character spans for a
        // per-character animation, which is common — produce one text node per
        // letter, and joining those with spaces turns every word into a column of
        // letters. The rendered text reassembles them the way a reader sees them,
        // and it also honours visibility, so hidden text does not leak out.
        // (No backticks in this comment: it lives inside a template literal.)
        const rendered = typeof root.innerText === 'string' ? root.innerText : ''
        if (rendered.trim() !== '') {
          content = rendered
        } else {
          // Fallback for nodes without layout (a detached root, or a fragment):
          // collect text directly, still piercing shadow roots and same-origin
          // iframes, and join without inventing separators beyond what the markup
          // already implies.
          const parts = []
          const textWalk = (node) => {
            if (node.nodeType === Node.TEXT_NODE) { const t = (node.textContent || '').trim(); if (t) parts.push(t); return }
            if (node.nodeType !== Node.ELEMENT_NODE) return
            const tag = node.tagName.toLowerCase()
            if (tag === 'script' || tag === 'style' || tag === 'noscript') return
            if (tag === 'iframe') {
              try { const d = node.contentDocument; if (d && d.body) for (const c of d.body.childNodes) textWalk(c) } catch { /* cross-origin */ }
              return
            }
            if (node.shadowRoot) for (const c of node.shadowRoot.childNodes) textWalk(c)
            for (const child of node.childNodes) textWalk(child)
          }
          textWalk(root)
          content = parts.join(' ')
        }
      }
      else if (fmt === 'html') content = root.outerHTML || ''
      // A DOM element has no own enumerable properties — everything lives on the prototype
      // chain — so JSON.stringify(root) is always "{}". That is not a structured view of
      // the page, it is an empty object the caller will read as "no data here" and then
      // retry with other selectors. Serialise the markup instead, which is what a caller
      // asking for JSON of an element can actually use.
      else if (fmt === 'json') content = JSON.stringify({ html: root.outerHTML, tag: root.tagName.toLowerCase() })
      else {
        // markdown: headings, paragraphs, links, lists (best-effort)
        const parts = []
        const walk = (node) => {
          if (node.nodeType === Node.TEXT_NODE) { const t = (node.textContent || '').trim(); if (t) parts.push(t); return }
          if (node.nodeType !== Node.ELEMENT_NODE) return
          const tag = node.tagName.toLowerCase()
          if (tag === 'script' || tag === 'style' || tag === 'noscript') return
          if (tag === 'iframe') {
            try { const d = node.contentDocument; if (d && d.body) for (const c of d.body.childNodes) walk(c) } catch { /* cross-origin */ }
            return
          }
          if (node.shadowRoot) for (const c of node.shadowRoot.childNodes) walk(c)
          if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4') parts.push('\\n' + '#'.repeat(Number(tag[1])) + ' ' + (node.textContent || '').trim() + '\\n')
          else if (tag === 'a') { const t = (node.textContent || '').trim(); if (t) parts.push('[' + t + '](' + (node.href || '') + ')') }
          else if (tag === 'li') parts.push('  - ' + (node.textContent || '').trim())
          else if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article') { const t = (node.textContent || '').trim(); if (t) parts.push(t + '\\n') }
          else { for (const child of node.childNodes) walk(child) }
        }
        walk(root)
        // Join without a separator: each part already carries its own trailing
        // newline, so a space join would smear headings/links into run-on text.
        content = parts.join('')
      }
      const truncated = content.length > ${String(maxChars)}
      return { ok: true, content: content.slice(0, ${String(maxChars)}), truncated }
    })()`;
        // Honor a per-call timeout: content evaluation can hang on a heavy page,
        // so a caller-supplied budget bounds it. Unlike a bare signal entry check,
        // withTimeout also interrupts a call already in flight.
        const timeoutMs = request.timeoutMs ?? 30_000;
        const result = await withTimeout(handleSendEvaluate(tab.handle, script), timeoutMs, signal, `browser: content timed out after ${timeoutMs}ms`, () => terminatePage(tab.handle));
        if (!result.ok)
            throw new BrowserError(`browser: content evaluation failed: ${result.exception}`, 'BROWSER_CONTENT_FAILED');
        const value = result.value;
        if (!value.ok)
            throw new BrowserError(`browser: content fetch failed: ${value.reason ?? 'unknown'}`, 'BROWSER_CONTENT_FAILED');
        return { content: value.content ?? '', truncated: value.truncated ?? false };
    }
    /**
     * Click at viewport coordinates, or at a located element's center when a
     * `target` (css/text/xpath) is given. CDP mousePressed + mouseReleased.
     */
    async click(session, request, signal) {
        const s = this.session(session);
        // The view the locate runs against. It can stop being the session's active view while
        // the locate waits (see prepareTarget), so every dispatch below re-reads the live one.
        const locateHandle = this.activeTab(s).handle;
        signal?.throwIfAborted();
        let x = 0;
        let y = 0;
        if ('target' in request) {
            // Semantic targeting (②): locate the element in-page, scroll it into
            // view, and click its center — no coordinate guessing needed.
            const locateMs = 10_000;
            const body = `
        el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' })
        const r = el.getBoundingClientRect()
        return { ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      `;
            const script = this.buildTargetScript(request.target, locateMs, body);
            const out = await this.runTargetScript(this.activeTab(s), script, locateMs, signal, 'BROWSER_CLICK_FAILED', 'browser: click');
            x = Number(out.x);
            y = Number(out.y);
        }
        else {
            // A coordinate only exists because somebody read a picture. Under the
            // non-visual strategy the plugin must not accept one: a model that cannot
            // see cannot have produced it, so the coordinates are either copied from an
            // earlier vision pass or invented, and honouring them turns a silent
            // mis-click into a mystery. Refusing here, with a message that says what to
            // do instead, converts that into a usable instruction.
            if (this.settingsSource !== undefined && this.settingsSource().vision.strategy === 'nonVisual') {
                throw new BrowserError('browser: the configured non-visual strategy refuses coordinate clicks — pass a semantic target instead, e.g. target { by: "text", value: "Sign in" }, which locates the element from the DOM and clicks its centre', 'BROWSER_NON_VISUAL_COORDINATES');
            }
            x = request.x;
            y = request.y;
        }
        // Input.* is only delivered to a view with a current display surface; the
        // barrier also re-presents after a navigation replaced the renderer. It returns the
        // handle that may still be receiving input when it settles.
        const handle = await this.present(s, signal);
        // The locate (up to 10s) and the present barrier both ran against the view captured
        // earlier; if the human switched tabs meanwhile, these coordinates belong to one page
        // and the dispatch would go to another — and Chromium answers success either way.
        if ('target' in request)
            this.assertSameView(session, locateHandle, handle);
        const timeoutMs = 30_000;
        const send = (params, label) => withTimeout(handle.sendCommand('Input.dispatchMouseEvent', params), timeoutMs, signal, `browser: click ${label} timed out after ${timeoutMs}ms`);
        // Chromium routes a synthesized `mousePressed` to the widget's *current*
        // hover target rather than hit-testing the coordinates, and a real pointer
        // click is always preceded by movement. A view that has never received a
        // mouse event has no hover target yet, so the press of the FIRST click on a
        // fresh tab went nowhere while CDP still answered success; the second click
        // landed because the first had quietly established the target. Move the
        // pointer first so a click is self-contained.
        try {
            await send({ type: 'mouseMoved', x, y }, 'move');
        }
        catch (error) {
            throw new BrowserError(`browser: click failed: ${String(error)}`, 'BROWSER_CLICK_FAILED', { cause: error });
        }
        // Paint before the press so the ripple is already on screen when the click
        // lands — the cursor exists to show the human WHERE the agent acts.
        // Name the operation in the overlay: the pointer is the "agent is driving this
        // tab" signal, so the bubble is what lets a human follow along without the log.
        this.showCursor(handle, x, y, 'click', 'click', true);
        const release = () => {
            // Back to the handle the PRESS may have landed on, deliberately not to the currently
            // active tab: this only runs after a failed press/release, and re-targeting a
            // compensating half of a click to a view the human just switched to would press a
            // button there. Best-effort either way.
            void handle
                .sendCommand('Input.dispatchMouseEvent', {
                type: 'mouseReleased',
                x,
                y,
                button: 'left',
                clickCount: 1,
            })
                .catch(() => { });
        };
        try {
            await send({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, 'press');
        }
        catch (error) {
            // The press may still land late; release best-effort so the button is
            // never left in a stuck pressed state.
            release();
            throw new BrowserError(`browser: click failed: ${String(error)}`, 'BROWSER_CLICK_FAILED', { cause: error });
        }
        try {
            await send({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, 'release');
        }
        catch (error) {
            // The press already landed; retry the release so the button is not
            // left pressed before surfacing the failure.
            release();
            throw new BrowserError(`browser: click failed: ${String(error)}`, 'BROWSER_CLICK_FAILED', { cause: error });
        }
        this.record(s, 'click', 'target' in request ? { target: request.target } : { x, y }, true);
    }
    /**
     * Type into the focused element, or focus a located element (css/text/xpath)
     * first and then insert the text.
     */
    async type(session, request, signal) {
        const s = this.session(session);
        // The view the locate runs against. It can stop being the session's active view while
        // the locate waits (the human is invited to drive the same window), so the input below
        // goes to the handle `present` reports instead of this one.
        const locateHandle = this.activeTab(s).handle;
        signal?.throwIfAborted();
        const hasTarget = 'target' in request;
        if (hasTarget) {
            const locateMs = 10_000;
            const script = this.buildTargetScript(request.target, locateMs, `
        el.focus()
        return { ok: true }
      `);
            const locateTab = this.activeTab(s);
            const out = await this.runTargetScript(locateTab, script, locateMs, signal, 'BROWSER_TYPE_FAILED', 'browser: type');
            const cursorPoint = scriptPoint(out);
            if (cursorPoint !== undefined)
                this.showCursor(locateTab.handle, cursorPoint.x, cursorPoint.y, 'click', 'type', true);
        }
        const text = 'text' in request ? request.text : '';
        const timeoutMs = 30_000;
        // Input.insertText goes through the Input domain: same display-surface
        // requirement as click/key. It also reports which view is active once the barrier has
        // settled, which is what makes the tab-switch check below meaningful.
        const handle = await this.present(s, signal);
        // Focusing one page and inserting into another is exactly the silent mis-target this
        // refuses: the element was focused in the located view, and the text would have gone to
        // whichever page is now visible — possibly a password field there.
        if (hasTarget)
            this.assertSameView(session, locateHandle, handle);
        try {
            await withTimeout(handle.sendCommand('Input.insertText', { text }), timeoutMs, signal, `browser: type timed out after ${timeoutMs}ms`);
        }
        catch (error) {
            throw new BrowserError(`browser: type failed: ${String(error)}`, 'BROWSER_TYPE_FAILED', { cause: error });
        }
        // Store the full text so replay re-issues the same input; the history
        // tool truncates long values when rendering.
        this.record(s, 'type', { text, ...hasTarget ? { target: request.target } : {} }, true);
    }
    /** Scroll the page: by deltas, to a selector, or to top/bottom. */
    async scroll(session, request, signal) {
        const s = this.session(session);
        const tab = this.activeTab(s);
        signal?.throwIfAborted();
        const selector = request.selector ?? '';
        const script = `(() => {
      const sel = ${JSON.stringify(selector)}
      if (sel !== '') {
        const el = document.querySelector(sel)
        if (!el) return { ok: false, reason: 'selector not found' }
        el.scrollIntoView({ behavior: 'instant', block: 'center' })
        return { ok: true }
      }
      if (${request.toTop === true}) { window.scrollTo(0, 0); return { ok: true } }
      if (${request.toBottom === true}) { window.scrollTo(0, document.body.scrollHeight); return { ok: true } }
      window.scrollBy({ top: ${request.deltaY ?? 0}, left: ${request.deltaX ?? 0} })
      return { ok: true }
    })()`;
        const timeoutMs = 15_000;
        const result = await withTimeout(handleSendEvaluate(tab.handle, script), timeoutMs, signal, `browser: scroll timed out after ${timeoutMs}ms`, () => terminatePage(tab.handle));
        if (!result.ok)
            throw new BrowserError(`browser: scroll failed: ${result.exception}`, 'BROWSER_SCROLL_FAILED');
        const value = result.value;
        if (value.ok !== true)
            throw new BrowserError(`browser: scroll failed: ${value.reason ?? 'unknown'}`, 'BROWSER_SCROLL_FAILED');
        this.record(s, 'scroll', { ...request }, true);
    }
    /** Go back (-1) or forward (+1) in the active tab's navigation history. */
    async historyStep(session, direction, signal) {
        const s = this.session(session);
        const { handle } = this.activeTab(s);
        signal?.throwIfAborted();
        const timeoutMs = 30_000;
        const hist = await withTimeout(handle.sendCommand('Page.getNavigationHistory'), timeoutMs, signal, `browser: history read timed out after ${timeoutMs}ms`);
        const entries = hist.entries ?? [];
        const currentIndex = hist.currentIndex ?? -1;
        const target = currentIndex + direction;
        if (target < 0 || target >= entries.length) {
            // Nothing to step to; treat it as a successful no-op so the agent can
            // proceed without an error dance.
            this.record(s, direction === -1 ? 'back' : 'forward', {}, true);
            return;
        }
        const entry = entries[target];
        if (entry?.id === undefined)
            throw new BrowserError('browser: history entry missing id', 'BROWSER_HISTORY_INVALID');
        // A history step is a navigation too: the classic A→B→A redirect would
        // otherwise read the outgoing document's identity (see settleDocument).
        const before = await this.documentStamp(handle);
        await withTimeout(handle.sendCommand('Page.navigateToHistoryEntry', { entryId: entry.id }), timeoutMs, signal, `browser: history navigation timed out after ${timeoutMs}ms`, () => { void handle.sendCommand('Page.stopLoading').catch(() => { }); });
        this.record(s, direction === -1 ? 'back' : 'forward', {}, true);
        await this.settleDocument(handle, before, signal);
        this.recordVisit(s, handle);
        this.showActive(s);
    }
    /** Go back in the active tab's history. */
    async back(session, signal) {
        return this.historyStep(session, -1, signal);
    }
    /** Go forward in the active tab's history. */
    async forward(session, signal) {
        return this.historyStep(session, 1, signal);
    }
    /** Reload the active tab. */
    async reload(session, signal) {
        const s = this.session(session);
        const { handle } = this.activeTab(s);
        signal?.throwIfAborted();
        const timeoutMs = 30_000;
        // Same-URL reload: only the per-load document identity can tell the new
        // document from the old one, so capture it before reloading.
        const before = await this.documentStamp(handle);
        await withTimeout(handle.sendCommand('Page.reload', { ignoreCache: false }), timeoutMs, signal, `browser: reload timed out after ${timeoutMs}ms`, 
        // Best-effort: cancel the reload if it wedges the debugger queue.
        () => { void handle.sendCommand('Page.stopLoading').catch(() => { }); });
        this.record(s, 'reload', {}, true);
        await this.settleDocument(handle, before, signal);
        this.recordVisit(s, handle);
        this.showActive(s);
    }
    /** Press one named key (Enter/Tab/arrows/…) via CDP key events. */
    async key(session, request, signal) {
        const s = this.session(session);
        signal?.throwIfAborted();
        const spec = KEY_SPECS[request.key];
        if (spec === undefined) {
            throw new BrowserError(`browser: unsupported key "${request.key}" (supported: ${BROWSER_KEY_NAMES.join(', ')})`, 'BROWSER_KEY_UNSUPPORTED');
        }
        const params = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk, ...spec.text !== undefined ? { text: spec.text } : {} };
        const timeoutMs = 15_000;
        // Input.dispatchKeyEvent is subject to the same display-surface rule. The handle comes
        // back from the presentation barrier rather than from a capture taken before it: this
        // session is shared with the human, who may switch tabs while the barrier round-trips,
        // and a key sent to the view they left is silently dropped (or lands on the new page).
        const handle = await this.present(s, signal);
        // Focus the SAME view the key is dispatched to; focusing the pre-switch handle would
        // grant web focus to a page that then receives nothing.
        await this.focusView(handle);
        const release = () => handle.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
        try {
            await withTimeout(handle.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...params }), timeoutMs, signal, `browser: key press timed out after ${timeoutMs}ms`);
        }
        catch (error) {
            // The press may still land late; release best-effort so the key is
            // never left in a stuck pressed state.
            void release().catch(() => { });
            throw new BrowserError(`browser: key "${request.key}" failed: ${String(error)}`, 'BROWSER_KEY_FAILED', { cause: error });
        }
        try {
            await withTimeout(release(), timeoutMs, signal, `browser: key release timed out after ${timeoutMs}ms`);
        }
        catch (error) {
            // The press already landed; retry the release before surfacing.
            void release().catch(() => { });
            throw new BrowserError(`browser: key "${request.key}" failed: ${String(error)}`, 'BROWSER_KEY_FAILED', { cause: error });
        }
        this.record(s, 'key', { key: request.key }, true);
    }
    /**
     * Fill a form's fields in one batch. Runs one page-context script that
     * resolves each field (selector, or name/label/placeholder among visible
     * controls), sets its value with the native prototype setter (React/Vue
     * controlled inputs included) plus input/change events, handles
     * select/checkbox/radio/contenteditable, and optionally submits the form.
     */
    async fillForm(session, request, signal) {
        const s = this.session(session);
        const tab = this.activeTab(s);
        signal?.throwIfAborted();
        const specs = JSON.stringify(request.fields.map(f => ({
            selector: f.selector ?? null,
            name: f.name ?? null,
            label: f.label ?? null,
            placeholder: f.placeholder ?? null,
            // A field with NO kind is a field with no kind FILTER: absent, not 'text'. Defaulting
            // it to 'text' here made `if (spec.kind)` above always true, so every unspecified
            // field was narrowed to an <input> — browser_fill on a <textarea> reported
            // `no "text" control matched`, and a contenteditable could not match any kind at all.
            // The value stays a string or null (never undefined): the in-page check tests truthiness,
            // and JSON drops an undefined member entirely, which is the same thing here.
            kind: f.kind ?? null,
            value: f.value,
        })));
        const submitFlag = request.submit === true;
        const script = `(() => {
      const specs = ${specs}
      const out = []
      const setNative = (el, proto, value) => {
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
        if (setter) setter.call(el, value)
        else el.value = value
      }
      const visible = (el) => {
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        return r.width >= 4 && r.height >= 4 && cs.visibility !== 'hidden' && cs.display !== 'none'
      }
      const describe = (spec) => spec.selector || spec.name || spec.label || spec.placeholder || '(unspecified)'
      const matches = (el, spec) => {
        if (spec.selector) { try { return el.matches(spec.selector) } catch { return false } }
        if (spec.name && el.name === spec.name) return true
        if (spec.placeholder && el.placeholder === spec.placeholder) return true
        if (spec.label) {
          if (el.getAttribute('aria-label') === spec.label) return true
          if (el.id) {
            const lbl = document.querySelector('label[for=' + JSON.stringify(el.id) + ']')
            if (lbl && (lbl.textContent || '').trim() === spec.label) return true
          }
          const wrap = el.closest('label')
          if (wrap && (wrap.textContent || '').trim() === spec.label) return true
        }
        return false
      }
      // Every root this page exposes: the top document plus its shadow trees (recursively)
      // and same-origin iframes. The snapshot and waitFor already walk all of them, so an
      // element inside one is shown to the model and can be waited for — resolving a click or
      // a fill used to look at the top document alone and answer "not found" for something
      // the model had just been handed a reference to. The two must agree about what exists.
      // (Kept in step with the collector in the snapshot script above.)
      const allRoots = () => {
        const roots = []
        const seen = new Set()
        const visit = doc => {
          if (seen.has(doc)) return
          seen.add(doc)
          roots.push(doc)
          for (const el of doc.querySelectorAll('*')) {
            if (el.shadowRoot) visit(el.shadowRoot)
            if (el.tagName === 'IFRAME') {
              try { const d = el.contentDocument; if (d) visit(d) } catch { /* cross-origin */ }
            }
          }
        }
        visit(document)
        return roots
      }
      const roots = allRoots()
      const candidates = (spec) => {
        const all = spec.selector
          ? roots.flatMap(root => [...root.querySelectorAll(spec.selector)])
          : roots.flatMap(root => [...root.querySelectorAll('input, textarea, select, [contenteditable="true"]')]).filter(el => matches(el, spec))
        const vis = all.filter(visible)
        return vis.length > 0 ? vis : all
      }
      for (const spec of specs) {
        let els
        try {
          els = candidates(spec)
        } catch (e) {
          // A malformed selector must not abort the whole batch; report the
          // field as failed and continue with the rest.
          out.push({ ok: false, error: String(e), target: describe(spec) })
          continue
        }
        if (els.length === 0) { out.push({ ok: false, error: 'field not found', target: describe(spec) }); continue }
        let el = els[0]
        // The caller may name a kind. Honor it: the branches below read the element's own
        // tag/type, so without this a selector matching two different controls acted on
        // whichever came first — usually right, which is what hid the mistake. A field that
        // names NO kind gets no filter at all: the element's own tag then decides the
        // branch, which is what "kind defaults to text" was always trying to say.
        if (spec.kind) {
          const matchesKind = (node) => {
            const nodeTag = node.tagName
            const nodeType = (node.type || '').toLowerCase()
            if (spec.kind === 'select') return nodeTag === 'SELECT'
            if (spec.kind === 'textarea') return nodeTag === 'TEXTAREA'
            if (spec.kind === 'checkbox' || spec.kind === 'radio') return nodeType === spec.kind
            // 'text': the plain-value branch covers <input> AND <textarea>, and the batch
            // already collects [contenteditable="true"] as a settable control — so all three
            // must match. Requiring nodeTag === 'INPUT' here reported "no text control
            // matched" for a textarea and left the contenteditable branch below unreachable.
            if (nodeTag === 'TEXTAREA') return true
            if (node.isContentEditable === true) return true
            return nodeTag === 'INPUT' && nodeType !== 'checkbox' && nodeType !== 'radio' && nodeType !== 'file'
          }
          const wanted = els.find(matchesKind)
          if (wanted === undefined) {
            out.push({ ok: false, error: 'no "' + spec.kind + '" control matched', target: describe(spec) })
            continue
          }
          els.length = 0
          els.push(wanted)
          // el was bound before the filter narrowed els, so the branches below would still
          // read the first match — the very silent wrong-element behaviour this filter exists
          // to remove.
          el = els[0]
        }
        const tag = el.tagName
        const type = (el.type || '').toLowerCase()
        try {
          if (tag === 'SELECT') {
            const wanted = String(spec.value)
            if (el.multiple) {
              const wantedList = wanted.split(',').map(x => x.trim())
              let hit = false
              for (const o of [...el.options]) {
                o.selected = wantedList.includes(o.value) || wantedList.includes((o.textContent || '').trim())
                if (o.selected) hit = true
              }
              if (!hit) { out.push({ ok: false, error: 'option not found: ' + wanted, target: describe(spec) }); continue }
            } else {
              let opt = [...el.options].find(o => o.value === wanted)
              if (!opt) opt = [...el.options].find(o => (o.textContent || '').trim() === wanted)
              if (!opt) { out.push({ ok: false, error: 'option not found: ' + wanted, target: describe(spec) }); continue }
              setNative(el, HTMLSelectElement.prototype, opt.value)
            }
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
            out.push({ ok: true, method: 'select', target: describe(spec) })
          } else if (type === 'file') {
            out.push({ ok: false, error: 'file inputs cannot be set from script; use browser_download or ask the human', target: describe(spec) })
          } else if (type === 'checkbox') {
            const want = spec.value === true || spec.value === 'true' || spec.value === 'on'
            if (el.checked !== want) el.click()
            out.push({ ok: true, method: 'checkbox', target: describe(spec) })
          } else if (type === 'radio') {
            const wanted = String(spec.value)
            const radio = [...document.querySelectorAll('input[type="radio"][name=' + JSON.stringify(el.name || '') + ']')]
              .find(r => r.value === wanted || (r === el && (spec.value === true || spec.value === 'true')))
            if (!radio) { out.push({ ok: false, error: 'radio option not found: ' + wanted, target: describe(spec) }); continue }
            if (!radio.checked) radio.click()
            out.push({ ok: true, method: 'radio', target: describe(spec) })
          } else if (el.isContentEditable) {
            el.textContent = String(spec.value)
            el.dispatchEvent(new Event('input', { bubbles: true }))
            out.push({ ok: true, method: 'contenteditable', target: describe(spec) })
          } else if (tag === 'TEXTAREA') {
            setNative(el, HTMLTextAreaElement.prototype, String(spec.value))
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
            out.push({ ok: true, method: 'textarea', target: describe(spec) })
          } else {
            setNative(el, HTMLInputElement.prototype, String(spec.value))
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
            out.push({ ok: true, method: 'input', target: describe(spec) })
          }
        } catch (e) {
          out.push({ ok: false, error: String(e), target: describe(spec) })
        }
      }
      let submitted = false
      if (${submitFlag}) {
        let last = null
        for (const spec of specs) {
          try { const els = candidates(spec); if (els.length > 0) { last = els[0]; break } } catch { /* skip */ }
        }
        const form = last && (last.form || last.closest('form'))
        if (form) { form.requestSubmit(); submitted = true }
      }
      return { fields: out, submitted }
    })()`;
        const timeoutMs = request.timeoutMs ?? 30_000;
        const result = await withTimeout(handleSendEvaluate(tab.handle, script), timeoutMs, signal, `browser: fillForm timed out after ${timeoutMs}ms`, () => terminatePage(tab.handle));
        if (!result.ok) {
            throw new BrowserError(`browser: fillForm evaluation failed: ${result.exception}`, 'BROWSER_FILL_FAILED');
        }
        const value = result.value;
        const okCount = value.fields.filter(f => f.ok).length;
        this.record(s, 'fill', { fields: request.fields.length, submit: submitFlag }, okCount === value.fields.length, {
            result: `${okCount}/${value.fields.length} fields filled${value.submitted ? ', form submitted' : ''}`,
        });
        return { fields: value.fields, submitted: value.submitted === true };
    }
    /**
     * Build an in-page async IIFE that locates ONE element by css/text/xpath
     * (polling until it appears or the budget runs out) and then runs `body`
     * with `el` in scope. Shared by the target-based tools: click/type (②),
     * setValue/check/select/clear/getValue (③), and the scrape item wait.
     * A selector that fails to PARSE is reported immediately instead of being
     * polled until the budget expires — see the comment in `match`.
     */
    buildTargetScript(spec, timeoutMs, body) {
        // `by` defaults to css in-page; report the strategy that WAS used, or a
        // miss says only `{"value":"Learn more"}` and the caller cannot tell that a
        // plain label was queried as a CSS selector.
        const resolvedSpec = { ...spec, by: spec.by ?? 'css' };
        return `(async () => {
      const spec = ${JSON.stringify(resolvedSpec)}
      const timeoutMs = ${String(timeoutMs)}
      const sleep = ms => new Promise(r => setTimeout(r, ms))
      const isVisible = el => el instanceof HTMLElement && (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0)
      const ownText = el => Array.from(el.childNodes).filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent || '').join('').trim()
      const depth = el => { let d = 0; let p = el.parentElement; while (p) { d++; p = p.parentElement } return d }
      const match = () => {
        const by = typeof spec.by === 'string' ? spec.by : 'css'
        const value = String(spec.value ?? '')
        // Named matchIndex rather than index: this whole function is one host-side template
        // literal, so a bare name declared here can silently shadow a host binding of the
        // same name and turn an inner reference into a type error.
        const matchIndex = typeof spec.index === 'number' ? spec.index : 0
        // An index that cannot address an element can never match on a later poll, exactly
        // like a selector that fails to parse — so it must not look like a miss either. A
        // negative index, the common "last one" shorthand, otherwise burned the caller's
        // whole locate budget (10s) and then reported "element not found", which reads like a
        // slow page rather than a bad argument.
        // (No backticks in this comment: it lives inside a template literal.)
        if (!Number.isInteger(matchIndex) || matchIndex < 0) {
          throw new Error('target.index must be a non-negative integer, got ' + JSON.stringify(spec.index))
        }
        let els = []
        // Every root this page exposes: the top document plus its shadow trees (recursively)
        // and same-origin iframes. The snapshot and waitFor already walk all of them, so an
        // element inside one is shown to the model and can be waited for — resolving a click or
        // a fill used to look at the top document alone and answer "not found" for something
        // the model had just been handed a reference to. The two must agree about what exists.
        // (Kept in step with the collector in the snapshot script above.)
        const allRoots = () => {
          const roots = []
          const seen = new Set()
          const visit = doc => {
            if (seen.has(doc)) return
            seen.add(doc)
            roots.push(doc)
            for (const el of doc.querySelectorAll('*')) {
              if (el.shadowRoot) visit(el.shadowRoot)
              if (el.tagName === 'IFRAME') {
                try { const d = el.contentDocument; if (d) visit(d) } catch { /* cross-origin */ }
              }
            }
          }
          visit(document)
          return roots
        }
        const roots = allRoots()
        if (by === 'css') {
          // A selector that does not PARSE can never match on a later poll, so
          // it must not look like a miss: the old "return null" kept the caller
          // polling until the whole budget was gone, and "element not found
          // after 10s" reads like a slow page while the real cause is a
          // malformed selector (a label or plain text passed where one belongs).
          // Parse on the top document first: a selector that does not PARSE must still be
          // reported as a bad argument rather than as a miss, and that check is about syntax,
          // not about which root holds the element.
          try { document.querySelectorAll(value) }
          catch (error) { throw new Error('invalid CSS selector ' + JSON.stringify(value) + ' (' + String((error && error.message) || error) + ')') }
          for (const root of roots) els.push(...root.querySelectorAll(value))
        } else if (by === 'xpath') {
          try {
            for (const root of roots) {
              const snap = document.evaluate(value, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null)
              for (let i = 0; i < snap.snapshotLength; i++) {
                const n = snap.snapshotItem(i)
                if (n instanceof Element) els.push(n)
              }
            }
          } catch (error) { throw new Error('invalid XPath ' + JSON.stringify(value) + ' (' + String((error && error.message) || error) + ')') }
        } else {
          // '*' rather than 'body *': a shadow root and an iframe document have no body of
          // their own to anchor to, and the visibility and own-text predicates below are what
          // actually decide whether an element counts.
          const all = roots.flatMap(root => [...root.querySelectorAll('*')])
          const exact = all.filter(el => isVisible(el) && ownText(el) === value)
          // Exact first, then contains; deepest element preferred (so a
          // button inside a card wins over the card itself).
          const pool = exact.length > 0 ? exact : all.filter(el => isVisible(el) && ownText(el).includes(value))
          els = pool.sort((a, b) => depth(b) - depth(a))
        }
        return els[matchIndex] ?? null
      }
      const deadline = Date.now() + timeoutMs
      let el = null
      for (;;) {
        // Only a parse error escapes the poll: see the comment in match() above.
        try { el = match() } catch (error) { return { ok: false, error: String((error && error.message) || error) } }
        if (el !== null) break
        if (Date.now() >= deadline) return { ok: false, error: 'element not found: ' + JSON.stringify(spec) + ' (looked for ' + timeoutMs + 'ms)' }
        await sleep(100)
      }
      const __result = await (async () => {
      ${body}
      })()
      // Report the operated element's viewport center next to the script's own
      // verdict: the synthetic cursor (and any future feedback) needs the point,
      // and no individual body should have to compute it a second time. Kept
      // under a distinct key so a body that already returns x/y keeps them.
      const __rect = el.getBoundingClientRect()
      return {
        ...(typeof __result === 'object' && __result !== null ? __result : { ok: true }),
        __point: { x: Math.round(__rect.x + __rect.width / 2), y: Math.round(__rect.y + __rect.height / 2) },
      }
    })()`;
    }
    /**
     * Shared evaluate wrapper for the target-based tools. Runs the in-page
     * script and returns its result object; throws a typed BrowserError on
     * evaluation failure or an in-page `{ ok: false, error }` verdict.
     */
    async runTargetScript(tab, script, timeoutMs, signal, errorCode, errorLabel) {
        // The script polls for its whole `timeoutMs` and only then answers, so an
        // outer budget of the same size fires at the same instant and wins: the
        // caller saw `click timed out after 10000ms` while the page had already
        // decided WHY (selector not found / malformed). Give the answer a chance to
        // get back before the generic timeout replaces it.
        const result = await withTimeout(handleSendEvaluate(tab.handle, script), timeoutMs + TARGET_SCRIPT_GRACE_MS, signal, `${errorLabel} timed out after ${timeoutMs}ms`, () => terminatePage(tab.handle));
        if (!result.ok)
            throw new BrowserError(`${errorLabel} failed: ${result.exception}`, errorCode);
        const value = result.value;
        if (value?.ok !== true)
            throw new BrowserError(`${errorLabel} failed: ${value?.error ?? 'unknown'}`, errorCode);
        return value;
    }
    /** Set one element's value (native setter + input/change, React-friendly). */
    async setValue(session, request, signal) {
        const s = this.session(session);
        const tab = this.activeTab(s);
        signal?.throwIfAborted();
        const timeoutMs = request.timeoutMs ?? 5_000;
        const body = `
      const value = ${JSON.stringify(String(request.value))}
      const setNative = (el, proto, v) => {
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
        if (setter) setter.call(el, v)
        else el.value = v
      }
      const tag = el.tagName
      const type = (el.type || '').toLowerCase()
      if (tag === 'SELECT') {
        const wanted = value
        let opt = [...el.options].find(o => o.value === wanted)
        if (!opt) opt = [...el.options].find(o => (o.textContent || '').trim() === wanted)
        if (!opt) return { ok: false, error: 'option not found: ' + wanted }
        setNative(el, HTMLSelectElement.prototype, opt.value)
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return { ok: true, method: 'select', value: opt.value }
      }
      if (el.isContentEditable) {
        el.textContent = value
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return { ok: true, method: 'contenteditable', value }
      }
      if (tag === 'TEXTAREA') {
        setNative(el, HTMLTextAreaElement.prototype, value)
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return { ok: true, method: 'textarea', value }
      }
      setNative(el, HTMLInputElement.prototype, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return { ok: true, method: 'input', value }
    `;
        const script = this.buildTargetScript(request.target, timeoutMs, body);
        const out = await this.runTargetScript(tab, script, timeoutMs, signal, 'BROWSER_SET_VALUE_FAILED', 'browser: setValue');
        const cursorPoint = scriptPoint(out);
        if (cursorPoint !== undefined)
            this.showCursor(tab.handle, cursorPoint.x, cursorPoint.y, 'click');
        this.record(s, 'setValue', { target: request.target, value: String(request.value) }, true, { result: out.method });
        return { method: out.method, value: out.value };
    }
    /** Check or uncheck one checkbox/radio. */
    async check(session, request, signal) {
        const s = this.session(session);
        const tab = this.activeTab(s);
        signal?.throwIfAborted();
        const timeoutMs = request.timeoutMs ?? 5_000;
        const want = request.checked ?? true;
        const body = `
      const want = ${String(want)}
      const type = (el.type || '').toLowerCase()
      if (type === 'checkbox') {
        if (el.checked !== want) el.click()
        return { ok: true, checked: el.checked }
      }
      if (type === 'radio') {
        if (want && !el.checked) el.click()
        return { ok: true, checked: el.checked }
      }
      return { ok: false, error: 'element is not a checkbox or radio (' + el.tagName + ')' }
    `;
        const script = this.buildTargetScript(request.target, timeoutMs, body);
        const out = await this.runTargetScript(tab, script, timeoutMs, signal, 'BROWSER_CHECK_FAILED', 'browser: check');
        const cursorPoint = scriptPoint(out);
        if (cursorPoint !== undefined)
            this.showCursor(tab.handle, cursorPoint.x, cursorPoint.y, 'click');
        this.record(s, 'check', { target: request.target, checked: want }, true);
        return { checked: out.checked === true };
    }
    /** Select one option of a <select>, by value, visible text, or index. */
    async selectOption(session, request, signal) {
        const s = this.session(session);
        const tab = this.activeTab(s);
        signal?.throwIfAborted();
        const timeoutMs = request.timeoutMs ?? 5_000;
        const body = `
      if (el.tagName !== 'SELECT') return { ok: false, error: 'element is not a <select> (' + el.tagName + ')' }
      const optionValue = ${JSON.stringify(request.optionValue ?? null)}
      const optionText = ${JSON.stringify(request.optionText ?? null)}
      const optionIndex = ${String(request.optionIndex ?? -1)}
      let opt = null
      if (optionValue !== null) opt = [...el.options].find(o => o.value === optionValue)
      if (!opt && optionText !== null) opt = [...el.options].find(o => (o.textContent || '').trim() === optionText)
      if (!opt && optionIndex >= 0) opt = el.options[optionIndex] ?? null
      if (!opt) return { ok: false, error: 'option not found' }
      const setNative = (el, proto, v) => {
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
        if (setter) setter.call(el, v)
        else el.value = v
      }
      setNative(el, HTMLSelectElement.prototype, opt.value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return { ok: true, value: opt.value, text: (opt.textContent || '').trim() }
    `;
        const script = this.buildTargetScript(request.target, timeoutMs, body);
        const out = await this.runTargetScript(tab, script, timeoutMs, signal, 'BROWSER_SELECT_FAILED', 'browser: select');
        const cursorPoint = scriptPoint(out);
        if (cursorPoint !== undefined)
            this.showCursor(tab.handle, cursorPoint.x, cursorPoint.y, 'click');
        this.record(s, 'select', { target: request.target, optionValue: request.optionValue ?? null, optionText: request.optionText ?? null, optionIndex: request.optionIndex ?? null }, true);
        return { value: out.value, text: out.text };
    }
    /** Clear one input/textarea/contenteditable (or uncheck a checkbox/radio). */
    async clearField(session, request, signal) {
        const s = this.session(session);
        const tab = this.activeTab(s);
        signal?.throwIfAborted();
        const timeoutMs = request.timeoutMs ?? 5_000;
        const body = `
      const setNative = (el, proto) => {
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
        if (setter) setter.call(el, '')
        else el.value = ''
      }
      if (el.isContentEditable) {
        el.textContent = ''
        el.dispatchEvent(new Event('input', { bubbles: true }))
      } else if (el.tagName === 'TEXTAREA') {
        setNative(el, HTMLTextAreaElement.prototype)
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
      } else if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
        if (el.checked) el.click()
      } else {
        setNative(el, HTMLInputElement.prototype)
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
      }
      return { ok: true }
    `;
        const script = this.buildTargetScript(request.target, timeoutMs, body);
        const out = await this.runTargetScript(tab, script, timeoutMs, signal, 'BROWSER_CLEAR_FAILED', 'browser: clear');
        const cursorPoint = scriptPoint(out);
        if (cursorPoint !== undefined)
            this.showCursor(tab.handle, cursorPoint.x, cursorPoint.y, 'click');
        this.record(s, 'clear', { target: request.target }, true);
        return { cleared: true };
    }
    /** Read one element's current value (for verification). */
    async getValue(session, request, signal) {
        const s = this.session(session);
        const tab = this.activeTab(s);
        signal?.throwIfAborted();
        const timeoutMs = request.timeoutMs ?? 5_000;
        const body = `
      const type = (el.type || '').toLowerCase()
      if (type === 'checkbox' || type === 'radio') return { ok: true, value: null, checked: el.checked }
      if (el.tagName === 'SELECT') {
        const o = el.options[el.selectedIndex]
        return { ok: true, value: el.value, selectedText: o ? (o.textContent || '').trim() : null }
      }
      const v = el.value !== undefined ? el.value : el.textContent
      return { ok: true, value: v === undefined || v === null ? null : String(v) }
    `;
        const script = this.buildTargetScript(request.target, timeoutMs, body);
        const out = await this.runTargetScript(tab, script, timeoutMs, signal, 'BROWSER_GET_VALUE_FAILED', 'browser: getValue');
        this.record(s, 'getValue', { target: request.target }, true);
        return {
            value: out.value === null || out.value === undefined ? null : String(out.value),
            ...out.checked !== undefined ? { checked: out.checked === true } : {},
            ...out.selectedText !== undefined && out.selectedText !== null ? { selectedText: String(out.selectedText) } : {},
        };
    }
    /**
     * Extract structured data from repeated DOM items (static CSS, CSP-safe —
     * no arbitrary code runs). Waits for the item selector, then maps each item
     * through the field selectors; `selector@attr` reads an attribute instead
     * of text (`a@href` yields an absolute URL).
     */
    async scrape(session, request, signal) {
        const s = this.session(session);
        const tab = this.activeTab(s);
        signal?.throwIfAborted();
        const timeoutMs = request.timeoutMs ?? 5_000;
        const script = `(async () => {
      const itemSel = ${JSON.stringify(request.item)}
      const fields = ${JSON.stringify(request.fields)}
      const timeoutMs = ${String(timeoutMs)}
      const sleep = ms => new Promise(r => setTimeout(r, ms))
      const parseField = f => {
        const m = /^(.*)@([A-Za-z][A-Za-z0-9_-]*)$/.exec(f.selector.trim())
        if (m) return { base: m[1].trim(), attr: m[2] }
        return { base: f.selector, attr: null }
      }
      const deadline = Date.now() + timeoutMs
      let items = []
      for (;;) {
        // Immediate, like match() above: an unparseable selector can never match.
        try { items = Array.from(document.querySelectorAll(itemSel)) }
        catch (error) { return { ok: false, error: 'invalid CSS selector ' + JSON.stringify(itemSel) + ' (' + String((error && error.message) || error) + ')' } }
        if (items.length > 0) break
        if (Date.now() >= deadline) return { ok: false, error: 'no elements matched: ' + itemSel }
        await sleep(100)
      }
      const out = []
      for (const it of items) {
        const row = {}
        for (const f of fields) {
          const { base, attr } = parseField(f)
          let el = null
          try { el = base === '' ? it : it.querySelector(base) } catch { el = null }
          if (!el) { row[f.name] = null; continue }
          if (attr !== null) {
            const v = el.getAttribute(attr)
            row[f.name] = attr === 'href' && el.tagName === 'A' && v ? new URL(v, location.href).href : v
            continue
          }
          row[f.name] = (el.textContent || '').trim()
        }
        out.push(row)
      }
      return { ok: true, count: out.length, items: out }
    })()`;
        const result = await withTimeout(handleSendEvaluate(tab.handle, script), timeoutMs + TARGET_SCRIPT_GRACE_MS, signal, `browser: scrape timed out after ${timeoutMs}ms`, () => terminatePage(tab.handle));
        if (!result.ok)
            throw new BrowserError(`browser: scrape evaluation failed: ${result.exception}`, 'BROWSER_SCRAPE_FAILED');
        const value = result.value;
        if (value.ok !== true)
            throw new BrowserError(`browser: scrape failed: ${value.error ?? 'unknown'}`, 'BROWSER_SCRAPE_FAILED');
        const items = value.items ?? [];
        this.record(s, 'scrape', { item: request.item, fields: request.fields.map(f => f.name) }, true, { result: `${items.length} items` });
        return { count: items.length, items };
    }
    /**
     * Refuse an action the settings have switched off.
     *
     * These switches belong to the OPERATOR. The settings document is written through the
     * plugin's own panel and no tool can reach it, so — unlike `browser_restrict`, which the
     * model owns and can lift at will — a refusal here stands for as long as the setting does.
     * That is the point of them: a deployment can take page-script execution, downloads, or
     * login-state writes off the table without relying on the model's cooperation.
     *
     * Read through `settingsSource` on every call rather than captured at construction, so
     * flipping a switch applies to the next command instead of the next restart — the same
     * rule the credentials gate follows.
     * @param action - which switch to consult.
     * @throws BrowserError when that switch is off.
     */
    assertActionAllowed(action) {
        const settings = this.settingsSource?.();
        if (settings === undefined)
            return;
        if (action === 'execute' && !settings.actions.allowExecute) {
            throw new BrowserError('browser: running page scripts is switched off in settings (Browser → actions)', 'BROWSER_EXECUTE_DISABLED');
        }
        if (action === 'download' && !settings.actions.allowDownload) {
            throw new BrowserError('browser: downloads are switched off in settings (Browser → actions)', 'BROWSER_DOWNLOAD_DISABLED');
        }
        if (action === 'credentialWrite' && !settings.actions.allowCredentialWrite) {
            throw new BrowserError('browser: writing cookies is switched off in settings (Browser → actions)', 'BROWSER_AUTH_WRITE_DISABLED');
        }
    }
    /**
     * Admit a caller-supplied save path for a file the browser writes to disk.
     * ONE gate for both `browser_download` and `browser_screenshot`: the path
     * must be absolute, must resolve inside `downloadDir`, and must not already
     * exist. Without it a prompt-injected agent could write — or silently
     * replace — any file the DSH process can reach, which also escapes the file
     * sandbox every other tool in the set runs under.
     * @param savePath - the caller's target path.
     * @param kind - the operation, used in the error code and message.
     * @returns the resolved absolute target path.
     * @throws BrowserError when the path is relative, outside the directory, or occupied.
     */
    admitSavePath(savePath, kind) {
        const code = kind === 'download' ? 'BROWSER_DOWNLOAD_BLOCKED' : 'BROWSER_SCREENSHOT_BLOCKED';
        if (!isAbsolute(savePath)) {
            throw new BrowserError(`browser: ${kind} savePath must be an absolute path`, code);
        }
        const file = resolve(savePath);
        if (this.downloadDir !== undefined) {
            const dir = resolve(this.downloadDir);
            // Windows paths are case-insensitive and resolve() does not normalize case, so there
            // the containment check folds case — otherwise C:\Users\X\Downloads and
            // c:\users\x\downloads would read as different roots. Everywhere else the fold is
            // REMOVED: a case-sensitive filesystem (Linux) treats /home/u/DOWNLOADS and
            // /home/u/Downloads as different directories, so folding case there let a savePath
            // that merely differed in case pass admission — a directory-confinement escape, and
            // one that mkdirSync below would then happily create.
            const fold = process.platform === 'win32' ? (value) => value.toLowerCase() : (value) => value;
            const dirKey = fold(dir);
            const fileKey = fold(file);
            // The directory ITSELF is refused, not accepted: a save path that IS downloadDir names
            // a directory, so there is no file to write — and mkdirSync would have created the
            // directory when it did not exist. Two paths are "inside" only when the file path is
            // strictly below the directory, which the separator check below already expresses.
            if (!fileKey.startsWith(dirKey + fold(sep))) {
                throw new BrowserError(`browser: ${kind} savePath must be inside downloadDir "${dir}"`, code);
            }
            // The check above is textual, and a symlink defeats it: resolve() normalizes `..`
            // but never follows a link, so `<downloadDir>/out/x.png` passed every test above
            // while `out` pointed at a directory outside the gate — and the write then landed
            // there. Resolve the REAL location of the deepest existing ancestor (which is what
            // decides where the bytes go) and require it to be inside the real directory too.
            // A legitimate path is unaffected: its ancestor resolves to the directory itself.
            //
            // The directory is created first so that it can be resolved at all — mkdirSync is a
            // no-op for one that already exists — and a directory that cannot be created or
            // resolved falls back to its textual form, leaving the real filesystem error to the
            // write instead of inventing one here.
            let realDir;
            try {
                mkdirSync(dir, { recursive: true });
                realDir = fold(realpathSync(dir));
            }
            catch {
                realDir = fold(dir);
            }
            const realAncestor = fold(realAncestorOf(file));
            if (realAncestor !== realDir && !realAncestor.startsWith(realDir + fold(sep))) {
                throw new BrowserError(`browser: ${kind} savePath resolves outside downloadDir "${dir}" (a symlink leaves it)`, code);
            }
        }
        // Never replace an existing file: its previous content is unrecoverable,
        // and the admitted directory may hold files the human put there. A new
        // name is one tool call away.
        //
        // Judged with lstat (see {@link entryExists}), not existsSync: existsSync FOLLOWS
        // links, so a DANGLING symlink read as "nothing here" and the write below created
        // its target — outside the directory whenever the link pointed out of it. It is the
        // directory entry that has to be free, whatever that entry points at.
        if (entryExists(file)) {
            throw new BrowserError(`browser: refusing to overwrite existing file "${file}" — use another name`, code);
        }
        return file;
    }
    /**
     * Download an HTTP(S) URL with the session's cookies to a local file.
     * Admission is the shared {@link admitSavePath} gate; only the self-hosted
     * host implements it (the desktop shell's embedded views delegate downloads
     * to the real browser UI). Both admitted paths and screenshots are confined
     * to `downloadDir`, so a prompt-injected agent cannot write arbitrary
     * machine paths.
     * @param session - the session whose cookies are used.
     * @param request - the URL plus the absolute target path.
     * @param signal - optional cancellation.
     * @returns the path the file was written to.
     */
    async download(session, request, signal) {
        // Before admission, and before the session is even resolved: a switched-off action is
        // not a path problem, and the caller should hear the real reason.
        this.assertActionAllowed('download');
        const s = this.session(session);
        const { handle } = this.activeTab(s);
        signal?.throwIfAborted();
        // URL admission: HTTP(S) only (mirrors the navigation guard). The seam
        // intentionally does not block private/localhost targets — a shared real
        // browser legitimately reaches local dev servers.
        let parsed;
        try {
            parsed = new URL(request.url);
        }
        catch {
            throw new BrowserError(`browser: refusing download of unparseable URL "${request.url}"`, 'BROWSER_DOWNLOAD_BLOCKED');
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new BrowserError(`browser: refusing download of non-HTTP(S) URL "${request.url}"`, 'BROWSER_DOWNLOAD_BLOCKED');
        }
        // savePath admission: the shared gate — absolute, inside `downloadDir`,
        // and never an existing file. Screenshots use the very same one.
        const savePath = this.admitSavePath(request.savePath, 'download');
        const downloadable = handle;
        if (typeof downloadable.download !== 'function') {
            throw new BrowserError('browser: download is only available on the self-hosted browser', 'BROWSER_DOWNLOAD_UNSUPPORTED');
        }
        // The child fetches and writes the file; a slow/hung network can block
        // it well past the tool budget, so bound it. NOTE: unlike CDP calls,
        // there is no child-side abort mechanism for the RPC download — when the
        // parent's timeout fires the child continues writing. The parent's pending
        // entry is cleaned up (the promise settles) and the child's eventual
        // reply is harmlessly consumed by the RPC layer.
        const timeoutMs = 60_000;
        await withTimeout(downloadable.download(request.url, savePath), timeoutMs, signal, `browser: download timed out after ${timeoutMs}ms`);
        this.record(s, 'download', { url: request.url, savePath }, true, { result: savePath });
        return { path: savePath };
    }
    /**
     * Export the session's cookies (login state) as serializable objects.
     * Self-hosted only; the desktop shell's embedded views use the real profile.
     */
    async flushAuth(session) {
        // The settings panel offers "allow the agent to read cookies / export login state".
        // Until now nothing read that switch, so turning it off changed nothing at all —
        // the tool exported every cookie regardless.
        if (this.settingsSource?.().credentials.allowRead === false) {
            throw new BrowserError('browser: reading cookies is switched off in settings (Browser → credentials)', 'BROWSER_AUTH_DISABLED');
        }
        const s = this.session(session);
        const { handle } = this.activeTab(s);
        const timeoutMs = 30_000;
        // The self-hosted carrier has a native path (the child reads its own session), which
        // is worth preferring: it reports exactly what the browser persisted.
        const native = handle;
        if (typeof native.flushAuth === 'function') {
            const cookies = await withTimeout(native.flushAuth(), timeoutMs, undefined, `browser: auth export timed out after ${timeoutMs}ms`);
            this.record(s, 'flushAuth', {}, true, { result: `${cookies.length} cookies` });
            return cookies;
        }
        // Every other carrier drives a real browser over CDP, and cookies are part of CDP —
        // the sidebar goes through the shell's webContents.debugger, an installed Chrome or
        // Edge is the browser itself. So this works everywhere rather than only self-hosted.
        // Scoped to the page this session is on. The jar itself is SHARED on purpose — every
        // window and every task drives the same browser, so signing in once works everywhere,
        // which is the whole point of "use your own browser". What must not be shared is the
        // HANDING OVER: an unfiltered read puts every domain every task has visited, plus
        // whatever the human is signed into, in front of one task's caller. Least exposure,
        // not isolation.
        //
        // Two corrections to the previous attempt. It called Storage.getCookies with a `urls`
        // parameter, but that method takes only browserContextId and ignores everything else, so
        // the filter did nothing and the whole jar was still exported; `urls` belongs to
        // Network.getCookies. And it silently fell back to an unfiltered read when the page URL
        // was unavailable — an error path that asked for MORE than the normal one. Both are
        // fixed: the method that honours the filter, and a failure that refuses instead of
        // widening.
        const cookiesUrl = await this.currentUrl(handle).catch(() => '');
        if (cookiesUrl === '') {
            throw new BrowserError('browser: cannot export cookies without knowing which page this session is on — the URL was unavailable, and reading the whole cookie jar would expose every other session\'s logins', 'BROWSER_AUTH_SCOPE_UNKNOWN');
        }
        const result = await withTimeout(handle.sendCommand('Network.getCookies', { urls: [cookiesUrl] }), timeoutMs, undefined, `browser: auth export timed out after ${timeoutMs}ms`);
        const cookies = toExportedCookies(result.cookies);
        this.record(s, 'flushAuth', {}, true, { result: `${cookies.length} cookies (CDP)` });
        return cookies;
    }
    /** Import cookies into the session (restore login state). Self-hosted only. */
    async restoreAuth(session, cookies) {
        // Restore WRITES cookies, so it answers to the write switch — not to
        // `credentials.allowRead`. It used to consult the read switch and report "reading
        // cookies is switched off", which is both the wrong gate and the wrong sentence: an
        // operator who allowed reading but wanted logins left alone had no switch at all,
        // and one who turned reading off lost the restore path for the wrong reason.
        this.assertActionAllowed('credentialWrite');
        const s = this.session(session);
        const { handle } = this.activeTab(s);
        const timeoutMs = 30_000;
        const native = handle;
        if (typeof native.restoreAuth === 'function') {
            const restored = await withTimeout(native.restoreAuth(cookies), timeoutMs, undefined, `browser: auth restore timed out after ${timeoutMs}ms`);
            this.record(s, 'restoreAuth', { count: cookies.length }, true, { result: `${restored} cookies` });
            return restored;
        }
        // CDP again, for the same reason as the export: any carrier that drives a real
        // browser can set cookies on it. Storage.setCookies needs the cookie fields spelled
        // the CDP way, including the sameSite spelling and seconds rather than milliseconds.
        //
        // toCdpCookie returns undefined for a cookie it cannot place (no usable domain), and
        // `cookies.map(...)` passed that undefined straight through: the array then held a
        // JSON `null`, CDP rejected the WHOLE call, and every valid cookie failed with an error
        // naming none of them. Filter the unusable ones out and say how many went.
        const mapped = cookies.map(toCdpCookie);
        const convertible = mapped.filter((cookie) => cookie !== undefined);
        const dropped = mapped.length - convertible.length;
        if (dropped > 0) {
            process.stderr.write(`[dsh-browser] restoreAuth: dropped ${dropped} of ${mapped.length} cookie(s) with no usable domain; the rest were still restored\n`);
        }
        const result = await withTimeout(handle.sendCommand('Storage.setCookies', { cookies: convertible }), timeoutMs, undefined, `browser: auth restore timed out after ${timeoutMs}ms`);
        // Storage.setCookies returns nothing, so the count comes from what was actually
        // sent. Reading result.cookies here was always undefined, which rendered as
        // "Restored 0 cookies." while the write had succeeded.
        const restored = convertible.length;
        this.record(s, 'restoreAuth', { count: cookies.length, dropped }, true, { result: `${restored} cookies (CDP)${dropped > 0 ? `; ${dropped} dropped` : ''}` });
        return restored;
    }
    /** Capture the current page, optionally full-page, PNG or JPEG, scalable. */
    async screenshot(session, request, signal) {
        const s = this.session(session);
        const { handle } = this.activeTab(s);
        signal?.throwIfAborted();
        const format = request?.format ?? 'png';
        // Native capturePage path (self-hosted): CDP Page.captureScreenshot can
        // hang indefinitely on a view once another (hidden) WebContentsView exists
        // in the window; capturePage is fast for visible views and resolves
        // immediately (empty) for hidden ones. JPEG and downscaling are encoded
        // in the child from the NativeImage, so this path is the only one that
        // can produce JPEG (CDP JPEG hangs on Electron 43).
        const capturable = handle;
        if (request?.fullPage !== true && typeof capturable.capture === 'function') {
            // Ensure the target view is the visible one before capturing.
            this.showActive(s);
            const timeoutMs = 30_000;
            const shot = await withTimeout(capturable.capture({
                ...format === 'jpeg' ? { format, quality: request?.quality } : {},
                ...request?.maxWidth !== undefined ? { maxWidth: request.maxWidth } : {},
                ...request?.maxHeight !== undefined ? { maxHeight: request.maxHeight } : {},
            }), timeoutMs, signal, `browser: screenshot timed out after ${timeoutMs}ms`);
            if (shot.base64 === '') {
                throw new BrowserError('browser: capture returned an empty image (view not painted); retry shortly', 'BROWSER_SCREENSHOT_FAILED');
            }
            return this.saveScreenshot(shot.base64, request?.savePath, shot.mime ?? 'image/png');
        }
        // Fallback: a handle without a native capture() (the sidebar, or an installed Chrome
        // or Edge) uses CDP; full-page needs `captureBeyondViewport`, which capturePage lacks.
        //
        // JPEG: Electron 43's CDP hangs on it, which is why the sidebar stays PNG. An
        // installed Chrome or Edge is the real browser and has no such defect, so it says so
        // through `supportsCdpJpeg` and gets the format it asked for, and the same for
        // downscaling, which CDP performs through a full-document clip.
        const timeoutMs = 30_000;
        const params = {};
        if (request?.fullPage === true) {
            // `captureBeyondViewport` captures the full scrollable content; without
            // a clip this yields the full-page image (CDP default is the viewport).
            params.captureBeyondViewport = true;
        }
        const supportsJpeg = handle.supportsCdpJpeg === true;
        if (format === 'jpeg' && supportsJpeg) {
            params.format = 'jpeg';
            // CDP range is 0-100 and defaults to 80 when omitted.
            if (request?.quality !== undefined)
                params.quality = request.quality;
        }
        // Downscaling on this path: CDP scales through `clip.scale`, and a clip only applies
        // to the region it names, so it has to cover the whole document. The page's own size
        // is read first; when that is unavailable the capture proceeds unscaled rather than
        // failing — an image the caller can shrink itself beats no image at all.
        if (request?.maxWidth !== undefined || request?.maxHeight !== undefined) {
            const metrics = await withTimeout(handle.sendCommand('Page.getLayoutMetrics', {}), timeoutMs, signal, `browser: screenshot timed out after ${timeoutMs}ms`);
            const size = layoutSize(metrics);
            if (size !== undefined) {
                const height = request.fullPage === true ? size.height : size.viewportHeight;
                const byWidth = request.maxWidth !== undefined && size.width > 0 ? request.maxWidth / size.width : 1;
                const byHeight = request.maxHeight !== undefined && height > 0 ? request.maxHeight / height : 1;
                const scale = Math.min(1, byWidth, byHeight);
                if (scale < 1) {
                    params.clip = { x: 0, y: 0, width: size.width, height, scale };
                    // The clip defines the captured area; captureBeyondViewport must not also apply.
                    delete params.captureBeyondViewport;
                }
            }
        }
        const result = await withTimeout(handle.sendCommand(CDP_PAGE_CAPTURE_SCREENSHOT, params), timeoutMs, signal, `browser: screenshot timed out after ${timeoutMs}ms`);
        const data = result.data;
        if (typeof data !== 'string') {
            throw new BrowserError('browser: screenshot returned no image data', 'BROWSER_SCREENSHOT_FAILED');
        }
        // The mime must name the format that was ACTUALLY requested (params.format), not PNG
        // unconditionally: a carrier that sets supportsCdpJpeg asks for `format: 'jpeg'`, so
        // hardcoding the PNG mime announced a JPEG body as a PNG — the data URL then carried a
        // mislabelled image, and a caller that decodes by mime wrote the wrong file.
        const mime = params.format === 'jpeg' ? 'image/jpeg' : 'image/png';
        return this.saveScreenshot(data, request?.savePath, mime);
    }
    /**
     * Build the data URL and optionally write the image to disk. The caller's
     * path goes through the SAME {@link admitSavePath} gate as a download — it
     * must be absolute, resolve inside `downloadDir`, and not be an existing
     * file — so a screenshot cannot be used to write to, or silently replace,
     * files anywhere the DSH process happens to have permission (issue #13).
     */
    saveScreenshot(base64, savePath, mime) {
        if (savePath !== undefined) {
            // Admission failures propagate unchanged: they describe the caller's
            // path, not a disk problem.
            const target = this.admitSavePath(savePath, 'screenshot');
            try {
                mkdirSync(dirname(target), { recursive: true });
                writeFileSync(target, Buffer.from(base64, 'base64'));
                return { dataUrl: `data:${mime};base64,${base64}`, path: target };
            }
            catch (error) {
                // Report the write problem but keep the capture usable.
                throw new BrowserError(`browser: screenshot save to "${target}" failed: ${String(error)}`, 'BROWSER_SCREENSHOT_SAVE_FAILED', { cause: error });
            }
        }
        return { dataUrl: `data:${mime};base64,${base64}` };
    }
    /** Append one operation to the session's history. */
    record(s, action, params, ok, detail) {
        const entry = {
            seq: s.nextSeq++,
            action,
            params,
            ok,
            ...detail?.result !== undefined ? { result: detail.result } : {},
            ...detail?.error !== undefined ? { error: detail.error } : {},
            at: Date.now(),
        };
        s.history.push(entry);
        // Bound memory: keep the last 500 operations.
        if (s.history.length > 500)
            s.history.splice(0, s.history.length - 500);
    }
    /** Return the session's chronological operation log (newest last). */
    async history(session) {
        return this.session(session).history;
    }
    /**
     * Record one page visit in the persistent browsing history. Fire-and-forget by
     * design: a visit must never delay or fail the navigation that produced it,
     * and the title is only worth reading once the document has settled.
     * @param s - the session that drove the visit.
     * @param handle - the view whose document just loaded.
     */
    recordVisit(s, handle) {
        const store = this.historyStore;
        if (store === undefined)
            return;
        // The settings panel can switch recording off at runtime; the static config
        // only supplies the startup default.
        if (this.settingsSource !== undefined && !this.settingsSource().history.enabled)
            return;
        void handleSendEvaluate(handle, 'location.href + "\\u0000" + (document.title || "")')
            .then(result => {
            if (!result.ok || typeof result.value !== 'string')
                return;
            const [url = '', title = ''] = result.value.split('\u0000');
            // Internal documents are not visits: an untouched browser is not history.
            if (url === '' || url.startsWith('about:') || url.startsWith('devtools:'))
                return;
            store.append({
                at: Date.now(),
                url,
                ...title.trim() !== '' ? { title: title.trim() } : {},
                ...s.label !== undefined ? { session: s.label } : {},
            });
            store.prune();
        })
            .catch(() => { });
    }
    /**
     * List persisted visits, newest first — what `browser_visited` reads back.
     * @param options - result cap and an optional hostname filter.
     * @returns the matching visits, or an empty list when history is disabled.
     */
    visited(options = {}) {
        return this.historyStore?.list(options) ?? [];
    }
    /**
     * Show the synthetic pointer on a view, unless the user switched it off. The
     * cursor is the "the agent has taken over this tab" signal, so it is painted
     * for every operation that has a landing point — including DOM-level ones that
     * move no real pointer.
     * @param handle - the view to paint into.
     * @param x - viewport x in CSS pixels.
     * @param y - viewport y in CSS pixels.
     * @param action - click pulses a ripple; move only relocates.
     * @param label - short description of the operation, shown beside the pointer.
     * @param force - paint even when the pointer is already there (a click ripple must
     *   always play; a bare move need not repeat).
     */
    showCursor(handle, x, y, action, label, force = false) {
        if (this.settingsSource !== undefined && !this.settingsSource().ui.virtualCursor)
            return;
        paintCursor(handle, x, y, action, (target, expression) => handleSendEvaluate(target, expression), label, force);
    }
    /**
     * Replay one recorded operation by sequence number. Navigate/click/type are
     * re-issued against the current page; execute re-runs its script. The
     * replayed step is appended to history as a new entry.
     * @param session - the session id.
     * @param seq - the recorded entry's sequence number to replay.
     */
    async replay(session, seq) {
        const s = this.session(session);
        const entry = s.history.find(e => e.seq === seq);
        if (entry === undefined) {
            throw new BrowserError(`browser: no history entry with seq ${seq}`, 'BROWSER_HISTORY_UNKNOWN');
        }
        switch (entry.action) {
            case 'navigate': {
                const url = entry.params.url;
                if (typeof url !== 'string')
                    throw new BrowserError(`browser: history seq ${seq} navigate has no url`, 'BROWSER_HISTORY_INVALID');
                await this.navigate(session, { url });
                this.record(s, 'replay', { seq, of: entry.action, url }, true);
                return;
            }
            case 'click': {
                const target = entry.params.target;
                if (target !== undefined) {
                    await this.click(session, { target });
                    this.record(s, 'replay', { seq, of: entry.action, target }, true);
                    return;
                }
                const x = entry.params.x;
                const y = entry.params.y;
                if (typeof x !== 'number' || typeof y !== 'number')
                    throw new BrowserError(`browser: history seq ${seq} click has no coordinates`, 'BROWSER_HISTORY_INVALID');
                await this.click(session, { x, y });
                this.record(s, 'replay', { seq, of: entry.action, x, y }, true);
                return;
            }
            case 'type': {
                const text = entry.params.text;
                if (typeof text !== 'string')
                    throw new BrowserError(`browser: history seq ${seq} type has no text`, 'BROWSER_HISTORY_INVALID');
                const target = entry.params.target;
                await this.type(session, { text, ...target !== undefined ? { target } : {} });
                this.record(s, 'replay', { seq, of: entry.action, text, ...target !== undefined ? { target } : {} }, true);
                return;
            }
            case 'scroll': {
                await this.scroll(session, entry.params);
                this.record(s, 'replay', { seq, of: entry.action }, true);
                return;
            }
            case 'key': {
                const key = entry.params.key;
                if (typeof key !== 'string')
                    throw new BrowserError(`browser: history seq ${seq} key has no key`, 'BROWSER_HISTORY_INVALID');
                await this.key(session, { key });
                this.record(s, 'replay', { seq, of: entry.action, key }, true);
                return;
            }
            case 'execute': {
                const script = entry.params.script;
                if (typeof script !== 'string')
                    throw new BrowserError(`browser: history seq ${seq} execute has no script`, 'BROWSER_HISTORY_INVALID');
                const recordedArgs = entry.params.args;
                const args = Array.isArray(recordedArgs)
                    ? recordedArgs.filter((a) => typeof a === 'string' || typeof a === 'number' || typeof a === 'boolean')
                    : undefined;
                const result = await this.execute(session, { script, ...args !== undefined && args.length > 0 ? { args } : {} });
                this.record(s, 'replay', { seq, of: entry.action, script, ...args !== undefined && args.length > 0 ? { args } : {} }, result.ok, result.ok ? { result: String(result.value) } : { error: result.exception });
                return;
            }
            default:
                throw new BrowserError(`browser: history seq ${seq} action "${entry.action}" is not replayable`, 'BROWSER_HISTORY_NOT_REPLAYABLE');
        }
    }
    /** Close the session and destroy all its views. Idempotent. */
    close(session) {
        const existing = this.sessions.get(session);
        if (existing !== undefined) {
            this.sessions.delete(session);
            for (const tab of existing.tabs)
                this.host.destroyView(tab.handle);
            // Releasing the browser at session end is a setting, not fixed behaviour
            // (requirements §3). A self-hosted carrier already tore its window down with
            // the views above; the desktop's sidebar does not, so it is asked explicitly
            // — and its cookies plus the browsing history outlive the page either way.
            if (this.settingsSource !== undefined && this.settingsSource().ui.closeWithSession) {
                void this.host.releasePage?.().catch(() => undefined);
            }
        }
        return Promise.resolve();
    }
    /** Look up a session or throw the unknown-session error. */
    session(session) {
        const existing = this.sessions.get(session);
        if (existing === undefined) {
            throw new BrowserError(`browser: session "${session}" is not open`, 'BROWSER_SESSION_UNKNOWN');
        }
        return existing;
    }
    /** The active tab of a session. */
    activeTab(s) {
        const tab = s.tabs[s.activeIndex];
        if (tab === undefined)
            throw new BrowserError('browser: session has no active tab', 'BROWSER_TAB_UNKNOWN');
        return tab;
    }
    /** Append a fresh tab and make it active. */
    newTab(s) {
        const handle = this.host.createView();
        // Same window as the session's other tabs.
        this.host.groupView?.(handle, s.id, s.label);
        s.tabs.push({ id: `tab:${randomUUID()}`, handle });
        s.activeIndex = s.tabs.length - 1;
        this.showActive(s);
    }
    /** Find a session's tab by its backing view id (toolbar actions carry view ids). */
    tabByViewId(s, viewId) {
        return s.tabs.find(tab => tab.handle.id === viewId);
    }
    /**
     * Whether a session is still live. The human closing a window ends its session
     * (see {@link handleViewClosed}), so callers that cache ids must ask first.
     * @param session - the session id to test.
     */
    exists(session) {
        return this.sessions.has(session);
    }
    /**
     * The human closed a browser window: the session that window showed is over.
     * Ending it here is what makes the next call a clean start rather than a
     * resurrection of an invisible window. Browsing history and login state live
     * on disk, so nothing the human cares about is lost with it.
     * @param windowId - the group key the host reported, which is the session id.
     */
    async handleViewClosed(windowId) {
        if (typeof windowId !== 'string' || windowId === '')
            return;
        const s = this.sessions.get(windowId);
        if (s === undefined)
            return;
        await this.close(s.id).catch(() => { });
    }
    /**
     * Route a user-initiated action from the host's UI into the session model.
     * Fire-and-forget by design: a user action failing (e.g. an unreachable
     * URL typed into the address bar) must never crash the host UI loop — it
     * is reported to the host (toolbar) when the host supports it, else logged.
     */
    async handleUserAction(action) {
        const s = this.sessions.get(action.windowId);
        if (s === undefined) {
            // The window the human clicked in has no live session here (session
            // closed, or a child restart changed identity). Never swallow the click
            // silently — surface it so the toolbar can tell the human what happened.
            const message = `action ${action.type} failed: no live browser session for window "${action.windowId}"`;
            process.stderr.write(`[dsh-browser] ${message}\n`);
            this.notifyUserActionError(action, new Error('no live browser session'));
            return;
        }
        try {
            switch (action.type) {
                case 'navigate':
                    await this.openUrl(s.id, { url: action.url });
                    return;
                case 'newTab':
                    this.newTab(s);
                    if (action.url !== undefined && action.url !== '') {
                        await this.navigate(s.id, { url: action.url });
                    }
                    return;
                case 'activateTab': {
                    const tab = this.tabByViewId(s, action.viewId);
                    if (tab !== undefined)
                        await this.switchTab(s.id, tab.id);
                    return;
                }
                case 'closeTab': {
                    const tab = this.tabByViewId(s, action.viewId);
                    if (tab !== undefined)
                        await this.closeTab(s.id, tab.id);
                    return;
                }
                case 'back':
                    await this.back(s.id);
                    return;
                case 'forward':
                    await this.forward(s.id);
                    return;
                case 'reload':
                    await this.reload(s.id);
                    return;
            }
        }
        catch (error) {
            this.notifyUserActionError(action, error);
        }
    }
    /**
     * Report a failed user action to the host UI (toolbar), when supported.
     *
     * Two properties matter here, because this runs inside the catch of an async
     * handler (issue #16):
     *  - the receiver must be preserved. Reading the method off the host and calling
     *    it unbound runs the host's implementation with `this === undefined`, so its
     *    very first statement (`void this.ready()`) throws, the throw escapes the
     *    async catch as an unhandled rejection, and the whole DSH host exits;
     *  - this method must be incapable of throwing. Reporting a failed action is
     *    diagnostics: it can never be allowed to become the failure.
     */
    notifyUserActionError(action, error) {
        const message = `action ${action.type} failed: ${String(error)}`;
        let reported = false;
        try {
            const host = this.host;
            const notify = host.notifyUserActionError;
            if (typeof notify === 'function') {
                // Called on its owner: an unbound call here kills the host process.
                notify.call(host, action.windowId, message);
                reported = true;
            }
        }
        catch (notifyError) {
            // Contained on purpose; the log line below still carries the original cause.
            process.stderr.write(`[dsh-browser] host notify failed: ${String(notifyError)}\n`);
        }
        if (!reported)
            process.stderr.write(`[dsh-browser] user action failed: ${message}\n`);
    }
    /**
     * Ask the host to show the active tab's view, carrying the session label.
     *
     * The two halves are sequential, not alternatives. `showView` makes the view the
     * visible one — which is what keeps what the human sees in step with what the agent
     * drives, and what lets `capturePage` return an image at all (a hidden view captures
     * empty) — while `collapse` folds the carrier's own chrome away when the user asked
     * for no auto-expand. Making them exclusive meant that with auto-expand off this
     * method did nothing at all on carriers without `collapse` (the self-hosted one),
     * silently desynchronising the two and failing every screenshot.
     */
    showActive(s) {
        this.host.showView?.(this.activeTab(s).handle, s.label);
        const autoExpand = this.settingsSource === undefined || this.settingsSource().ui.autoExpandOnce;
        if (autoExpand)
            return;
        // Best effort: a carrier that owns no presentation (self-hosted) simply has none.
        void this.host.collapse?.().catch(() => undefined);
    }
    /** Read the current URL of a view through CDP. */
    async currentUrl(handle) {
        // Bound the read: a wedged renderer would otherwise hang listTabs.
        const timeoutMs = 10_000;
        const result = await withTimeout(handleSendEvaluate(handle, 'location.href'), timeoutMs, undefined, `browser: url read timed out after ${timeoutMs}ms`, () => terminatePage(handle));
        return result.ok && typeof result.value === 'string' ? result.value : '';
    }
}
/**
 * Hard cap on waiting for a navigation's new document to be parsed. Bounded and
 * best-effort: a page that never settles must not fail the navigation.
 */
const SETTLE_TIMEOUT_MS = 5_000;
/**
 * When the document already looks settled but its identity has NOT changed
 * (same-document navigation, or the outgoing document still answering), wait
 * only this long before returning — there is no parse in flight to wait for.
 */
const SETTLE_GRACE_MS = 150;
/** Poll interval for the document-settle loop. */
const SETTLE_POLL_MS = 25;
/**
 * Extra time the transport gets over an in-page locate script's own budget: the
 * script polls for `timeoutMs` and answers only afterwards, so the outer wait
 * must outlast it or its generic timeout hides the in-page reason.
 */
const TARGET_SCRIPT_GRACE_MS = 2_000;
/** `tab:<uuid>` ↔ `<uuid>`: ids accept either form (see locateTab). */
function stripTabPrefix(id) {
    return id.startsWith('tab:') ? id.slice(4) : id;
}
/** Abortable sleep used by the settle loop. */
function delay(ms, signal) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            if (signal !== undefined)
                signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => { clearTimeout(timer); resolve(); };
        if (signal !== undefined)
            signal.addEventListener('abort', onAbort, { once: true });
    });
}
/**
 * Bound a promise so a wedged CDP call surfaces as an error instead of
 * hanging the tool call forever. The caller's signal, when provided, wins
 * over the timeout if it fires first.
 * @param promise - the operation to bound.
 * @param ms - the timeout budget.
 * @param signal - optional caller signal.
 * @param message - the timeout error message.
 * @returns the promise's value, or a rejected promise on timeout/abort.
 */
function withTimeout(promise, ms, signal, message, onCancel) {
    return new Promise((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => {
            if (done)
                return;
            done = true;
            // A fired timeout must also release the abort listener; { once: true }
            // only releases it on the next abort, which may never come.
            if (signal !== undefined)
                signal.removeEventListener('abort', onAbort);
            const error = new Error(message);
            error.name = 'TimeoutError';
            reject(error);
            // Best-effort interrupt of the underlying CDP call (see onCancel).
            onCancel?.();
        }, ms);
        const finish = (fn) => {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            if (signal !== undefined)
                signal.removeEventListener('abort', onAbort);
            fn();
        };
        const onAbort = () => {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
            onCancel?.();
        };
        if (signal !== undefined)
            signal.addEventListener('abort', onAbort, { once: true });
        promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    });
}
/**
 * Best-effort interrupt of a wedged page-script evaluation. `Runtime.evaluate`
 * with `awaitPromise` can hold the renderer (and the target's debugger queue)
 * behind a busy loop or a never-settling promise; terminating kills the
 * running script so subsequent commands are not stuck forever. Fire-and-forget:
 * if the interrupt itself hangs, it is ignored. Capped at
 * MAX_PENDING_TERMINATIONS per view to prevent unbounded pending entries
 * when the child is truly stuck.
 * @param handle - the view handle to terminate in.
 */
const pendingTerminations = new WeakMap();
const MAX_PENDING_TERMINATIONS = 3;
function terminatePage(handle) {
    const count = pendingTerminations.get(handle) ?? 0;
    if (count >= MAX_PENDING_TERMINATIONS)
        return;
    pendingTerminations.set(handle, count + 1);
    void handle.sendCommand('Runtime.terminateExecution').finally(() => {
        pendingTerminations.set(handle, Math.max(0, (pendingTerminations.get(handle) ?? 1) - 1));
    }).catch(() => { });
}
/**
 * Run a `Runtime.evaluate` through a view handle and normalize the result.
 * Shared by execute, snapshot, content, and internal URL reads.
 * @param handle - the view handle to evaluate in.
 * @param expression - the JS expression.
 * @param signal - optional abort signal; a fired signal rejects the call.
 */
/** Viewport point a target script reported, when it reported one. */
function scriptPoint(out) {
    const point = out?.__point;
    const x = Number(point?.x);
    const y = Number(point?.y);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}
async function handleSendEvaluate(handle, expression, signal) {
    signal?.throwIfAborted();
    const result = await handle.sendCommand(CDP_RUNTIME_EVALUATE, {
        expression,
        returnByValue: true,
        awaitPromise: true,
    });
    if (result.exceptionDetails !== undefined) {
        const detail = result.exceptionDetails;
        return { ok: false, exception: detail.exception?.description ?? detail.text ?? 'unknown exception' };
    }
    return { ok: true, value: result.result?.value ?? null };
}
