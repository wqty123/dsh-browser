import { DEFAULT_OPERATION_TIMEOUT_MS } from '../../assets/browser-policy.mjs'
import { pageOperationScript } from '../tool-browser/page-probe.ts'
import { DEEP_DOM_SOURCE } from '../browser/deep-dom.ts'
import { paintCursor, type CursorAction } from './virtual-cursor.ts'
import type { BrowserCheckRequest, BrowserClearRequest, BrowserClickRequest, BrowserClickSequenceRequest, BrowserClickSequenceResult, BrowserElementTarget, BrowserPageOperationRequest, BrowserExecuteResult, BrowserFillRequest, BrowserFillResult, BrowserGetValueRequest, BrowserGetValueResult, BrowserSelectRequest, BrowserSelectResult, BrowserSessionId, BrowserSetValueRequest, BrowserSetValueResult, BrowserTypeRequest, BrowserScrollRequest, BrowserKeyRequest } from '../browser/types.ts'
import { BrowserError } from '../browser/types.ts'
import { PROVIDER_TIMEOUTS, KEY_SPECS, BROWSER_KEY_NAMES, TARGET_SCRIPT_GRACE_MS, pagePollSlice, withTimeout, scriptPoint, handleSendEvaluate, type ElectronViewHandle, type Tab, type CdpMouseParams, type CdpInsertTextParams } from './provider-core.ts'
import { ProviderObservation } from './provider-observation.ts'

/** An in-page locate for one poll slice: `last` reports a miss, earlier slices answer `{ pending: true }`. */
type TargetScript = (sliceMs: number, last: boolean) => string

export abstract class ProviderInteraction extends ProviderObservation {
  /** Run a fixed browser operation; the request cannot contain a script. */
  async pageOperation(session: BrowserSessionId, request: BrowserPageOperationRequest, signal?: AbortSignal): Promise<BrowserExecuteResult> {
    const script = pageOperationScript(request)
    if (request.operation === 'drag') {
      return this.dispatchPointer(session, request.from, request.to, request.steps, signal)
    }
    if (request.operation === 'probe' && request.method === 'hoverAt') {
      const point = { x: Number(request.args?.[0]), y: Number(request.args?.[1]) }
      return this.dispatchPointer(session, point, undefined, 1, signal)
    }
    return this.evaluatePage(session, { script }, signal)
  }

  /** Send page pointer input through CDP while preserving presentation and cancellation policy. */
  private async dispatchPointer(
    session: BrowserSessionId,
    from: { readonly x: number; readonly y: number },
    to: { readonly x: number; readonly y: number } | undefined,
    steps: number,
    signal?: AbortSignal,
  ): Promise<BrowserExecuteResult> {
    const coordinates = [from.x, from.y, ...to === undefined ? [] : [to.x, to.y]]
    if (coordinates.some(value => !Number.isFinite(value) || value < 0)) {
      throw new BrowserError('browser: pointer coordinates must be finite nonnegative viewport pixels', 'BROWSER_POINTER_INVALID')
    }
    if (to !== undefined && this.settingsSource?.().vision.strategy === 'nonVisual') {
      throw new BrowserError('browser: coordinate dragging requires the visual strategy', 'BROWSER_NON_VISUAL_COORDINATES')
    }
    const s = this.session(session)
    const handle = await this.present(s, signal)
    const viewport = await withTimeout(
      handleSendEvaluate(handle, '({width:innerWidth,height:innerHeight})'),
      PROVIDER_TIMEOUTS.interaction, signal, 'browser: pointer viewport check timed out',
    )
    if (!viewport.ok) throw new BrowserError('browser: could not read the pointer viewport', 'BROWSER_POINTER_INVALID')
    const size = viewport.value as { width: number; height: number }
    if (from.x >= size.width || from.y >= size.height || (to !== undefined && (to.x >= size.width || to.y >= size.height))) {
      return { ok: true, value: JSON.stringify(to === undefined ? false : { ok: false, reason: 'drag points must be inside the current viewport' }) }
    }
    const send = async (params: CdpMouseParams): Promise<void> => {
      signal?.throwIfAborted()
      this.assertSameView(session, handle, this.activeTab(s).handle)
      await withTimeout(handle.sendCommand('Input.dispatchMouseEvent', { ...params }), PROVIDER_TIMEOUTS.interaction, signal, 'browser: pointer input timed out')
    }
    await send({ type: 'mouseMoved', x: from.x, y: from.y, buttons: 0 })
    if (to === undefined) return { ok: true, value: 'true' }
    let at = from
    let held = true
    try {
      await send({ type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 })
      const count = Math.max(1, Math.min(Math.trunc(steps) || 12, 60))
      for (let step = 1; step <= count; step += 1) {
        const next = { x: from.x + (to.x - from.x) * step / count, y: from.y + (to.y - from.y) * step / count }
        await send({ type: 'mouseMoved', ...next, button: 'left', buttons: 1 })
        at = next
      }
      // Native HTML drag targets need a final drag-over before releasing at the destination.
      await send({ type: 'mouseMoved', ...to, button: 'left', buttons: 1 })
      await send({ type: 'mouseReleased', ...to, button: 'left', buttons: 0, clickCount: 1 })
      held = false
      return { ok: true, value: JSON.stringify({ ok: true, moved: count, at: to }) }
    } finally {
      if (held) {
        await withTimeout(
          handle.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'left', buttons: 0, clickCount: 1 }),
          1_000, undefined, 'browser: pointer release timed out',
        ).catch(() => {})
      }
    }
  }

  /**
   * Click at viewport coordinates, or at a located element's center when a
   * `target` (css/text/xpath) is given. CDP mousePressed + mouseReleased.
   */
  async click(
    session: BrowserSessionId,
    request: BrowserClickRequest | { readonly target: BrowserElementTarget },
    signal?: AbortSignal,
  ): Promise<void> {
    const s = this.session(session)
    // The view the locate runs against. It can stop being the session's active view while
    // the locate waits (see prepareTarget), so every dispatch below re-reads the live one.
    const locateHandle = this.activeTab(s).handle
    signal?.throwIfAborted()
    let x = 0
    let y = 0
    if ('target' in request) {
      // Semantic targeting (②): locate the element in-page, scroll it into
      // view, and click its center — no coordinate guessing needed.
      const locateMs = PROVIDER_TIMEOUTS.lookup
      const body = `
        el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' })
        const r = el.getBoundingClientRect()
        return { ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      `
      const script = this.buildTargetScript(request.target, locateMs, body)
      const out = await this.runTargetScript(this.activeTab(s), script, locateMs, signal, 'BROWSER_CLICK_FAILED', 'browser: click')
      x = Number(out.x)
      y = Number(out.y)
    } else {
      // A coordinate only exists because somebody read a picture. Under the
      // non-visual strategy the plugin must not accept one: a model that cannot
      // see cannot have produced it, so the coordinates are either copied from an
      // earlier vision pass or invented, and honouring them turns a silent
      // mis-click into a mystery. Refusing here, with a message that says what to
      // do instead, converts that into a usable instruction.
      if (this.settingsSource !== undefined && this.settingsSource().vision.strategy === 'nonVisual') {
        throw new BrowserError(
          'browser: the configured non-visual strategy refuses coordinate clicks — pass a semantic target instead, e.g. target { by: "text", value: "Sign in" }, which locates the element from the DOM and clicks its centre',
          'BROWSER_NON_VISUAL_COORDINATES',
        )
      }
      x = request.x
      y = request.y
    }
    // Input.* is only delivered to a view with a current display surface; the
    // barrier also re-presents after a navigation replaced the renderer. It returns the
    // handle that may still be receiving input when it settles.
    const handle = await this.present(s, signal)
    // The locate (up to 10s) and the present barrier both ran against the view captured
    // earlier; if the human switched tabs meanwhile, these coordinates belong to one page
    // and the dispatch would go to another — and Chromium answers success either way.
    if ('target' in request) this.assertSameView(session, locateHandle, handle)
    const timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS
    const send = (params: Record<string, unknown>, label: string): Promise<unknown> =>
      withTimeout(
        handle.sendCommand('Input.dispatchMouseEvent', params),
        timeoutMs,
        signal,
        `browser: click ${label} timed out after ${timeoutMs}ms`,
      )
    // Chromium routes a synthesized `mousePressed` to the widget's *current*
    // hover target rather than hit-testing the coordinates, and a real pointer
    // click is always preceded by movement. A view that has never received a
    // mouse event has no hover target yet, so the press of the FIRST click on a
    // fresh tab went nowhere while CDP still answered success; the second click
    // landed because the first had quietly established the target. Move the
    // pointer first so a click is self-contained.
    try {
      await send({ type: 'mouseMoved', x, y, buttons: 0 } satisfies CdpMouseParams, 'move')
    } catch (error) {
      throw new BrowserError(`browser: click failed: ${String(error)}`, 'BROWSER_CLICK_FAILED', { cause: error })
    }
    // Paint before the press so the ripple is already on screen when the click
    // lands — the cursor exists to show the human WHERE the agent acts.
    // Name the operation in the overlay: the pointer is the "agent is driving this
    // tab" signal, so the bubble is what lets a human follow along without the log.
    this.showCursor(handle, x, y, 'click', 'click', true)
    const release = (): void => {
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
          buttons: 0,
          clickCount: 1,
        } satisfies CdpMouseParams)
        .catch(() => {})
    }
    try {
      await send({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }, 'press')
    } catch (error) {
      // The press may still land late; release best-effort so the button is
      // never left in a stuck pressed state.
      release()
      throw new BrowserError(`browser: click failed: ${String(error)}`, 'BROWSER_CLICK_FAILED', { cause: error })
    }
    try {
      await send({ type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }, 'release')
    } catch (error) {
      // The press already landed; retry the release so the button is not
      // left pressed before surfacing the failure.
      release()
      throw new BrowserError(`browser: click failed: ${String(error)}`, 'BROWSER_CLICK_FAILED', { cause: error })
    }
    this.record(s, 'click', 'target' in request ? { target: request.target } : { x, y }, true)
  }

  /**
   * Click many points in order, once.
   *
   * The same wire sequence as {@link click}, looped — only the round-trip count changes. Presenting
   * happens ONCE: the display-surface barrier is per view, not per press, and paying it for every
   * point is what made an 86-cell board expensive.
   *
   * Stops at the first point that fails and reports where: a run that pressed through a page which
   * had navigated or lost its surface would fill the wrong cells and still answer success.
   * @param session - the session to click in.
   * @param request - the points and the interval between them.
   * @param signal - cancellation between points.
   * @returns how many points landed, and where it stopped if it did not finish.
   */
  async clickSequence(
    session: BrowserSessionId,
    request: BrowserClickSequenceRequest,
    signal?: AbortSignal,
  ): Promise<BrowserClickSequenceResult> {
    const s = this.session(session)
    const points = Array.isArray(request.points) ? request.points : []
    if (points.length === 0) return { clicked: 0 }
    if (this.settingsSource !== undefined && this.settingsSource().vision.strategy === 'nonVisual') {
      throw new BrowserError(
        'browser: the configured non-visual strategy refuses coordinate clicks — pass a semantic target instead.',
        'BROWSER_NON_VISUAL_COORDINATES',
      )
    }
    // One barrier for the whole run: cheap, and it is the view that needs a surface, not each press.
    const handle = await this.present(s, signal)
    const timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS
    // 40 ms is above one frame at 30 fps, which is what keeps the page from reading two presses as a
    // double click. Faster runs were measured dropping presses outright.
    const gap = typeof request.intervalMs === 'number' && request.intervalMs >= 0 ? request.intervalMs : 40
    const send = (params: Record<string, unknown>, label: string): Promise<unknown> =>
      withTimeout(
        handle.sendCommand('Input.dispatchMouseEvent', params),
        timeoutMs,
        signal,
        `browser: click sequence ${label} timed out after ${timeoutMs}ms`,
      )
    let clicked = 0
    for (const [index, point] of points.entries()) {
      signal?.throwIfAborted()
      const x = Number(point?.x)
      const y = Number(point?.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { clicked, failedAt: index, error: `point ${index} has no finite x/y` }
      }
      try {
        // The move is load-bearing: Chromium routes a synthesized press to the CURRENT hover target,
        // and a view that has never received a mouse event has none — the first press would go nowhere
        // while CDP still answered success.
        await send({ type: 'mouseMoved', x, y, buttons: 0 } satisfies CdpMouseParams, 'move')
        await send({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 } satisfies CdpMouseParams, 'press')
        await send({ type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 } satisfies CdpMouseParams, 'release')
        clicked += 1
      } catch (error) {
        // Best-effort release so a failed press cannot leave the button stuck down.
        void handle
          .sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
          .catch(() => {})
        return { clicked, failedAt: index, error: String(error instanceof Error ? error.message : error) }
      }
      if (index < points.length - 1 && gap > 0) await new Promise(resolve => setTimeout(resolve, gap))
    }
    return { clicked }
  }

  /**
   * Type into the focused element, or focus a located element (css/text/xpath)
   * first and then insert the text.
   */
  async type(
    session: BrowserSessionId,
    request: BrowserTypeRequest | { readonly target: BrowserElementTarget },
    signal?: AbortSignal,
  ): Promise<void> {
    const s = this.session(session)
    // The view the locate runs against. It can stop being the session's active view while
    // the locate waits (the human is invited to drive the same window), so the input below
    // goes to the handle `present` reports instead of this one.
    const locateHandle = this.activeTab(s).handle
    signal?.throwIfAborted()
    const hasTarget = 'target' in request
    if (hasTarget) {
      const locateMs = PROVIDER_TIMEOUTS.lookup
      const script = this.buildTargetScript(request.target, locateMs, `
        el.focus()
        return { ok: true }
      `)
      const locateTab = this.activeTab(s)
      const out = await this.runTargetScript(locateTab, script, locateMs, signal, 'BROWSER_TYPE_FAILED', 'browser: type')
      const cursorPoint = scriptPoint(out)
      if (cursorPoint !== undefined) this.showCursor(locateTab.handle, cursorPoint.x, cursorPoint.y, 'click', 'type', true)
    }
    const text = 'text' in request ? request.text : ''
    const timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS
    // Input.insertText goes through the Input domain: same display-surface
    // requirement as click/key. It also reports which view is active once the barrier has
    // settled, which is what makes the tab-switch check below meaningful.
    const handle = await this.present(s, signal)
    // Focusing one page and inserting into another is exactly the silent mis-target this
    // refuses: the element was focused in the located view, and the text would have gone to
    // whichever page is now visible — possibly a password field there.
    if (hasTarget) this.assertSameView(session, locateHandle, handle)
    try {
      await withTimeout(
        handle.sendCommand('Input.insertText', { text } satisfies CdpInsertTextParams),
        timeoutMs,
        signal,
        `browser: type timed out after ${timeoutMs}ms`,
      )
    } catch (error) {
      throw new BrowserError(`browser: type failed: ${String(error)}`, 'BROWSER_TYPE_FAILED', { cause: error })
    }
    // Store the full text so replay re-issues the same input; the history
    // tool truncates long values when rendering.
    this.record(s, 'type', { text, ...hasTarget ? { target: request.target } : {} }, true)
  }

  /** Scroll the page: by deltas, to a selector, or to top/bottom. */
  async scroll(session: BrowserSessionId, request: BrowserScrollRequest, signal?: AbortSignal): Promise<void> {
    const s = this.session(session)
    const tab = this.activeTab(s)
    signal?.throwIfAborted()
    const selector = request.selector ?? ''
    const script = `(() => {${DEEP_DOM_SOURCE}
      const sel = ${JSON.stringify(selector)}
      if (sel !== '') {
        const el = __dshQuery(sel)
        if (!el) return { ok: false, reason: 'selector not found' }
        el.scrollIntoView({ behavior: 'instant', block: 'center' })
        return { ok: true }
      }
      if (${request.toTop === true}) { window.scrollTo(0, 0); return { ok: true } }
      if (${request.toBottom === true}) { window.scrollTo(0, document.body.scrollHeight); return { ok: true } }
      window.scrollBy({ top: ${request.deltaY ?? 0}, left: ${request.deltaX ?? 0} })
      return { ok: true }
    })()`
    const timeoutMs = PROVIDER_TIMEOUTS.action
    const result = await withTimeout(
      handleSendEvaluate(tab.handle, script),
      timeoutMs,
      signal,
      `browser: scroll timed out after ${timeoutMs}ms`,
      timedOut => { this.interrupt(tab.handle, timedOut) },
    )
    if (!result.ok) throw new BrowserError(`browser: scroll failed: ${result.exception}`, 'BROWSER_SCROLL_FAILED')
    const value = result.value as { ok?: boolean; reason?: string }
    if (value.ok !== true) throw new BrowserError(`browser: scroll failed: ${value.reason ?? 'unknown'}`, 'BROWSER_SCROLL_FAILED')
    this.record(s, 'scroll', { ...request }, true)
  }

  /** Press one named key (Enter/Tab/arrows/…) via CDP key events. */
  async key(session: BrowserSessionId, request: BrowserKeyRequest, signal?: AbortSignal): Promise<void> {
    const s = this.session(session)
    signal?.throwIfAborted()
    const spec = KEY_SPECS[request.key]
    if (spec === undefined) {
      throw new BrowserError(`browser: unsupported key "${request.key}" (supported: ${BROWSER_KEY_NAMES.join(', ')})`, 'BROWSER_KEY_UNSUPPORTED')
    }
    const params = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk, ...spec.text !== undefined ? { text: spec.text } : {} }
    const timeoutMs = PROVIDER_TIMEOUTS.action
    // Input.dispatchKeyEvent is subject to the same display-surface rule. The handle comes
    // back from the presentation barrier rather than from a capture taken before it: this
    // session is shared with the human, who may switch tabs while the barrier round-trips,
    // and a key sent to the view they left is silently dropped (or lands on the new page).
    const handle = await this.present(s, signal)
    // Focus the SAME view the key is dispatched to; focusing the pre-switch handle would
    // grant web focus to a page that then receives nothing.
    await this.focusView(handle)
    const release = (): Promise<Record<string, unknown>> =>
      handle.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
    try {
      await withTimeout(handle.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...params }), timeoutMs, signal, `browser: key press timed out after ${timeoutMs}ms`)
    } catch (error) {
      // The press may still land late; release best-effort so the key is
      // never left in a stuck pressed state.
      void release().catch(() => {})
      throw new BrowserError(`browser: key "${request.key}" failed: ${String(error)}`, 'BROWSER_KEY_FAILED', { cause: error })
    }
    try {
      await withTimeout(release(), timeoutMs, signal, `browser: key release timed out after ${timeoutMs}ms`)
    } catch (error) {
      // The press already landed; retry the release before surfacing.
      void release().catch(() => {})
      throw new BrowserError(`browser: key "${request.key}" failed: ${String(error)}`, 'BROWSER_KEY_FAILED', { cause: error })
    }
    this.record(s, 'key', { key: request.key }, true)
  }

  /**
   * Fill a form's fields in one batch. Runs one page-context script that
   * resolves each field (selector, or name/label/placeholder among visible
   * controls), sets its value with the native prototype setter (React/Vue
   * controlled inputs included) plus input/change events, handles
   * select/checkbox/radio/contenteditable, and optionally submits the form.
   */
  async fillForm(session: BrowserSessionId, request: BrowserFillRequest, signal?: AbortSignal): Promise<BrowserFillResult> {
    const s = this.session(session)
    const tab = this.activeTab(s)
    signal?.throwIfAborted()
    const specs = JSON.stringify(request.fields.map(f => ({
      selector: f.selector ?? null,
      name: f.name ?? null,
      label: f.label ?? null,
      placeholder: f.placeholder ?? null,
      // A field with NO kind is a field with no kind FILTER: absent, not 'text'. Defaulting
      // it to 'text' here made `if (spec.kind)` above always true, so every unspecified
      // field was narrowed to an <input> — dsh_browser_fill on a <textarea> reported
      // `no "text" control matched`, and a contenteditable could not match any kind at all.
      // The value stays a string or null (never undefined): the in-page check tests truthiness,
      // and JSON drops an undefined member entirely, which is the same thing here.
      kind: f.kind ?? null,
      value: f.value,
    })))
    const submitFlag = request.submit === true
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
            const lbl = (el.getRootNode().querySelector ? el.getRootNode() : document).querySelector('label[for=' + JSON.stringify(el.id) + ']')
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
            out.push({ ok: false, error: 'file inputs cannot be set from script; use dsh_browser_download or ask the human', target: describe(spec) })
          } else if (type === 'checkbox') {
            const want = spec.value === true || spec.value === 'true' || spec.value === 'on'
            if (el.checked !== want) el.click()
            out.push({ ok: true, method: 'checkbox', target: describe(spec) })
          } else if (type === 'radio') {
            const wanted = String(spec.value)
            const radio = [...(el.getRootNode().querySelectorAll ? el.getRootNode() : document).querySelectorAll('input[type="radio"][name=' + JSON.stringify(el.name || '') + ']')]
              .filter(r => r.form === el.form)
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
    })()`
    const timeoutMs = request.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS
    const result = await withTimeout(
      handleSendEvaluate(tab.handle, script),
      timeoutMs,
      signal,
      `browser: fillForm timed out after ${timeoutMs}ms`,
      timedOut => { this.interrupt(tab.handle, timedOut) },
    )
    if (!result.ok) {
      throw new BrowserError(`browser: fillForm evaluation failed: ${result.exception}`, 'BROWSER_FILL_FAILED')
    }
    const value = result.value as BrowserFillResult
    const okCount = value.fields.filter(f => f.ok).length
    this.record(s, 'fill', { fields: request.fields.length, submit: submitFlag }, okCount === value.fields.length, {
      result: `${okCount}/${value.fields.length} fields filled${value.submitted ? ', form submitted' : ''}`,
    })
    return { fields: value.fields, submitted: value.submitted === true }
  }

  /**
   * Build an in-page async IIFE that locates ONE element by css/text/xpath
   * (polling until it appears or the budget runs out) and then runs `body`
   * with `el` in scope. Shared by the target-based tools: click/type (②),
   * setValue/check/select/clear/getValue (③), and the scrape item wait.
   * A selector that fails to PARSE is reported immediately instead of being
   * polled until the budget expires — see the comment in `match`.
   */
  private buildTargetScript(spec: BrowserElementTarget, timeoutMs: number, body: string): TargetScript {
    // `by` defaults to css in-page; report the strategy that WAS used, or a
    // miss says only `{"value":"Learn more"}` and the caller cannot tell that a
    // plain label was queried as a CSS selector.
    const resolvedSpec = { ...spec, by: spec.by ?? 'css' }
    return (sliceMs, last) => `(async () => {
      const spec = ${JSON.stringify(resolvedSpec)}
      const timeoutMs = ${String(timeoutMs)}
      const sliceMs = ${String(sliceMs)}
      const last = ${String(last)}
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
      const deadline = Date.now() + sliceMs
      let el = null
      for (;;) {
        // Only a parse error escapes the poll: see the comment in match() above.
        try { el = match() } catch (error) { return { ok: false, error: String((error && error.message) || error) } }
        if (el !== null) break
        if (Date.now() >= deadline && !last) return { pending: true }
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
    })()`
  }

  /**
   * Shared evaluate wrapper for the target-based tools. Runs the in-page
   * script and returns its result object; throws a typed BrowserError on
   * evaluation failure or an in-page `{ ok: false, error }` verdict.
   */
  private async runTargetScript(
    tab: Tab,
    script: TargetScript,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    errorCode: string,
    errorLabel: string,
  ): Promise<Record<string, unknown>> {
    // Each slice polls in-page and answers only afterwards, so its outer budget must outlast it or
    // the generic timeout hides the in-page reason (selector not found / malformed).
    const deadline = Date.now() + timeoutMs
    let value: { ok?: boolean; pending?: boolean; error?: string } | undefined
    do {
      const { sliceMs, last } = pagePollSlice(deadline)
      const result = await withTimeout(
        handleSendEvaluate(tab.handle, script(sliceMs, last)),
        sliceMs + TARGET_SCRIPT_GRACE_MS,
        signal,
        `${errorLabel} timed out after ${timeoutMs}ms`,
        timedOut => { this.interrupt(tab.handle, timedOut) },
      )
      if (!result.ok) throw new BrowserError(`${errorLabel} failed: ${result.exception}`, errorCode)
      value = result.value as typeof value
    } while (value?.pending === true)
    if (value?.ok !== true) throw new BrowserError(`${errorLabel} failed: ${value?.error ?? 'unknown'}`, errorCode)
    return value as Record<string, unknown>
  }

  /** Set one element's value (native setter + input/change, React-friendly). */
  async setValue(session: BrowserSessionId, request: BrowserSetValueRequest, signal?: AbortSignal): Promise<BrowserSetValueResult> {
    const s = this.session(session)
    const tab = this.activeTab(s)
    signal?.throwIfAborted()
    const timeoutMs = request.timeoutMs ?? PROVIDER_TIMEOUTS.interaction
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
    `
    const script = this.buildTargetScript(request.target, timeoutMs, body)
    const out = await this.runTargetScript(tab, script, timeoutMs, signal, 'BROWSER_SET_VALUE_FAILED', 'browser: setValue')
    const cursorPoint = scriptPoint(out)
    if (cursorPoint !== undefined) this.showCursor(tab.handle, cursorPoint.x, cursorPoint.y, 'click')
    this.record(s, 'setValue', { target: request.target, value: String(request.value) }, true, { result: out.method as string })
    return { method: out.method as string, value: out.value as string }
  }

  /** Check or uncheck one checkbox/radio. */
  async check(session: BrowserSessionId, request: BrowserCheckRequest, signal?: AbortSignal): Promise<{ readonly checked: boolean }> {
    const s = this.session(session)
    const tab = this.activeTab(s)
    signal?.throwIfAborted()
    const timeoutMs = request.timeoutMs ?? PROVIDER_TIMEOUTS.interaction
    const want = request.checked ?? true
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
    `
    const script = this.buildTargetScript(request.target, timeoutMs, body)
    const out = await this.runTargetScript(tab, script, timeoutMs, signal, 'BROWSER_CHECK_FAILED', 'browser: check')
    const cursorPoint = scriptPoint(out)
    if (cursorPoint !== undefined) this.showCursor(tab.handle, cursorPoint.x, cursorPoint.y, 'click')
    this.record(s, 'check', { target: request.target, checked: want }, true)
    return { checked: out.checked === true }
  }

  /** Select one option of a <select>, by value, visible text, or index. */
  async selectOption(session: BrowserSessionId, request: BrowserSelectRequest, signal?: AbortSignal): Promise<BrowserSelectResult> {
    const s = this.session(session)
    const tab = this.activeTab(s)
    signal?.throwIfAborted()
    const timeoutMs = request.timeoutMs ?? PROVIDER_TIMEOUTS.interaction
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
    `
    const script = this.buildTargetScript(request.target, timeoutMs, body)
    const out = await this.runTargetScript(tab, script, timeoutMs, signal, 'BROWSER_SELECT_FAILED', 'browser: select')
    const cursorPoint = scriptPoint(out)
    if (cursorPoint !== undefined) this.showCursor(tab.handle, cursorPoint.x, cursorPoint.y, 'click')
    this.record(s, 'select', { target: request.target, optionValue: request.optionValue ?? null, optionText: request.optionText ?? null, optionIndex: request.optionIndex ?? null }, true)
    return { value: out.value as string, text: out.text as string }
  }

  /** Clear one input/textarea/contenteditable (or uncheck a checkbox/radio). */
  async clearField(session: BrowserSessionId, request: BrowserClearRequest, signal?: AbortSignal): Promise<{ readonly cleared: boolean }> {
    const s = this.session(session)
    const tab = this.activeTab(s)
    signal?.throwIfAborted()
    const timeoutMs = request.timeoutMs ?? PROVIDER_TIMEOUTS.interaction
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
    `
    const script = this.buildTargetScript(request.target, timeoutMs, body)
    const out = await this.runTargetScript(tab, script, timeoutMs, signal, 'BROWSER_CLEAR_FAILED', 'browser: clear')
    const cursorPoint = scriptPoint(out)
    if (cursorPoint !== undefined) this.showCursor(tab.handle, cursorPoint.x, cursorPoint.y, 'click')
    this.record(s, 'clear', { target: request.target }, true)
    return { cleared: true }
  }

  /** Read one element's current value (for verification). */
  async getValue(session: BrowserSessionId, request: BrowserGetValueRequest, signal?: AbortSignal): Promise<BrowserGetValueResult> {
    const s = this.session(session)
    const tab = this.activeTab(s)
    signal?.throwIfAborted()
    const timeoutMs = request.timeoutMs ?? PROVIDER_TIMEOUTS.interaction
    const body = `
      const type = (el.type || '').toLowerCase()
      if (type === 'checkbox' || type === 'radio') return { ok: true, value: null, checked: el.checked }
      if (el.tagName === 'SELECT') {
        const o = el.options[el.selectedIndex]
        return { ok: true, value: el.value, selectedText: o ? (o.textContent || '').trim() : null }
      }
      const v = el.value !== undefined ? el.value : el.textContent
      return { ok: true, value: v === undefined || v === null ? null : String(v) }
    `
    const script = this.buildTargetScript(request.target, timeoutMs, body)
    const out = await this.runTargetScript(tab, script, timeoutMs, signal, 'BROWSER_GET_VALUE_FAILED', 'browser: getValue')
    this.record(s, 'getValue', { target: request.target }, true)
    return {
      value: out.value === null || out.value === undefined ? null : String(out.value),
      ...out.checked !== undefined ? { checked: out.checked === true } : {},
      ...out.selectedText !== undefined && out.selectedText !== null ? { selectedText: String(out.selectedText) } : {},
    }
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
  private showCursor(handle: ElectronViewHandle, x: number, y: number, action: CursorAction, label?: string, force = false): void {
    if (this.settingsSource !== undefined && !this.settingsSource().ui.virtualCursor) return
    paintCursor(handle, x, y, action, (target, expression) => handleSendEvaluate(target, expression), label, force)
  }
}
