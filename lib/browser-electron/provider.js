/**
 * Electron-backed browser provider: `WebContentsView` sessions driven over
 * `webContents.debugger` (CDP). The provider itself does not import Electron 鈥? * it operates through the {@link ElectronBrowserViewHost} seam, which the
 * desktop shell implements with real Electron objects. That keeps this
 * package testable under plain Node and leaves the Electron dependency to the
 * shell that owns the `BrowserWindow`.
 * @module dsh-browser/browser-electron
 */
import { randomUUID } from 'node:crypto';
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
    /** Open a new session with one blank tab. */
    open() {
        const handle = this.host.createView();
        const id = `browser:${randomUUID()}`;
        this.sessions.set(id, { id, tabs: [{ id: `tab:${randomUUID()}`, handle }], activeIndex: 0 });
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
        const { handle } = this.activeTab(this.session(session));
        const url = request.url;
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
        await handle.sendCommand(CDP_PAGE_NAVIGATE, { url });
    }
    /** Execute JS in the active tab's page context. */
    async execute(session, request, signal) {
        const { handle } = this.activeTab(this.session(session));
        signal?.throwIfAborted();
        try {
            // Always wrap the script in a Function so `return` statements are legal
            // and request.args arrive as `arguments[0..n]`. A bare script handed to
            // CDP Runtime.evaluate is an expression context 鈥?a leading `return`
            // would be a syntax error. JSON-serializable args are embedded as a JSON
            // array literal; args that cannot serialize degrade to null members.
            const hasArgs = request.args !== undefined && request.args.length > 0;
            const expression = hasArgs
                ? `(function(){ const __dshArgs = ${JSON.stringify(request.args)}; return Function(${JSON.stringify(request.script)}).apply(null, __dshArgs) })()`
                : `(function(){ return Function(${JSON.stringify(request.script)})() })()`;
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
        const result = await handleSendEvaluate(tab.handle, script);
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
        const { handle } = this.activeTab(this.session(session));
        signal?.throwIfAborted();
        await handle.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: request.x, y: request.y, button: 'left', clickCount: 1 });
        await handle.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: request.x, y: request.y, button: 'left', clickCount: 1 });
    }
    /** Type into the focused element. */
    async type(session, request, signal) {
        const { handle } = this.activeTab(this.session(session));
        signal?.throwIfAborted();
        await handle.sendCommand('Input.insertText', { text: request.text });
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
        return { dataUrl: `data:image/png;base64,${data}` };
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
