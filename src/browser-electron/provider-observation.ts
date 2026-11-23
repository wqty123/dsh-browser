import { DEFAULT_OPERATION_TIMEOUT_MS } from '../../assets/browser-policy.mjs'
import type { BrowserA11yRequest, BrowserA11yResult, BrowserChallenge, BrowserContentRequest, BrowserContentResult, BrowserScrapeRequest, BrowserScrapeResult, BrowserSessionId, BrowserSnapshotResult, BrowserWaitRequest, BrowserWaitResult } from '../browser/types.ts'
import { BrowserError } from '../browser/types.ts'
import { DEEP_DOM_SOURCE } from '../browser/deep-dom.ts'
import { PROVIDER_TIMEOUTS, TARGET_SCRIPT_GRACE_MS, delay, withTimeout, handleSendEvaluate } from './provider-core.ts'
import { ProviderNavigation } from './provider-navigation.ts'

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
})()`

/** Cap on content returned by a snapshot fetch to keep the wire bounded. */
const SNAPSHOT_LABEL_MAX = 120

export abstract class ProviderObservation extends ProviderNavigation {
  /**
   * Poll until the active tab's page is ready (and optional URL/selector
   * match), or the budget runs out. Returns a verdict instead of throwing on
   * timeout — the caller (model) decides what a miss means. Polling evaluates
   * in the CURRENT document, so after a navigation the old document may
   * briefly answer; pass the expected `url` to disambiguate.
   */
  async waitFor(session: BrowserSessionId, request: BrowserWaitRequest, signal?: AbortSignal): Promise<BrowserWaitResult> {
    const tab = this.activeTab(this.session(session))
    signal?.throwIfAborted()
    const timeoutMs = request.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS
    const deadline = Date.now() + timeoutMs
    const url = request.url ?? ''
    const selector = request.selector ?? ''
    const checkLoaded = request.loaded !== false
    const expression = `(() => {${DEEP_DOM_SOURCE}
      const wantUrl = ${JSON.stringify(url)}
      const wantSelector = ${JSON.stringify(selector)}
      const inDoc = (_doc, sel) => { try { return __dshQuery(sel) !== null } catch { return false } }
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
    })()`
    for (;;) {
      const result = await withTimeout(
        handleSendEvaluate(tab.handle, expression),
        Math.min(PROVIDER_TIMEOUTS.interaction, Math.max(250, deadline - Date.now())),
        signal,
        'browser: wait poll timed out',
        timedOut => { this.interrupt(tab.handle, timedOut) },
      )
      if (!result.ok) {
        throw new BrowserError(`browser: wait failed: ${result.exception}`, 'BROWSER_WAIT_FAILED')
      }
      const state = result.value as { urlOk: boolean; loadedOk: boolean; foundOk: boolean }
      const urlOk = url === '' || state.urlOk === true
      const loadedOk = !checkLoaded || state.loadedOk === true
      const foundOk = selector === '' || state.foundOk === true
      if (urlOk && loadedOk && foundOk) {
        return { ready: true, reason: 'condition met' }
      }
      if (Date.now() >= deadline) {
        const misses: string[] = []
        if (!urlOk) misses.push(`url not yet "${url}"`)
        if (!loadedOk) misses.push('page not loaded')
        if (!foundOk) misses.push(`selector "${selector}" not found`)
        return { ready: false, reason: misses.join('; ') }
      }
      // Sleep between polls, abortable by the caller.
      // Sleep between polls; delay() removes its abort listener on both paths, which the
      // hand-rolled version here did not — a 30s wait leaked about 150 of them.
      await delay(200, signal)
    }
  }

  /** Produce an AI-friendly snapshot of the active tab. */
  async snapshot(session: BrowserSessionId, signal?: AbortSignal): Promise<BrowserSnapshotResult> {
    const s = this.session(session)
    const tab = this.activeTab(s)
    signal?.throwIfAborted()
    // A tab that has never navigated is a blank, uncommitted view. The collector cannot answer in
    // it — there is no document to commit — so the call would sit out its whole budget before
    // saying anything. Answering the empty page immediately is both faster and more truthful.
    //
    // `about:blank` needs the same answer for a different reason: it HAS a document, so the collector
    // runs, finds nothing, and returns zero elements — indistinguishable from a real page with nothing
    // interactive. A caller then acts on it and receives success values, which is how a carrier swap
    // that started a fresh window looked like working tools operating on the wrong page (issue #37).
    const blankUrl = tab.url === '' || tab.url === 'about:blank'
    if (blankUrl) {
      return {
        url: tab.url,
        elements: [],
        truncated: false,
        blank: true,
        note: tab.url === ''
          ? 'no page has been opened in this browser yet'
          : 'the page is about:blank — nothing has been opened in this browser, so there is nothing to read or drive',
      }
    }
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
        // An anchor wrapping only an image has no text: 4399.com's 1608 game links are all
        // <a href><img alt="名字"></a>, so every label came out empty and the whole page read as
        // "no interactive elements" while it was full of them.
        const imageAlt = el.tagName === 'A' || el.tagName === 'BUTTON'
          ? (el.querySelector('img[alt]')?.getAttribute('alt') ?? '')
          : ''
        const label = (el.getAttribute('aria-label') || el.placeholder || el.textContent || imageAlt
          || el.value || el.name || el.id || '').toString().replace(/\\s+/g, ' ').trim().slice(0, ${String(SNAPSHOT_LABEL_MAX)})
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
      // The page's own URL is the authority on whether there is a document. The tracked tab.url is
      // a bookkeeping copy that can lag behind a navigation the browser performed itself, and a
      // stale copy made this check miss on a real about:blank tab.
      const blankPage = out.length === 0 && (url === '' || url === 'about:blank')
      // Independent of the element list: a page can mix DOM controls with a canvas that holds the
      // part the caller actually needs. Measured on sudoku.com — 60 links were collected and the
      // board, drawn on a canvas, was invisible in the same result.
      //
      // The thresholds keep a decorative canvas from claiming a page: at least 80x80 per canvas and
      // 10% of the viewport in total. Anything smaller is reported by nothing, which is right.
      let canvas
      if (blankPage !== true) {
        let area = 0
        let count = 0
        for (const c of document.querySelectorAll('canvas')) {
          const r = c.getBoundingClientRect()
          if (r.width < 80 || r.height < 80) continue
          count += 1
          area += r.width * r.height
        }
        const view = window.innerWidth * window.innerHeight
        if (count > 0 && view > 0 && area / view >= 0.1) canvas = true
      }
      return {
        url,
        title,
        elements: out,
        truncated: out.length >= cap,
        challenge,
        ...blankPage === true
          ? {
            blank: true,
            note: 'the page is about:blank — nothing has been opened in this browser, so there is nothing to read or drive',
          }
          : {},
        ...canvas === true
          ? {
            canvas: true,
            note: out.length === 0
              ? 'this page draws its interface on a canvas, so there is no DOM content for a snapshot. '
                + 'Use dsh_browser_screenshot to see it, and coordinates with dsh_browser_click to act on it.'
              : 'part of this page is drawn on a canvas, which no element list can describe. The elements '
                + 'below are real; anything inside the canvas is only visible in dsh_browser_screenshot.',
          }
          : {},
      }
    })()`
    // Same hang guard as execute: a renderer that has not committed after
    // navigate would otherwise block snapshot forever.
    const timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS
    let result: { ok: true; value: unknown } | { ok: false; exception: string }
    try {
      result = await withTimeout(
        handleSendEvaluate(tab.handle, script),
        timeoutMs,
        signal,
        `browser: snapshot timed out after ${timeoutMs}ms`,
        timedOut => { this.interrupt(tab.handle, timedOut) },
      ) as { ok: true; value: unknown } | { ok: false; exception: string }
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        this.quarantine(tab.handle)
        throw new BrowserError(
          'browser: snapshot timed out; the guest is quarantined. Close this tab or explicitly reset the session.',
          'BROWSER_SNAPSHOT_TIMEOUT',
          { cause: error },
        )
      }
      throw error
    }
    if (!result.ok) throw new BrowserError(`browser: snapshot evaluation failed: ${result.exception}`, 'BROWSER_SNAPSHOT_FAILED')
    const value = result.value as BrowserSnapshotResult
    return value
  }

  /**
   * Read the active tab's accessibility tree: semantic roles/names/states for
   * every interactive node (Chrome's `computedRole`/`computedName` when
   * available, tag/attribute inference otherwise). Pierces same-origin
   * iframes and shadow roots like the snapshot; cross-origin frames stay
   * opaque. Coordinates are top-document viewport-relative, so a node can
   * also be driven by click/type.
   */
  async a11y(session: BrowserSessionId, request: BrowserA11yRequest, signal?: AbortSignal): Promise<BrowserA11yResult> {
    const s = this.session(session)
    const tab = this.activeTab(s)
    signal?.throwIfAborted()
    // Same short-circuit as `snapshot`: a tab that never navigated has no committed document, so
    // the tree cannot be read and the call would spend its whole budget discovering that.
    if (tab.url === '') return { url: '', title: undefined, count: 0, nodes: [], truncated: false }
    const includeHidden = request.includeHidden === true
    // 150 rather than 500. The cap fills on any real page, and 500 nodes measured 38,953
      // characters — 10k-13k tokens for a single call. A caller that needs more asks for it.
      const maxNodes = Math.max(10, Math.min(5000, Math.floor(request.maxNodes ?? 150)))
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
    })()`
    const timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS
    let result: { ok: true; value: unknown } | { ok: false; exception: string }
    try {
      result = await withTimeout(
        handleSendEvaluate(tab.handle, script),
        timeoutMs,
        signal,
        `browser: a11y timed out after ${timeoutMs}ms`,
        timedOut => { this.interrupt(tab.handle, timedOut) },
      ) as { ok: true; value: unknown } | { ok: false; exception: string }
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        this.quarantine(tab.handle)
        throw new BrowserError(
          'browser: a11y timed out; the guest is quarantined. Close this tab or explicitly reset the session.',
          'BROWSER_A11Y_TIMEOUT',
          { cause: error },
        )
      }
      throw error
    }
    if (!result.ok) throw new BrowserError(`browser: a11y evaluation failed: ${result.exception}`, 'BROWSER_A11Y_FAILED')
    const value = result.value as BrowserA11yResult
    this.record(s, 'a11y', { includeHidden, maxNodes }, true, { result: `${value.count} nodes` })
    return value
  }

  /** Check whether a human-verification challenge is blocking the active tab. */
  async detectChallenge(session: BrowserSessionId, signal?: AbortSignal): Promise<BrowserChallenge> {
    const s = this.session(session)
    const tab = this.activeTab(s)
    signal?.throwIfAborted()
    const timeoutMs = PROVIDER_TIMEOUTS.action
    const result = await withTimeout(
      handleSendEvaluate(tab.handle, CHALLENGE_DETECT_EXPRESSION),
      timeoutMs,
      signal,
      `browser: challenge detection timed out after ${timeoutMs}ms`,
      timedOut => { this.interrupt(tab.handle, timedOut) },
    )
    if (!result.ok) {
      throw new BrowserError(`browser: challenge detection failed: ${result.exception}`, 'BROWSER_CHALLENGE_DETECT_FAILED')
    }
    const value = result.value as BrowserChallenge
    return { blocked: value.blocked === true, kind: value.kind, reason: value.reason }
  }

  /** Fetch page content in a requested format. */
  async content(session: BrowserSessionId, request: BrowserContentRequest, signal?: AbortSignal): Promise<BrowserContentResult> {
    const tab = this.activeTab(this.session(session))
    signal?.throwIfAborted()
    const selector = request.selector ?? ''
    const format = request.format
    // Per-format caps. A full HTML document is enormous, but the same limit applied to
    // plain text is no limit at all (a whole page of text measured 25,882 characters).
    // This bounds the common case instead of letting one call spend 25k-33k tokens.
    //
    // The plugin config overrides the lot when it is set — see `contentMaxChars`. The caller's
    // own `maxChars` still outranks both: an explicit per-call bound is the most specific
    // statement of intent there is.
    const maxChars = request.maxChars
      ?? this.contentMaxChars
      ?? (format === 'html' || format === 'json' ? 50_000 : 20_000)
    const script = `(() => {${DEEP_DOM_SOURCE}
      const root = ${selector === '' ? 'document.body' : `__dshQuery(${JSON.stringify(selector)})`}
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
    })()`
    // Honor a per-call timeout: content evaluation can hang on a heavy page,
    // so a caller-supplied budget bounds it. Unlike a bare signal entry check,
    // withTimeout also interrupts a call already in flight.
    const timeoutMs = request.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS
    const result = await withTimeout(
      handleSendEvaluate(tab.handle, script),
      timeoutMs,
      signal,
      `browser: content timed out after ${timeoutMs}ms`,
      timedOut => { this.interrupt(tab.handle, timedOut) },
    )
    if (!result.ok) throw new BrowserError(`browser: content evaluation failed: ${result.exception}`, 'BROWSER_CONTENT_FAILED')
    const value = result.value as { ok: boolean; reason?: string; content?: string; truncated?: boolean }
    if (!value.ok) throw new BrowserError(`browser: content fetch failed: ${value.reason ?? 'unknown'}`, 'BROWSER_CONTENT_FAILED')
    return { content: value.content ?? '', truncated: value.truncated ?? false }
  }

  /**
   * Extract structured data from repeated DOM items (static CSS, CSP-safe —
   * no arbitrary code runs). Waits for the item selector, then maps each item
   * through the field selectors; `selector@attr` reads an attribute instead
   * of text (`a@href` yields an absolute URL).
   */
  async scrape(session: BrowserSessionId, request: BrowserScrapeRequest, signal?: AbortSignal): Promise<BrowserScrapeResult> {
    const s = this.session(session)
    const tab = this.activeTab(s)
    signal?.throwIfAborted()
    const timeoutMs = request.timeoutMs ?? PROVIDER_TIMEOUTS.interaction
    const script = `(async () => {${DEEP_DOM_SOURCE}
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
        try { items = __dshQueryAll(itemSel) }
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
    })()`
    const result = await withTimeout(
      handleSendEvaluate(tab.handle, script),
      timeoutMs + TARGET_SCRIPT_GRACE_MS,
      signal,
      `browser: scrape timed out after ${timeoutMs}ms`,
      timedOut => { this.interrupt(tab.handle, timedOut) },
    )
    if (!result.ok) throw new BrowserError(`browser: scrape evaluation failed: ${result.exception}`, 'BROWSER_SCRAPE_FAILED')
    const value = result.value as { ok?: boolean; error?: string; count?: number; items?: Record<string, string | null>[] }
    if (value.ok !== true) throw new BrowserError(`browser: scrape failed: ${value.error ?? 'unknown'}`, 'BROWSER_SCRAPE_FAILED')
    const items = value.items ?? []
    this.record(s, 'scrape', { item: request.item, fields: request.fields.map(f => f.name) }, true, { result: `${items.length} items` })
    return { count: items.length, items }
  }
}
