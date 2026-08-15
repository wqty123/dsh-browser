/**
 * Electron-backed browser provider: `WebContentsView` sessions driven over
 * `webContents.debugger` (CDP). The provider itself does not import Electron — it operates through the {@link ElectronBrowserViewHost} seam, which the
 * desktop shell implements with real Electron objects. That keeps this
 * package testable under plain Node and leaves the Electron dependency to the
 * shell that owns the `BrowserWindow`.
 * @module dsh-browser/browser-electron
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { BrowserError } from "../browser/types.js";
/** Stable provider id registered with `ctx.browser`. */
export const ELECTRON_BROWSER_PROVIDER_ID = 'electron';
/** CDP method for a full-page screenshot capture. */
export const CDP_PAGE_CAPTURE_SCREENSHOT = 'Page.captureScreenshot';
/** CDP method for runtime evaluation (the execute path). */
export const CDP_RUNTIME_EVALUATE = 'Runtime.evaluate';
/** CDP method for navigation. */
export const CDP_PAGE_NAVIGATE = 'Page.navigate';
/** Cap on content returned by a snapshot fetch to keep the wire bounded. */
const SNAPSHOT_LABEL_MAX = 120;
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
    constructor(host, config = {}) {
        this.host = host;
        this.httpOnly = config.httpOnly ?? true;
        this.snapshotMaxElements = config.snapshotMaxElements ?? 60;
        this.contentMaxChars = config.contentMaxChars ?? 100_000;
    }
    /** Usable whenever the host can create views (always in the desktop shell). */
    available() {
        return true;
    }
    /**
     * Get the shared browser session: the one the host already owns, or a new
     * one on first use. Shared-browser semantics (Cherry Studio's
     * `getOrCreateWindow` pattern): the host's startup view and every later
     * agent call must land on the SAME session and view, so opening again
     * returns the existing session instead of creating a second view the human
     * cannot see. Closing the session resets this; the next open starts fresh.
     */
    open() {
        const [existing] = this.sessions.keys();
        if (existing !== undefined)
            return Promise.resolve(existing);
        const handle = this.host.createView();
        const id = `browser:${randomUUID()}`;
        this.sessions.set(id, { id, tabs: [{ id: `tab:${randomUUID()}`, handle }], activeIndex: 0, history: [] });
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
        const s = this.session(session);
        const index = s.tabs.findIndex(tab => tab.id === tabId);
        if (index < 0) {
            throw new BrowserError(`browser: tab "${tabId}" is not open in this session`, 'BROWSER_TAB_UNKNOWN');
        }
        s.activeIndex = index;
        this.showActive(s);
        return Promise.resolve();
    }
    /** Close one tab; closing the active tab activates the next. */
    closeTab(session, tabId) {
        const s = this.session(session);
        const index = s.tabs.findIndex(tab => tab.id === tabId);
        if (index < 0)
            return Promise.resolve(); // idempotent
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
        else if (s.activeIndex >= s.tabs.length) {
            // The active tab itself was closed; activate the last remaining one.
            s.activeIndex = s.tabs.length - 1;
        }
        this.showActive(s);
        return Promise.resolve();
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
            const result = await handle.sendCommand(CDP_PAGE_NAVIGATE, { url });
            // Page.navigate resolves even when the navigation fails; surface the
            // failure instead of leaving a silent white screen.
            const errorText = result.errorText;
            if (typeof errorText === 'string' && errorText !== '') {
                this.record(s, 'navigate', { url }, false, { error: errorText });
                throw new BrowserError(`browser: navigation to "${url}" failed: ${errorText}`, 'BROWSER_NAVIGATION_FAILED');
            }
            this.record(s, 'navigate', { url }, true);
        }
        catch (error) {
            if (!(error instanceof BrowserError && error.code === 'BROWSER_NAVIGATION_BLOCKED')) {
                this.record(s, 'navigate', { url }, false, { error: String(error) });
            }
            throw error;
        }
    }
    /** Execute JS in the active tab's page context. */
    async execute(session, request, signal) {
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
            }), timeoutMs, signal, `browser: execute timed out after ${timeoutMs}ms`);
            if (result.exceptionDetails !== undefined) {
                const detail = result.exceptionDetails;
                const exception = detail.exception?.description ?? detail.text ?? 'unknown exception';
                this.record(s, 'execute', { script: request.script }, false, { error: exception });
                return { ok: false, exception };
            }
            const value = result.result?.value ?? null;
            this.record(s, 'execute', { script: request.script }, true, { result: typeof value === 'string' ? value.slice(0, 500) : JSON.stringify(value).slice(0, 500) });
            return { ok: true, value };
        }
        catch (error) {
            throw new BrowserError(`browser: execute failed: ${String(error)}`, 'BROWSER_EXECUTE_FAILED', { cause: error });
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
      const els = [...document.querySelectorAll('input, textarea, select, button, a[href], [role="button"], [role="searchbox"], [contenteditable="true"]')]
      const out = []
      for (const el of els) {
        if (out.length >= cap) break
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        if (r.width < 4 || r.height < 4 || cs.visibility === 'hidden' || cs.display === 'none') continue
        const kind = el.tagName === 'INPUT' ? (el.type === 'checkbox' ? 'checkbox' : (el.type === 'submit' || el.type === 'button' ? 'button' : 'input'))
          : el.tagName === 'TEXTAREA' ? 'textarea'
          : el.tagName === 'SELECT' ? 'select'
          : el.tagName === 'BUTTON' ? 'button'
          : el.tagName === 'A' ? 'link' : 'other'
        const label = (el.getAttribute('aria-label') || el.placeholder || el.textContent || el.value || el.name || el.id || '').toString().replace(/\\s+/g, ' ').trim().slice(0, ${String(SNAPSHOT_LABEL_MAX)})
        if (!label && kind !== 'link') continue
        out.push({
          ref: out.length + 1,
          kind,
          label,
          selector: el.id ? '#' + el.id : (el.name ? '[name=' + JSON.stringify(el.name) + ']' : ''),
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
        })
      }
      return { url, title, elements: out, truncated: out.length >= cap }
    })()`;
        // Same hang guard as execute: a renderer that has not committed after
        // navigate would otherwise block snapshot forever.
        const timeoutMs = 30_000;
        const result = await withTimeout(handleSendEvaluate(tab.handle, script), timeoutMs, signal, `browser: snapshot timed out after ${timeoutMs}ms`);
        if (!result.ok)
            throw new BrowserError(`browser: snapshot evaluation failed: ${result.exception}`, 'BROWSER_SNAPSHOT_FAILED');
        const value = result.value;
        return value;
    }
    /** Fetch page content in a requested format. */
    async content(session, request, signal) {
        const tab = this.activeTab(this.session(session));
        signal?.throwIfAborted();
        const maxChars = request.maxChars ?? this.contentMaxChars;
        const selector = request.selector ?? '';
        const format = request.format;
        const script = `(() => {
      const root = ${selector === '' ? 'document.body' : `document.querySelector(${JSON.stringify(selector)})`}
      if (!root) return { ok: false, reason: 'selector not found' }
      const fmt = ${JSON.stringify(format)}
      let content = ''
      if (fmt === 'txt') content = root.innerText || ''
      else if (fmt === 'html') content = root.outerHTML || ''
      else if (fmt === 'json') content = JSON.stringify(root)
      else {
        // markdown: headings, paragraphs, links, lists (best-effort)
        const parts = []
        const walk = (node) => {
          if (node.nodeType === Node.TEXT_NODE) { const t = (node.textContent || '').trim(); if (t) parts.push(t); return }
          if (node.nodeType !== Node.ELEMENT_NODE) return
          const tag = node.tagName.toLowerCase()
          if (tag === 'script' || tag === 'style' || tag === 'noscript') return
          if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4') parts.push('\\n' + '#'.repeat(Number(tag[1])) + ' ' + (node.textContent || '').trim() + '\\n')
          else if (tag === 'a') { const t = (node.textContent || '').trim(); if (t) parts.push('[' + t + '](' + (node.href || '') + ')') }
          else if (tag === 'li') parts.push('  - ' + (node.textContent || '').trim())
          else if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article') { const t = (node.textContent || '').trim(); if (t) parts.push(t + '\\n') }
          else { for (const child of node.childNodes) walk(child) }
        }
        if (root.nodeType === Node.TEXT_NODE) walk(root)
        else for (const child of root.childNodes) walk(child)
        // Join without a separator: each part already carries its own trailing
        // newline, so a space join would smear headings/links into run-on text.
        content = parts.join('')
      }
      const truncated = content.length > ${String(maxChars)}
      return { ok: true, content: content.slice(0, ${String(maxChars)}), truncated }
    })()`;
        // Honor a per-call timeout: content evaluation can hang on a heavy page,
        // so a caller-supplied budget bounds it. AbortSignal.any merges the
        // caller's signal with a timeout.
        const timeoutMs = request.timeoutMs ?? 30_000;
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const result = signal !== undefined
            ? await handleSendEvaluate(tab.handle, script, AbortSignal.any([signal, timeoutSignal]))
            : await handleSendEvaluate(tab.handle, script, timeoutSignal);
        if (!result.ok)
            throw new BrowserError(`browser: content evaluation failed: ${result.exception}`, 'BROWSER_CONTENT_FAILED');
        const value = result.value;
        if (!value.ok)
            throw new BrowserError(`browser: content fetch failed: ${value.reason ?? 'unknown'}`, 'BROWSER_CONTENT_FAILED');
        return { content: value.content ?? '', truncated: value.truncated ?? false };
    }
    /** Click at viewport coordinates (CDP mousePressed + mouseReleased). */
    async click(session, request, signal) {
        const s = this.session(session);
        const { handle } = this.activeTab(s);
        signal?.throwIfAborted();
        await handle.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: request.x, y: request.y, button: 'left', clickCount: 1 });
        await handle.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: request.x, y: request.y, button: 'left', clickCount: 1 });
        this.record(s, 'click', { x: request.x, y: request.y }, true);
    }
    /** Type into the focused element. */
    async type(session, request, signal) {
        const s = this.session(session);
        const { handle } = this.activeTab(s);
        signal?.throwIfAborted();
        await handle.sendCommand('Input.insertText', { text: request.text });
        this.record(s, 'type', { text: request.text.slice(0, 200) }, true);
    }
    /**
     * Download a URL to a local file, keeping the session's cookies/login.
     * Requires the self-hosted host (which implements view-level download); the
     * desktop shell's embedded views delegate downloads to the real browser UI.
     */
    async download(session, request, signal) {
        const s = this.session(session);
        const { handle } = this.activeTab(s);
        signal?.throwIfAborted();
        const downloadable = handle;
        if (typeof downloadable.download !== 'function') {
            throw new BrowserError('browser: download is only available on the self-hosted browser', 'BROWSER_DOWNLOAD_UNSUPPORTED');
        }
        await downloadable.download(request.url, request.savePath);
        this.record(s, 'download', { url: request.url, savePath: request.savePath }, true, { result: request.savePath });
        return { path: request.savePath };
    }
    /**
     * Export the session's cookies (login state) as serializable objects.
     * Self-hosted only; the desktop shell's embedded views use the real profile.
     */
    async flushAuth(session) {
        const s = this.session(session);
        const { handle } = this.activeTab(s);
        const host = handle;
        if (typeof host.flushAuth !== 'function') {
            throw new BrowserError('browser: auth export is only available on the self-hosted browser', 'BROWSER_AUTH_UNSUPPORTED');
        }
        const cookies = await host.flushAuth();
        this.record(s, 'flushAuth', {}, true, { result: `${cookies.length} cookies` });
        return cookies;
    }
    /** Import cookies into the session (restore login state). Self-hosted only. */
    async restoreAuth(session, cookies) {
        const s = this.session(session);
        const { handle } = this.activeTab(s);
        const host = handle;
        if (typeof host.restoreAuth !== 'function') {
            throw new BrowserError('browser: auth restore is only available on the self-hosted browser', 'BROWSER_AUTH_UNSUPPORTED');
        }
        const restored = await host.restoreAuth(cookies);
        this.record(s, 'restoreAuth', { count: cookies.length }, true, { result: `${restored} cookies` });
        return restored;
    }
    /** Capture the current page, optionally full-page. PNG only (CDP JPEG hangs on Electron 43). */
    async screenshot(session, request, signal) {
        const { handle } = this.activeTab(this.session(session));
        signal?.throwIfAborted();
        const params = {};
        if (request?.fullPage === true) {
            // `captureBeyondViewport` captures the full scrollable content; without
            // a clip this yields the full-page image (CDP default is the viewport).
            params.captureBeyondViewport = true;
        }
        const result = await handle.sendCommand(CDP_PAGE_CAPTURE_SCREENSHOT, params);
        const data = result.data;
        if (typeof data !== 'string') {
            throw new BrowserError('browser: screenshot returned no image data', 'BROWSER_SCREENSHOT_FAILED');
        }
        // Optional disk write so a vision tool (e.g. modlens read_image) can read
        // the screenshot from a file path. Fire-and-forget: a write failure must
        // not fail the capture.
        if (request?.savePath !== undefined) {
            try {
                writeFileSync(request.savePath, Buffer.from(data, 'base64'));
                return { dataUrl: `data:image/png;base64,${data}`, path: request.savePath };
            }
            catch (error) {
                // Report the write problem but keep the capture usable.
                throw new BrowserError(`browser: screenshot save to "${request.savePath}" failed: ${String(error)}`, 'BROWSER_SCREENSHOT_SAVE_FAILED', { cause: error });
            }
        }
        return { dataUrl: `data:image/png;base64,${data}` };
    }
    /** Append one operation to the session's history. */
    record(s, action, params, ok, detail) {
        const entry = {
            seq: s.history.length + 1,
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
                await this.type(session, { text });
                this.record(s, 'replay', { seq, of: entry.action, text }, true);
                return;
            }
            case 'execute': {
                const script = entry.params.script;
                if (typeof script !== 'string')
                    throw new BrowserError(`browser: history seq ${seq} execute has no script`, 'BROWSER_HISTORY_INVALID');
                const result = await this.execute(session, { script });
                this.record(s, 'replay', { seq, of: entry.action, script }, result.ok, result.ok ? { result: String(result.value) } : { error: result.exception });
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
        s.tabs.push({ id: `tab:${randomUUID()}`, handle });
        s.activeIndex = s.tabs.length - 1;
        this.showActive(s);
    }
    /** Ask the host to show the active tab's view. */
    showActive(s) {
        this.host.showView?.(this.activeTab(s).handle);
    }
    /** Read the current URL of a view through CDP. */
    async currentUrl(handle) {
        const result = await handleSendEvaluate(handle, 'location.href');
        return result.ok && typeof result.value === 'string' ? result.value : '';
    }
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
function withTimeout(promise, ms, signal, message) {
    return new Promise((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => {
            if (done)
                return;
            done = true;
            reject(new Error(message));
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
        };
        if (signal !== undefined)
            signal.addEventListener('abort', onAbort, { once: true });
        promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    });
}
/**
 * Run a `Runtime.evaluate` through a view handle and normalize the result.
 * Shared by execute, snapshot, content, and internal URL reads.
 * @param handle - the view handle to evaluate in.
 * @param expression - the JS expression.
 * @param signal - optional abort signal; a fired signal rejects the call.
 */
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
