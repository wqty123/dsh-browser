// The page probe, executed for real in a minimal page.
//
// The probe is a string that runs in someone else's page: console/network/dialog capture, settle
// detection, element lookup and overlay probing. Nothing in the suite touched it before, and the
// failure modes are exactly the ones that stay invisible until a user hits them — a wrapped fetch
// that eats a rejection, a dialog replacement that returns the wrong value, a second install that
// wipes the buffer the first one collected.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'

import { dragScript, PROBE_INSTALL_SCRIPT, PROBE_VERSION, probeCallScript, pageOperationScript } from '../lib/tool-browser/page-probe.js'

/** A page just complete enough for the probe: no real DOM, but the same entry points. */
function makePage(overrides = {}) {
  const dispatched = []
  const element = {
    tagName: 'DIV',
    innerText: 'Agree and continue',
    getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 20 }),
    dispatchEvent: event => { dispatched.push(event.type); return true },
    querySelectorAll: () => [],
    parentElement: null,
  }
  const sandbox = {
    console: { log: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    document: {
      readyState: 'complete',
      documentElement: {},
      body: { innerText: 'hello world' },
      elementFromPoint: () => element,
      querySelector: () => null,
      querySelectorAll: () => [element],
      evaluate: () => ({ singleNodeValue: null }),
    },
    getComputedStyle: () => ({ position: 'static', zIndex: '0' }),
    performance: { timeOrigin: Date.now() },
    location: { href: 'https://fixture.test/' },
    MutationObserver: class { observe() {} },
    PointerEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init || {}) } },
    MouseEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init || {}) } },
    fetch: async () => ({ status: 200 }),
    alert: () => 'native-alert',
    confirm: () => 'native-confirm',
    prompt: () => 'native-prompt',
    ...overrides,
  }
  sandbox.globalThis = sandbox
  sandbox.dispatched = dispatched
  return sandbox
}

/** Install the probe in a fresh page and return the page plus its probe object. */
function install(overrides = {}) {
  const page = makePage(overrides)
  vm.runInNewContext(PROBE_INSTALL_SCRIPT, page, { filename: 'page-probe.js' })
  return { page, probe: page.__dshProbe }
}

test('installing twice keeps the buffers the first install collected', () => {
  const { page, probe } = install()
  assert.equal(probe.version, PROBE_VERSION)
  page.console.log('first')
  const again = vm.runInNewContext(PROBE_INSTALL_SCRIPT, page)
  assert.equal(again, PROBE_VERSION)
  assert.equal(page.__dshProbe, probe, 'the same object, not a fresh one')
  assert.equal(page.__dshProbe.read('console', '', 5).length, 1, 'the line survived the second install')
})

test('console lines are captured with their level, newest last', () => {
  const { page } = install()
  page.console.warn('careful')
  page.console.log('value', 42)
  const rows = page.__dshProbe.read('console', '', 5)
  // Spread: the rows come from the page's realm, and a strict compare checks the prototype too.
  assert.deepEqual([...rows.map(row => `${row.level}:${row.text}`)], ['warn:careful', 'log:value 42'])
})

test('summary and findText normalize whitespace without deleting lowercase s', () => {
  const { page, probe } = install()
  const text = 'This is\t a session\n success'
  page.document.body.innerText = text
  assert.equal(probe.summary().text, 'This is a session success')
  const node = { nodeValue: text, parentElement: null }
  page.document.createTreeWalker = () => {
    let next = node
    return { nextNode: () => { const current = next; next = null; return current } }
  }
  page.document.createRange = () => ({
    setStart() {}, setEnd() {},
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 40, height: 10 }),
  })
  const hits = probe.findText('session', false)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].text, 'This is a session success')
  assert.equal(hits[0].x, 30)
  assert.equal(hits[0].y, 25)
  assert.equal(probe.findText('missing', false).length, 0)
  assert.equal(probe.findText('', false).length, 0)
  page.document.body.innerText = ''
  assert.equal(probe.summary().text, '')
})

test('a probe from before the whitespace fix is disposed and replaced', () => {
  let disposed = 0
  const { probe } = install({ __dshProbe: { version: PROBE_VERSION - 1, dispose() { disposed++ } } })
  assert.equal(disposed, 1)
  assert.equal(probe.version, PROBE_VERSION)
  assert.throws(() => install({ __dshProbe: { version: PROBE_VERSION - 1 } }), /reload this page/)
})

test('a fetch is recorded with its status, and its rejection still propagates', async () => {
  const failing = makePage({ fetch: async () => { throw new Error('offline') } })
  vm.runInNewContext(PROBE_INSTALL_SCRIPT, failing)
  const ok = install()
  const response = await ok.page.fetch('https://api.test/items', { method: 'post' })
  assert.equal(response.status, 200, 'the wrapped fetch returns what the real one returned')
  const row = ok.page.__dshProbe.read('network', 'items', 5).at(-1)
  assert.equal(row.method, 'POST')
  assert.equal(row.status, 200)
  assert.equal(row.kind, 'fetch')

  await assert.rejects(() => failing.fetch('https://api.test/boom'), /offline/, 'the rejection is not swallowed')
  const failed = failing.__dshProbe.read('network', 'boom', 5).at(-1)
  assert.equal(failed.status, 0, 'and the attempt is still recorded, with status 0')
})

test('dialogs are answered by policy, and recorded either way', () => {
  const { page, probe } = install()
  assert.equal(page.confirm('native?'), 'native-confirm')
  assert.equal(probe.dialogPolicy, 'native')
  assert.equal(probe.read('dialogs', '', 5).length, 0)
  assert.equal(probe.setDialogPolicy('dismiss'), 'dismiss')
  assert.equal(page.confirm('delete?'), false)
  assert.equal(page.alert('hi'), undefined)
  assert.equal(page.prompt('name?', 'x'), null)
  assert.equal(probe.read('dialogs', '', 5).length, 3)

  assert.equal(probe.setDialogPolicy('accept'), 'accept')
  assert.equal(page.confirm('sure?'), true)
  assert.equal(page.prompt('name?', 'typed'), 'typed')
  const last = probe.read('dialogs', '', 5).at(-1)
  assert.equal(last.answered, 'accepted')
  assert.equal(probe.setDialogPolicy('native'), 'native')
  assert.equal(page.confirm('restored?'), 'native-confirm')
})

test('an invalid policy is refused rather than applied', () => {
  const { probe } = install()
  assert.equal(probe.setDialogPolicy('maybe'), 'native')
  assert.equal(probe.dialogPolicy, 'native')
})

test('settle reports what it can see, and clears a buffer without touching the others', () => {
  const { page, probe } = install()
  page.console.log('x')
  const settle = probe.settle()
  assert.equal(settle.pending, 0)
  assert.equal(settle.readyState, 'complete')
  assert.ok(Number.isFinite(settle.quietMs))

  probe.clear('console')
  assert.equal(probe.read('console', '', 5).length, 0)
  assert.equal(Array.isArray(probe.read('network', '', 5)), true, 'the other buffers are untouched')
})

test('find resolves text to a centre point, and says what it found', () => {
  const { page } = install()
  const hit = page.__dshProbe.find({ text: 'agree' })
  assert.equal(hit.x, 60)
  assert.equal(hit.y, 30)
  assert.match(hit.described, /div/)
  assert.equal(page.__dshProbe.find({ css: '#missing' }), null, 'a miss is null, not an exception')
})

test('overlayAt reports what covers a point, and the dismiss control when there is one', () => {
  const page = makePage()
  const button = {
    tagName: 'BUTTON',
    innerText: 'Accept all',
    getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 100, top: 200, width: 80, height: 24 }),
  }
  const banner = {
    tagName: 'DIV',
    innerText: 'Cookies',
    getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 180, width: 400, height: 60 }),
    querySelectorAll: () => [button],
    parentElement: null,
  }
  page.document.elementFromPoint = () => banner
  page.getComputedStyle = () => ({ position: 'fixed', zIndex: '9999' })
  vm.runInNewContext(PROBE_INSTALL_SCRIPT, page)
  const cover = page.__dshProbe.overlayAt(120, 210)
  assert.equal(cover.covers, 'div "Cookies"')
  assert.equal(cover.dismiss.label, 'Accept all')
  assert.equal(cover.dismiss.x, 140)
  assert.equal(cover.dismiss.y, 212)
})

test('overlayAt does not take the found target own child, also in a shadow root, for an overlay', () => {
  const element = (tagName, parentElement, extra = {}) => ({ tagName, innerText: 'Login', parentElement, getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 100, top: 200, width: 80, height: 24 }), querySelectorAll: () => [], ...extra })
  const button = element('BUTTON', null)
  const icon = element('I', button)
  const page = makePage()
  page.document.querySelector = () => button
  page.document.querySelectorAll = () => [button]
  page.document.elementFromPoint = () => icon
  page.getComputedStyle = () => ({ position: 'static', zIndex: '0' })
  vm.runInNewContext(PROBE_INSTALL_SCRIPT, page)
  const hit = page.__dshProbe.find({ css: 'button[type=submit]' })
  assert.deepEqual({ ...page.__dshProbe.overlayAt(hit.x, hit.y) }, { covers: null, dismiss: null })

  const host = element('X-FORM', null)
  const inner = element('SPAN', null, { parentNode: null })
  const shadowButton = element('BUTTON', null, { parentNode: { host } })
  inner.parentElement = shadowButton
  host.shadowRoot = { elementFromPoint: () => inner }
  page.document.elementFromPoint = () => host
  page.__dshProbe.lastFound = shadowButton
  assert.equal(page.__dshProbe.overlayAt(140, 212).covers, null, 'a hit inside the shadow tree of the target lands on it')

  const panel = element('SECTION', null)
  const modal = element('DIV', panel, { innerText: 'Dialog' })
  const close = element('BUTTON', modal, { innerText: 'Close' })
  modal.querySelectorAll = () => [close]
  page.document.elementFromPoint = () => close
  page.getComputedStyle = node => (node === modal ? { position: 'fixed', zIndex: '1000' } : { position: 'static', zIndex: '0' })
  page.__dshProbe.lastFound = panel
  assert.equal(page.__dshProbe.overlayAt(140, 212).dismiss.label, 'Close', 'a modal inside the target is still an overlay to dismiss')

  const banner = element('DIV', null)
  page.document.elementFromPoint = () => banner
  page.__dshProbe.lastFound = button
  page.getComputedStyle = () => ({ position: 'fixed', zIndex: '9999' })
  assert.equal(page.__dshProbe.overlayAt(140, 212).covers, 'div "Login"', 'a real overlay is still reported')
})

test('overlayAt descends into same-origin iframes (and nested shadow roots) with offset translation', () => {
  const page = makePage()
  const iframeDoc = {
    defaultView: null,
    documentElement: null,
    querySelector: () => null,
    querySelectorAll: () => [],
    elementFromPoint: () => null,
  }
  const iframe = {
    tagName: 'IFRAME',
    innerText: '',
    clientLeft: 2,
    clientTop: 3,
    ownerDocument: page.document,
    contentDocument: iframeDoc,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 400, height: 300 }),
    querySelectorAll: () => [],
    parentElement: null,
  }
  iframeDoc.defaultView = {
    frameElement: iframe,
    getComputedStyle: node => (node === modal ? { position: 'fixed', zIndex: '500' } : { position: 'static', zIndex: '0' }),
  }

  const button = {
    tagName: 'BUTTON',
    innerText: 'Submit',
    ownerDocument: iframeDoc,
    parentElement: null,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 20, top: 40, width: 80, height: 20 }),
    querySelectorAll: () => [],
  }
  const icon = {
    tagName: 'I',
    innerText: '',
    ownerDocument: iframeDoc,
    parentElement: button,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 30, top: 45, width: 10, height: 10 }),
    querySelectorAll: () => [],
  }
  const modal = {
    tagName: 'DIV',
    innerText: 'Cookie dialog',
    ownerDocument: iframeDoc,
    parentElement: null,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 200 }),
    querySelectorAll: () => [dismissBtn],
  }
  const dismissBtn = {
    tagName: 'BUTTON',
    innerText: 'Accept',
    ownerDocument: iframeDoc,
    parentElement: modal,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 40, top: 60, width: 60, height: 20 }),
    querySelectorAll: () => [],
  }

  const seenCoords = []
  iframeDoc.querySelector = selector => (selector === '#inside' ? button : null)
  iframeDoc.querySelectorAll = () => [button]
  iframeDoc.elementFromPoint = (x, y) => {
    seenCoords.push([x, y])
    return icon
  }
  page.document.querySelector = () => null
  page.document.querySelectorAll = selector => (selector === '*' ? [iframe] : [])
  page.document.elementFromPoint = () => iframe
  page.getComputedStyle = () => ({ position: 'static', zIndex: '0' })

  vm.runInNewContext(PROBE_INSTALL_SCRIPT, page)
  const hit = page.__dshProbe.find({ css: '#inside' })
  // frameOffset = (100+2, 50+3) = (102, 53); button center = (20+40, 40+10) = (60, 50) -> (162, 103)
  assert.equal(hit.x, 162)
  assert.equal(hit.y, 103)
  assert.deepEqual({ ...page.__dshProbe.overlayAt(hit.x, hit.y) }, { covers: null, dismiss: null }, 'child inside same-origin iframe target is not an overlay')
  assert.deepEqual(seenCoords.at(-1), [60, 50], 'iframe elementFromPoint received iframe-local coordinates')

  // Real modal inside the same-origin iframe: must be reported with top-viewport dismiss coordinates.
  iframeDoc.elementFromPoint = () => modal
  const blocked = page.__dshProbe.overlayAt(hit.x, hit.y)
  assert.equal(blocked.covers, 'div "Cookie dialog"')
  assert.equal(blocked.dismiss.label, 'Accept')
  // dismiss center in iframe = (40+30, 60+10) = (70, 70); plus frameOffset (102, 53) = (172, 123)
  assert.equal(blocked.dismiss.x, 172)
  assert.equal(blocked.dismiss.y, 123)

  // Cross-origin iframe whose contentDocument throws SecurityError must degrade cleanly without throwing.
  const crossOriginFrame = {
    tagName: 'IFRAME',
    innerText: '',
    get contentDocument() { throw new Error('SecurityError: blocked cross-origin frame') },
    getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 200 }),
    querySelectorAll: () => [],
    parentElement: null,
  }
  page.document.elementFromPoint = () => crossOriginFrame
  const opaque = page.__dshProbe.overlayAt(100, 100)
  assert.equal(opaque.covers, 'iframe')
  assert.equal(opaque.dismiss, null)
})

test('a call on a page without the probe answers with an error instead of throwing', () => {
  const page = makePage()
  const value = vm.runInNewContext(probeCallScript('read', ['console', '', 5]), page)
  assert.equal(JSON.parse(value).error, 'probe-not-installed')
})

test('the drag gesture fires pointer and mouse events in order', () => {
  const page = makePage()
  const value = vm.runInNewContext(dragScript({ x: 10, y: 10 }, { x: 50, y: 50 }, 4), page)
  const parsed = JSON.parse(value)
  assert.equal(parsed.ok, true)
  const types = page.dispatched
  assert.equal(types[0], 'pointerdown')
  assert.ok(types.includes('pointermove') && types.includes('mousemove'))
  assert.equal(types.at(-1), 'mouseup')
})

test('an observation install leaves dialog function identities unchanged', () => {
  const page = makePage()
  const confirm = page.confirm
  const alert = page.alert
  const prompt = page.prompt
  vm.runInNewContext(PROBE_INSTALL_SCRIPT, page)
  page.__dshProbe.summary()
  assert.equal(page.confirm, confirm)
  assert.equal(page.alert, alert)
  assert.equal(page.prompt, prompt)
})

test('network cursors count completions and ignore previously completed responses', async () => {
  let complete
  const { page, probe } = install({ fetch: () => new Promise(resolve => { complete = resolve }) })
  const pending = page.fetch('/before-wait')
  const cursor = probe.networkCursor()
  complete({ status: 200 })
  await pending
  const row = probe.read('network', '', 5)[0]
  assert.ok(row.sequence > cursor.sequence, 'an in-flight response completed after the cursor')
  const second = probe.networkCursor()
  assert.equal(row.sequence > second.sequence, false, 'the old response cannot satisfy another wait')
  probe.clear('network')
  assert.equal(probe.networkCursor().sequence, second.sequence)
})

test('fixed operations reject JavaScript methods and serialize text as data', () => {
  assert.throws(() => pageOperationScript({ operation: 'probe', method: 'constructor', args: ['return 1'] }), /unsupported/)
  assert.throws(() => pageOperationScript({ operation: 'script', script: 'return 1' }), /unsupported/)
  const page = makePage()
  assert.equal(vm.runInNewContext(pageOperationScript({ operation: 'text', text: '"); globalThis.injected = true; (' }), page), 'false')
  assert.equal(page.injected, undefined)
})
