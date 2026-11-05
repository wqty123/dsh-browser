/**
 * The page-side probe: one script that makes a page observable without touching the host.
 *
 * WHY THIS EXISTS
 * Three capabilities the model needs are not tools here yet: what the console said, which network
 * responses arrived, and what happened to a JavaScript dialog. All three live *inside* the page, and
 * a dialog blocks the page until someone answers it — which is why a `confirm()` used to hang a whole
 * tool call with no explanation.
 *
 * The obvious implementation is CDP event capture (`Runtime.consoleAPICalled`, `Network.*`,
 * `Page.javascriptDialogOpening`) inside the host. That would mean a new capability in all three
 * carriers — the self-hosted child, the driven Chrome and the sidebar bridge — plus a protocol
 * version for the bridge. This probe instead installs itself with the `execute` path every carrier
 * already has, so it works everywhere on day one and cannot drift per carrier.
 *
 * What it costs, stated plainly:
 * - `console` and `network` see what the PAGE can see. A response that never reached `fetch`/`XHR`
 *   (a document navigation, an `<img>` failure the browser handled internally) appears only as a
 *   resource-timing entry, with no status code. CDP would know more.
 * - Dialog capture works by replacing `window.alert/confirm/prompt` BEFORE they are called. A dialog
 *   produced by the browser itself (`beforeunload`, HTTP auth, permission prompts) is not covered.
 * - It is an override, so a page that captured `window.fetch` earlier keeps its own copy. Installed
 *   at first use, which is early enough for every ordinary page and honest about the rest.
 *
 * Idempotent by version: installing twice keeps the buffers that already exist.
 * @module dsh-browser/tool-browser/page-probe
 */
/** Bumped when the probe's shape changes; an older probe is replaced rather than trusted. */
export const PROBE_VERSION = 4;
/** Where the probe keeps itself, and the only global it adds. */
const PROBE_KEY = '__dshProbe';
/**
 * The installer, as one expression that returns the installed version.
 *
 * Written as a string because it runs in the page, not here. Keep it dependency-free and ES5-safe:
 * a page may be older than the harness.
 */
export const PROBE_INSTALL_SCRIPT = `(() => {
  const KEY = ${JSON.stringify(PROBE_KEY)}
  const VERSION = ${PROBE_VERSION}
  const previous = globalThis[KEY]
  if (previous && previous.version === VERSION) return VERSION
  if (previous) {
    if (typeof previous.dispose !== 'function') throw new Error('reload this page to replace the older browser probe')
    previous.dispose()
  }
  const restore = []
  const replace = (target, key, value) => {
    const original = target[key]
    target[key] = value
    restore.push(() => { if (target[key] === value) target[key] = original })
  }

  const state = {
    version: VERSION,
    startedAt: Date.now(),
    console: [],
    network: [],
    dialogs: [],
    dialogPolicy: 'native',
    networkSequence: 0,
    pending: 0,
    lastNetworkAt: Date.now(),
    lastMutationAt: Date.now(),
  }
  const cap = (list, item, limit) => { list.push(item); if (list.length > limit) list.splice(0, list.length - limit) }
  const asText = (value) => {
    try { return typeof value === 'string' ? value : JSON.stringify(value) } catch (error) { return String(value) }
  }
  const short = (value, limit) => { const text = String(value == null ? '' : value); return text.length > limit ? text.slice(0, limit) + '…' : text }

  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level]
    if (typeof original !== 'function') continue
    replace(console, level, function () {
      const parts = []
      for (let i = 0; i < arguments.length; i += 1) parts.push(asText(arguments[i]))
      cap(state.console, { at: Date.now(), level: level, text: short(parts.join(' '), 500) }, 200)
      return original.apply(this, arguments)
    })
  }

  const note = (entry) => { state.lastNetworkAt = Date.now(); entry.receivedAt = state.lastNetworkAt; entry.sequence = ++state.networkSequence; cap(state.network, entry, 300) }
  const nativeFetch = globalThis.fetch
  if (typeof nativeFetch === 'function') {
    replace(globalThis, 'fetch', function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input)
      const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase()
      const started = Date.now()
      state.pending += 1
      const settle = (status) => {
        state.pending = Math.max(0, state.pending - 1)
        note({ at: started, kind: 'fetch', method: method, url: short(url, 300), status: status, ms: Date.now() - started })
      }
      return nativeFetch.apply(this, arguments).then(
        (response) => { settle(response.status); return response },
        (error) => { settle(0); throw error },
      )
    })
  }

  const XHR = globalThis.XMLHttpRequest
  if (XHR && XHR.prototype && typeof XHR.prototype.send === 'function') {
    const open = XHR.prototype.open
    const send = XHR.prototype.send
    replace(XHR.prototype, 'open', function (method, url) {
      this.__dshNetwork = { method: String(method || 'GET').toUpperCase(), url: String(url || ''), at: Date.now() }
      return open.apply(this, arguments)
    })
    replace(XHR.prototype, 'send', function () {
      const meta = this.__dshNetwork || { method: 'GET', url: '', at: Date.now() }
      state.pending += 1
      const done = () => {
        state.pending = Math.max(0, state.pending - 1)
        note({ at: meta.at, kind: 'xhr', method: meta.method, url: short(meta.url, 300), status: this.status || 0, ms: Date.now() - meta.at })
        this.removeEventListener('loadend', done)
      }
      this.addEventListener('loadend', done)
      return send.apply(this, arguments)
    })
  }

  if (typeof PerformanceObserver === 'function') {
    try {
      const seen = new Set()
      const observer = new PerformanceObserver((list) => {
        const entries = list.getEntries()
        for (let i = 0; i < entries.length; i += 1) {
          const entry = entries[i]
          const key = entry.name + '|' + entry.startTime
          if (seen.has(key)) continue
          seen.add(key)
          note({ at: Math.round((performance.timeOrigin || Date.now()) + entry.startTime), kind: 'resource', method: 'GET', url: short(entry.name, 300), status: 0, ms: Math.round(entry.duration), bytes: entry.transferSize || 0 })
        }
      })
      observer.observe({ type: 'resource', buffered: true })
      restore.push(() => observer.disconnect())
    } catch (error) { /* a page with no resource timing still has fetch and XHR */ }
  }

  const nativeDialogs = {}
  const dialogWrappers = {}
  for (const kind of ['alert', 'confirm', 'prompt']) {
    const original = globalThis[kind]
    if (typeof original !== 'function') continue
    nativeDialogs[kind] = original
    const wrapper = function (message, value) {
      const accept = state.dialogPolicy === 'accept'
      cap(state.dialogs, { at: Date.now(), kind: kind, message: short(message, 300), policy: state.dialogPolicy, answered: accept ? 'accepted' : 'dismissed' }, 50)
      if (!accept) return kind === 'confirm' ? false : kind === 'prompt' ? null : undefined
      return kind === 'prompt' ? String(value == null ? '' : value) : kind === 'confirm' ? true : undefined
    }
    dialogWrappers[kind] = wrapper
    restore.push(() => { if (globalThis[kind] === wrapper) globalThis[kind] = nativeDialogs[kind] })
  }

  try {
    const observer = new MutationObserver(() => { state.lastMutationAt = Date.now() })
    observer.observe(document.documentElement || document, { subtree: true, childList: true, attributes: true })
    restore.push(() => observer.disconnect())
  } catch (error) { /* no observer: quiet time falls back to network only */ }

  const describe = (node) => {
    if (!node || !node.tagName) return 'unknown'
    const name = (node.getAttribute && (node.getAttribute('aria-label') || node.getAttribute('name'))) || ''
    const text = short((node.innerText || '').trim().replace(/\\s+/g, ' '), 60)
    return node.tagName.toLowerCase() + (name ? '[' + name + ']' : '') + (text ? ' "' + text + '"' : '')
  }

  state.settle = function () {
    const quietFrom = Math.max(state.lastNetworkAt, state.lastMutationAt)
    return { pending: state.pending, quietMs: Date.now() - quietFrom, readyState: String(document.readyState) }
  }

  state.find = function (target, scroll) {
    if (!target) return null
    let node = null
    try {
      if (target.css) node = document.querySelector(String(target.css))
      else if (target.xpath) node = document.evaluate(String(target.xpath), document, null, 9, null).singleNodeValue
      else if (target.text) {
        const wanted = String(target.text).trim().toLowerCase()
        const nodes = document.querySelectorAll('button, a, [role=button], input, label, [role=tab], [role=option], [role=link]')
        for (let i = 0; i < nodes.length; i += 1) {
          const value = ((nodes[i].innerText || nodes[i].getAttribute('aria-label') || nodes[i].value || '') + '').trim().toLowerCase()
          if (value && value.indexOf(wanted) !== -1) { node = nodes[i]; break }
        }
      }
    } catch (error) { return null }
    if (!node) return null
    if (scroll === true && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    const rect = node.getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), w: Math.round(rect.width), h: Math.round(rect.height), described: describe(node) }
  }

  const DISMISS = /(accept|agree|allow|continue|close|got it|dismiss|ok|agree|同意|接受|允许|继续|关闭|知道了|我知道了|我同意)/i

  state.overlayAt = function (x, y) {
    const top = document.elementFromPoint(Number(x), Number(y))
    if (!top) return { covers: null, dismiss: null }
    let node = top
    let depth = 0
    while (node && depth < 8) {
      let style = null
      try { style = getComputedStyle(node) } catch (error) { style = null }
      const floating = style && (style.position === 'fixed' || style.position === 'sticky' || Number(style.zIndex) >= 100)
      if (floating) {
        const buttons = node.querySelectorAll('button, [role=button], a')
        for (let i = 0; i < buttons.length && i < 60; i += 1) {
          const label = ((buttons[i].innerText || '') + ' ' + (buttons[i].getAttribute('aria-label') || '')).trim()
          if (DISMISS.test(label)) {
            const rect = buttons[i].getBoundingClientRect()
            return { covers: describe(top), dismiss: { label: short(label, 40), x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } }
          }
        }
        return { covers: describe(top), dismiss: null }
      }
      node = node.parentElement
      depth += 1
    }
    return { covers: describe(top), dismiss: null }
  }

  state.read = function (kind, filter, limit) {
    const list = kind === 'console' ? state.console : kind === 'network' ? state.network : state.dialogs
    const needle = filter ? String(filter).toLowerCase() : ''
    const rows = needle === '' ? list : list.filter((row) => ((row.url || '') + ' ' + (row.text || '') + ' ' + (row.message || '')).toLowerCase().indexOf(needle) !== -1)
    const max = Math.max(0, Math.min(Number(limit) || 20, 100))
    return rows.slice(Math.max(0, rows.length - max))
  }

  state.clear = function (kind) {
    if (kind === 'console') state.console.length = 0
    else if (kind === 'network') state.network.length = 0
    else if (kind === 'dialogs') state.dialogs.length = 0
    return true
  }

  state.setDialogPolicy = function (policy) {
    if (policy !== 'native' && policy !== 'accept' && policy !== 'dismiss') return state.dialogPolicy
    const previousPolicy = state.dialogPolicy
    state.dialogPolicy = policy
    for (const kind of Object.keys(nativeDialogs)) {
      if (policy === 'native') {
        if (globalThis[kind] === dialogWrappers[kind]) globalThis[kind] = nativeDialogs[kind]
      } else {
        if (previousPolicy === 'native' && globalThis[kind] !== dialogWrappers[kind]) nativeDialogs[kind] = globalThis[kind]
        globalThis[kind] = dialogWrappers[kind]
      }
    }
    return state.dialogPolicy
  }

  state.dialogStatus = function () { return state.dialogPolicy }
  state.networkCursor = function () { return { startedAt: state.startedAt, sequence: state.networkSequence } }
  state.dispose = function () {
    for (const undo of restore.reverse()) { try { undo() } catch (error) {} }
    if (globalThis[KEY] === state) delete globalThis[KEY]
  }

  state.findText = function (text, all) {
    const needle = String(text || '')
    const out = []
    if (needle === '') return out
    const wanted = needle.toLowerCase()
    const root = document.body || document.documentElement
    if (!root || typeof document.createTreeWalker !== 'function') return out
    const walker = document.createTreeWalker(root, 4, null) // 4 = SHOW_TEXT
    let node = walker.nextNode()
    while (node) {
      const value = node.nodeValue || ''
      let at = value.toLowerCase().indexOf(wanted)
      while (at !== -1) {
        const range = document.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + needle.length)
        const rect = range.getBoundingClientRect()
        out.push({
          text: short(value.slice(Math.max(0, at - 20), at + needle.length + 20).replace(/\s+/g, ' ').trim(), 80),
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          host: node.parentElement ? describe(node.parentElement) : 'text',
        })
        if (out.length >= (all ? 50 : 5)) return out
        at = value.toLowerCase().indexOf(wanted, at + 1)
      }
      node = walker.nextNode()
    }
    return out
  }

  const hoverEvent = (type, node, x, y) => {
    const init = { bubbles: type.indexOf('enter') === -1, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: 0 }
    try {
      if (type.indexOf('pointer') === 0 && typeof PointerEvent === 'function') return new PointerEvent(type, Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, init))
      if (typeof MouseEvent === 'function') return new MouseEvent(type.replace('pointer', 'mouse'), init)
    } catch (error) { return null }
    return null
  }

  state.hoverAt = function (x, y) {
    const node = document.elementFromPoint(Number(x), Number(y))
    if (!node) return false
    const types = ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove']
    let fired = 0
    for (let i = 0; i < types.length; i += 1) {
      const event = hoverEvent(types[i], node, Number(x), Number(y))
      if (event && typeof node.dispatchEvent === 'function') { node.dispatchEvent(event); fired += 1 }
    }
    return fired > 0
  }

  state.summary = function () {
    const body = document.body ? document.body.innerText : ''
    const query = (selector) => { try { return document.querySelectorAll(selector).length } catch (error) { return 0 } }
    const settled = state.settle()
    return {
      url: String(location.href),
      title: String(document.title || ''),
      readyState: settled.readyState,
      pending: settled.pending,
      quietMs: settled.quietMs,
      inputs: query('input, textarea, select'),
      buttons: query('button, [role=button]'),
      links: query('a[href]'),
      scrollX: Math.round(globalThis.scrollX || 0),
      scrollY: Math.round(globalThis.scrollY || 0),
      selection: short(globalThis.getSelection ? String(globalThis.getSelection()) : '', 120),
      text: short(String(body || '').replace(/\s+/g, ' ').trim(), 400),
    }
  }
  globalThis[KEY] = state
  return VERSION
})()`;
/**
 * One probe call, evaluated in the page, with its result serialised as JSON.
 *
 * JSON in, JSON out, because that is the only shape every carrier's `execute` can carry reliably.
 * @param method - the probe function to call (`read`, `settle`, `find`, `overlayAt`, `clear`, …).
 * @param args - arguments, already JSON-serialisable.
 * @returns a script whose value is the JSON text of the result (or an error object).
 */
export function probeCallScript(method, args = []) {
    return `(() => {
    const probe = globalThis[${JSON.stringify(PROBE_KEY)}]
    if (!probe) return JSON.stringify({ error: 'probe-not-installed' })
    if (typeof probe[${JSON.stringify(method)}] !== 'function') return JSON.stringify({ error: 'probe-method-missing' })
    try { return JSON.stringify(probe[${JSON.stringify(method)}].apply(probe, ${JSON.stringify(args)})) } catch (error) { return JSON.stringify({ error: String(error) }) }
  })()`;
}
/**
 * Dispatch a pointer drag in the page, for elements that accept synthetic pointer events.
 *
 * Uses `PointerEvent` when the page has it and `MouseEvent` otherwise, because a canvas app that
 * listens for `mousedown` never sees a pointer event. This is a page-level gesture: a page that
 * demands trusted input (some canvas editors) ignores it, exactly like `click_sequence`'s
 * coordinate clicks are the trusted counterpart.
 * @param from - start point in viewport CSS pixels.
 * @param to - end point.
 * @param steps - intermediate moves; more steps make a slider or a canvas app follow the path.
 * @returns a script value: `{ ok: true, moved, at }` or `{ ok: false, reason }`.
 */
export function dragScript(from, to, steps = 12) {
    const points = JSON.stringify({ from, to, steps });
    return `(() => {
    const spec = ${points}
    const at = (x, y) => document.elementFromPoint(x, y)
    const start = at(spec.from.x, spec.from.y)
    if (!start) return JSON.stringify({ ok: false, reason: 'nothing at the start point' })
    const make = (type, x, y, extra) => {
      const init = Object.assign({ bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' || type === 'mouseup' ? 0 : 1 }, extra || {})
      try {
        if (type.indexOf('pointer') === 0 && typeof PointerEvent === 'function') return new PointerEvent(type, Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, init))
        if (typeof MouseEvent === 'function') return new MouseEvent(type.replace('pointer', 'mouse'), init)
      } catch (error) { /* fall through to the null below */ }
      return null
    }
    const fire = (node, type, x, y, extra) => {
      const event = make(type, x, y, extra)
      if (event !== null && node && typeof node.dispatchEvent === 'function') { node.dispatchEvent(event); return true }
      return false
    }
    if (!fire(start, 'pointerdown', spec.from.x, spec.from.y)) {
      return JSON.stringify({ ok: false, reason: 'this page exposes no event constructors to dispatch a drag' })
    }
    fire(start, 'mousedown', spec.from.x, spec.from.y)
    const total = Math.max(1, Math.min(Number(spec.steps) || 12, 60))
    for (let i = 1; i <= total; i += 1) {
      const x = Math.round(spec.from.x + (spec.to.x - spec.from.x) * (i / total))
      const y = Math.round(spec.from.y + (spec.to.y - spec.from.y) * (i / total))
      const node = at(x, y) || start
      fire(node, 'pointermove', x, y)
      fire(node, 'mousemove', x, y)
    }
    const end = at(spec.to.x, spec.to.y) || start
    fire(end, 'pointerup', spec.to.x, spec.to.y)
    fire(end, 'mouseup', spec.to.x, spec.to.y)
    return JSON.stringify({ ok: true, moved: total, at: spec.to })
  })()`;
}
/**
 * Put a local file into an `<input type=file>`, without CDP.
 *
 * The page cannot read a disk path, so the bytes travel in as base64 and are rebuilt as a `File`
 * in page context, then attached through a `DataTransfer`. That is what a drag-and-drop handler
 * sees, so frameworks that read `input.files` or a drop event both work. The admission decision
 * (which path may be read at all) belongs to the caller; this only carries the bytes.
 * @param target - how to find the input: a CSS selector or visible text near it.
 * @param file - name, MIME type and base64 of the bytes.
 * @returns a script value: `{ ok: true, name, size }` or `{ ok: false, reason }`.
 */
export function uploadScript(target, file) {
    const spec = JSON.stringify({ target, file });
    return `(() => {
    const spec = ${spec}
    const probe = globalThis[${JSON.stringify(PROBE_KEY)}]
    const where = probe ? probe.find(spec.target) : null
    let node = null
    try {
      if (spec.target.by === 'css') node = document.querySelector(spec.target.value)
      else if (spec.target.by === 'xpath') node = document.evaluate(spec.target.value, document, null, 9, null).singleNodeValue
      else if (where) node = document.elementFromPoint(where.x, where.y)
    } catch (error) { node = null }
    if (node && node.tagName !== 'INPUT' && node.querySelector) {
      const nested = node.querySelector('input[type=file]')
      if (nested) node = nested
    }
    if (!node || node.tagName !== 'INPUT' || String(node.type).toLowerCase() !== 'file') {
      return JSON.stringify({ ok: false, reason: 'no file input at that target (' + (where ? where.described : 'nothing matched') + ')' })
    }
    const binary = atob(spec.file.base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    const blob = new File([bytes], spec.file.name, { type: spec.file.mime || 'application/octet-stream' })
    const transfer = new DataTransfer()
    transfer.items.add(blob)
    node.files = transfer.files
    node.dispatchEvent(new Event('input', { bubbles: true }))
    node.dispatchEvent(new Event('change', { bubbles: true }))
    return JSON.stringify({ ok: true, name: blob.name, size: blob.size, files: node.files ? node.files.length : 0 })
  })()`;
}
/** Build a fixed page operation, rejecting unknown operations before any code runs. */
export function pageOperationScript(request) {
    switch (request.operation) {
        case 'install': return PROBE_INSTALL_SCRIPT;
        case 'url': return 'JSON.stringify(location.href)';
        case 'text': return 'JSON.stringify((document.body ? document.body.innerText : "").indexOf(' + JSON.stringify(request.text) + ') !== -1)';
        case 'drag': return dragScript(request.from, request.to, request.steps);
        case 'upload': return uploadScript(request.target, request.file);
        case 'probe': {
            const methods = ['read', 'clear', 'settle', 'find', 'overlayAt', 'summary',
                'findText', 'hoverAt', 'setDialogPolicy', 'dialogStatus', 'networkCursor'];
            if (!methods.includes(request.method))
                throw new Error('browser: unsupported fixed page operation');
            return probeCallScript(request.method, request.args);
        }
        default: throw new Error('browser: unsupported fixed page operation');
    }
}
