/**
 * Human page entries and frame identity (B02/B40/B46/B48/B32).
 * The page is a small fake DOM: these tests check the adapter's rules — one
 * owner, a low-trust intent, host-owned frame identity — not a real Electron.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import {
  frameCaptureScript,
  overlayDisposeScript,
  overlayScript,
  MAX_REFERENCE_COMMENT,
  referenceMenuTemplate,
  standaloneScript,
  validateFrameCapture,
  validateFrameSelector,
  REFERENCE_INTENT_CHANNEL,
  OVERLAY_IDS,
} from '../lib/browser-reference/entry.js'
import { BrowserReferenceService } from '../lib/browser-reference/service.js'
import { ReferenceStore } from '../lib/browser-reference/store.js'
import { OVERLAY_HOST_ID, MASK_HOST_ID } from '../lib/browser-reference/visible.js'

// --------------------------------------------------------------- menu / policy

test('one menu owner keeps the ordinary edit items and adds a single reference row', () => {
  const menu = referenceMenuTemplate()
  assert.equal(menu.filter(item => item.kind === 'reference').length, 1)
  assert.equal(menu[0].kind, 'reference')
  assert.deepEqual(menu.filter(item => item.kind === 'role').map(item => item.role),
    ['copy', 'cut', 'paste', 'selectAll'])
  assert.equal(new Set(menu.map(item => item.id)).size, menu.length)
  assert.equal(menu.filter(item => item.kind === 'separator').length, 1)
})

test('frameSelector accepts a plain selector and refuses injection syntax', () => {
  assert.equal(validateFrameSelector('#editor iframe'), '#editor iframe')
  assert.equal(validateFrameSelector('  iframe[name="main"]  '), 'iframe[name="main"]')
  for (const bad of ['', '   ', 'a{}', 'a < b', 'a; alert(1)', 'a`x`', 'a${x}', 'a\\b', 'a/*x*/', 'x'.repeat(201), 42, null]) {
    assert.equal(validateFrameSelector(bad), undefined, `refused: ${String(bad)}`)
  }
})

test('standaloneScript removes the arguments[0] dependency for executeJavaScript', () => {
  const source = standaloneScript(overlayScript(), { label: '引用到 DSH' })
  assert.equal(source.includes('arguments[0]'), false)
  assert.ok(source.includes('"label":"引用到 DSH"'))
  assert.doesNotThrow(() => new vm.Script(source))
  assert.doesNotThrow(() => new vm.Script(standaloneScript(overlayDisposeScript())))
  assert.equal(OVERLAY_IDS[0], OVERLAY_HOST_ID)
  assert.notEqual(MASK_HOST_ID, OVERLAY_HOST_ID)
})

// ------------------------------------------------------------------- fake DOM

function fakePage({ withPreload = true, selection = 'chosen words', dark = false } = {}) {
  const listeners = new Map()
  const nodes = new Map()
  const intents = []
  const messages = []
  const target = {
    addEventListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push({ target: this, fn })
    },
    removeEventListener(name, fn) {
      listeners.set(name, (listeners.get(name) ?? []).filter(row => row.fn !== fn))
    },
  }
  const makeNode = () => ({
    ...target,
    id: '', tagName: '', textContent: '', parentNode: null, children: [],
    style: { cssText: '', display: '', left: '', top: '' },
    attrs: {},
    addEventListener: target.addEventListener,
    removeEventListener: target.removeEventListener,
    getAttribute(key) { return this.attrs[key] ?? null },
    setAttribute(key, value) { this.attrs[key] = String(value) },
    appendChild(child) { this.children.push(child); child.parentNode = this; return child },
    contains(node) {
      let cursor = node
      while (cursor) { if (cursor === this) return true; cursor = cursor.parentNode }
      return false
    },
    removeChild(child) { this.children = this.children.filter(node => node !== child); child.parentNode = null },
  })
  const body = makeNode()
  const document = {
    body,
    documentElement: body,
    createElement: () => makeNode(),
    addEventListener: target.addEventListener,
    removeEventListener: target.removeEventListener,
    querySelector: () => undefined,
    getElementById(id) {
      const walk = node => {
        for (const child of node.children ?? []) {
          if (child.id === id) return child
          const found = walk(child)
          if (found !== undefined) return found
        }
        return undefined
      }
      return walk(body)
    },
  }
  const range = {
    cloneRange() { return this },
    // A real DOMRect carries width/height; a double without them looked like a
    // detached range and the bar correctly refused to position itself from it.
    getBoundingClientRect() { return { left: 20, top: 30, right: 120, bottom: 50, width: 100, height: 20 } },
  }
  const window = {
    innerWidth: 1024,
    innerHeight: 768,
    getSelection: () => selection === '' ? null : {
      rangeCount: 1, isCollapsed: false, getRangeAt: () => range, toString: () => selection,
    },
    postMessage: payload => messages.push(payload),
    ...withPreload ? { __dshRef: { intent: payload => intents.push(payload) } } : {},
  }
  const context = vm.createContext({
    window, document, spec: { label: '引用到 DSH', frameSelector: '#frame', context: 32 },
    // The bar measures the page instead of trusting system colours.
    getComputedStyle: () => ({
      backgroundColor: dark ? 'rgb(20, 20, 20)' : 'rgb(255, 255, 255)',
      color: dark ? 'rgb(237, 237, 237)' : 'rgb(20, 20, 20)',
    }),
    JSON, Math, Number, String, Array, Object, Error, setTimeout: fn => fn(),
    location: { href: 'https://example.com/page' },
  })
  return {
    context, document, window, body, intents, messages, listeners, nodes,
    run(script) { return vm.runInContext(standaloneScript(script, context.spec), context) },
    fire(name, event = {}) {
      for (const row of [...(listeners.get(name) ?? [])]) row.fn({ preventDefault() {}, stopPropagation() {}, target: null, ...event })
    },
  }
}

test('the bar is only as wide as its comment and grows with it', () => {
  const page = fakePage()
  page.run(overlayScript())
  const host = page.body.children.find(node => node.id === OVERLAY_HOST_ID)
  const input = inputOf(host)
  assert.match(host.style.cssText, /width:auto/)
  assert.equal(/width:350px/.test(host.style.cssText), false, 'no fixed 350px bar')
  // The field follows its own text until the cap, then wraps onto more lines.
  assert.match(input.style.cssText, /field-sizing:content/)
  assert.match(input.style.cssText, /min-width:96px/)
  assert.match(input.style.cssText, /max-width:236px/)
})

test('the bar reads the page it quotes: dark page, light text and a light confirm', () => {
  const page = fakePage({ dark: true })
  page.run(overlayScript())
  const host = page.body.children.find(node => node.id === OVERLAY_HOST_ID)
  const input = inputOf(host)
  const confirm = confirmOf(host)
  page.fire('selectionchange')
  assert.equal(host.style.background, '#1c1c1e', 'a dark article gets a dark bar')
  assert.equal(input.style.color, '#f5f5f7', 'the comment must be readable on it')
  assert.equal(confirm.style.background, '#f5f5f7', 'the confirm disc turns light')
  assert.equal(confirm.style.color, '#1c1c1e', 'so the check inside stays visible')
})

test('a light page keeps dark ink and a dark confirm disc', () => {
  const page = fakePage()
  page.run(overlayScript())
  const host = page.body.children.find(node => node.id === OVERLAY_HOST_ID)
  page.fire('selectionchange')
  assert.equal(host.style.background, '#ffffff')
  assert.equal(inputOf(host).style.color, '#1a1a1a')
  assert.equal(confirmOf(host).style.background, '#1a1a1a')
  assert.equal(confirmOf(host).style.color, '#ffffff')
})

// ---------------------------------------------------------------- overlay paths

/** The bar nests its controls in a preview/footer row; ids stay global. */
function findDeep(node, predicate) {
  for (const child of node.children ?? []) {
    if (predicate(child)) return child
    const found = findDeep(child, predicate)
    if (found !== undefined) return found
  }
  return undefined
}

const inputOf = host => findDeep(host, node => node.attrs.placeholder !== undefined)
const confirmOf = host => findDeep(host, node => node.id === `${OVERLAY_HOST_ID}-add`)

test('B40/B54: exactly one overlay per document, installed idempotently', () => {
  const page = fakePage()
  const first = JSON.parse(page.run(overlayScript()))
  const second = JSON.parse(page.run(overlayScript()))
  assert.equal(first.ok, true)
  assert.equal(first.installed, true)
  assert.equal(first.channel, 'preload')
  assert.equal(second.already, true, 'a second adapter must not add a second entry')
  assert.equal(page.body.children.filter(node => node.id === OVERLAY_HOST_ID).length, 1)
})

test('B48: a click sends a low-trust intent and never claims extra capabilities', () => {
  const page = fakePage()
  page.run(overlayScript())
  const host = page.body.children.find(node => node.id === OVERLAY_HOST_ID)
  page.fire('mousedown', { target: host })
  page.fire('selectionchange')
  assert.equal(host.style.display, 'block', 'the entry appears only with a live selection')
  const confirm = confirmOf(host)
  assert.ok(confirm, 'the bar carries an explicit confirm action')
  page.fire('click', { target: confirm, isTrusted: true })
  assert.equal(page.intents.length, 1)
  const intent = page.intents[0]
  assert.equal(intent.type, REFERENCE_INTENT_CHANNEL)
  assert.equal(intent.entry, 'page-overlay')
  assert.equal(intent.hasSelection, true)
  assert.equal(intent.capabilities.length, 0, 'isTrusted does not grant activeTab or screenshot')
  assert.equal(intent.comment, '', 'an empty comment still quotes the original content')
  assert.equal(host.style.display, 'none', 'the bar hides after use')
})

test('three-state §3: the comment travelled with the frozen selection, bounded', () => {
  const page = fakePage()
  page.run(overlayScript())
  const host = page.body.children.find(node => node.id === OVERLAY_HOST_ID)
  const input = inputOf(host)
  const confirm = confirmOf(host)
  assert.ok(input && confirm)
  page.fire('selectionchange')
  input.value = '  这段要在回答里对比  '
  page.fire('click', { target: confirm, isTrusted: true })
  assert.equal(page.intents.length, 1)
  assert.equal(page.intents[0].comment, '这段要在回答里对比', 'trimmed, never rewritten')

  // An over-long paste is cut at the same bound the service enforces. The page
  // is selected again first: after a submit the bar stays dismissed for the
  // quote it already carried, and a bar with nothing frozen refuses to submit.
  page.fire('mousedown', { target: page.body })
  page.fire('selectionchange')
  input.value = 'x'.repeat(5000)
  page.fire('click', { target: confirm })
  assert.equal(page.intents[1].comment.length, MAX_REFERENCE_COMMENT)
})

test('a confirm with nothing frozen explains itself instead of quoting emptiness', () => {
  const page = fakePage({ selection: '' })
  page.run(overlayScript())
  const host = page.body.children.find(node => node.id === OVERLAY_HOST_ID)
  const confirm = confirmOf(host)
  assert.ok(confirm)
  // Programmatic click on a bar that never saw a selection.
  page.fire('click', { target: confirm })
  assert.equal(page.intents.length, 0, 'no empty reference is ever submitted')
  const status = findDeep(host, node => node.attrs.role === 'status')
  assert.match(status.textContent, /选中/)
})

test('three-state §3: an IME composition Enter never confirms; Ctrl+Enter does', () => {
  const page = fakePage()
  page.run(overlayScript())
  const host = page.body.children.find(node => node.id === OVERLAY_HOST_ID)
  const input = inputOf(host)
  page.fire('selectionchange')
  input.value = '正在组词'
  page.fire('keydown', { key: 'Enter', isComposing: true, target: input })
  assert.equal(page.intents.length, 0, 'composing must not submit')
  page.fire('keydown', { key: 'Enter', ctrlKey: true, target: input })
  assert.equal(page.intents.length, 1)
  assert.equal(page.intents[0].comment, '正在组词')
})

test('B46: without a preload the overlay falls back to postMessage, still low-trust', () => {
  const page = fakePage({ withPreload: false })
  const answer = JSON.parse(page.run(overlayScript()))
  assert.equal(answer.channel, 'postMessage')
  page.fire('mousedown')
  const host = page.body.children.find(node => node.id === OVERLAY_HOST_ID)
  const confirm = confirmOf(host)
  page.fire('click', { target: confirm, isTrusted: false })
  assert.equal(page.messages.length, 1)
  assert.equal(page.messages[0].entry, 'page-overlay')
})

test('B54/B60: dispose removes every listener and the entry node', () => {
  const page = fakePage()
  page.run(overlayScript())
  const before = [...page.listeners.values()].reduce((count, rows) => count + rows.length, 0)
  assert.ok(before >= 4)
  const removed = JSON.parse(page.run(overlayDisposeScript()))
  assert.equal(removed.removed, before)
  assert.equal(page.body.children.filter(node => node.id === OVERLAY_HOST_ID).length, 0)
  assert.equal(JSON.parse(page.run(overlayDisposeScript())).removed, 0, 'dispose is idempotent')
})

test('selection entry supports keyboard dismissal and stays hidden after activation', () => {
  const page = fakePage()
  page.run(overlayScript())
  const button = page.body.children.find(node => node.id === OVERLAY_HOST_ID)
  assert.equal(button.attrs.role, 'group')
  assert.equal(button.attrs['aria-label'], '引用到 DSH')
  const confirm = confirmOf(button)
  assert.equal(confirm.attrs.type, 'button', 'the confirm control is a real button')
  assert.equal(confirm.attrs['aria-label'], '引用所选内容')
  // The control is an icon button, and the mark is a TEXT glyph again: a stroked check in inline
  // SVG was tried and measured on a real page, where the path painted nothing at all and the button
  // was just an empty circle. The glyph renders everywhere; the colour pairing comes from the theme
  // painter, which inverts it against the bar (light circle + dark check on a dark page).
  assert.equal(confirm.textContent, '✓')
  assert.doesNotMatch(String(confirm.innerHTML || ''), /<svg/i, 'no SVG: it did not paint on a real page')
  // No dedicated close control: cancelling is the same gesture as dismissing a
  // plain selection — click somewhere else on the page.
  const close = findDeep(button, node => node.attrs['aria-label'] === '取消引用')
  assert.equal(close, undefined, 'the bar has no separate cancel button')
  page.fire('selectionchange')
  assert.equal(button.style.display, 'block')
  // The bar states WHAT it is about to quote.
  const preview = findDeep(button, node => node.attrs['aria-hidden'] === 'true')
  assert.match(preview.textContent, /chosen words/)
  page.fire('mouseup', { target: button })
  page.fire('click', { target: confirm })
  // Submitting leaves nothing behind: the bar closes at once and clears its
  // status, instead of parking a "已提交，正在加入…" strip on the page.
  assert.equal(findDeep(button, node => node.attrs.role === 'status').textContent, '')
  assert.equal(button.style.display, 'none', 'submitting closes the bar immediately')
  page.fire('selectionchange')
  assert.equal(button.style.display, 'none', 'the unchanged selection must not reopen the entry')
  page.fire('mousedown', { target: null })
  page.fire('selectionchange')
  assert.equal(button.style.display, 'block', 'a fresh gesture may reference the same words again')
  page.fire('keydown', { key: 'Escape' })
  page.fire('selectionchange')
  assert.equal(button.style.display, 'none')
})

// -------------------------------------------------------------------- frames

test('B32: frame identity comes from the iframe element, not the page payload', () => {
  const page = fakePage()
  const body = { nodeType: 1, tagName: 'BODY', querySelectorAll: () => [] }
  const text = { nodeType: 3, nodeValue: 'chosen words', parentElement: body }
  body.firstChild = text
  const range = { startContainer: text, endContainer: text, startOffset: 0, endOffset: 12, cloneRange() { return this } }
  const iframe = {
    tagName: 'IFRAME',
    contentDocument: {
      body,
      createTreeWalker: () => ({ nextNode: () => null }),
      title: 'A frame',
      querySelectorAll: () => [],
    },
    contentWindow: { location: { href: 'https://example.com/embed#part' }, getSelection: () => ({ rangeCount: 1, isCollapsed: false, getRangeAt: () => range }) },
    getAttribute: key => key === 'src' ? 'https://example.com/embed' : null,
  }
  page.document.querySelector = () => iframe
  const answer = JSON.parse(page.run(frameCaptureScript()))
  assert.equal(answer.ok, true)
  assert.equal(answer.frameUrl, 'https://example.com/embed#part')
  assert.equal(answer.url, 'https://example.com/page')
  assert.equal(answer.frameRoute, undefined, 'the page cannot self-report frameRoute')
  assert.equal(answer.events[0].kind, 'text')
  assert.equal(answer.events[0].exact, 'chosen words')
  assert.equal(answer.events[0].content[0].text, 'chosen words')
  const valid = validateFrameCapture({ ...answer, frameRoute: 'admin', frameSelector: 'evil' }, '#frame')
  assert.equal(valid.frameSelector, '#frame', 'host request wins over the payload')
  assert.equal(valid.frameRoute, undefined)
  assert.equal(validateFrameCapture({ ok: false, reason: 'frame-inaccessible' }, '#frame').reason, 'frame-inaccessible')
  assert.equal(validateFrameCapture(null, '#frame'), undefined)
})

// ------------------------------------------------------------- service paths

function frameFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-browser-ref-frame-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const storePath = join(directory, 'references.jsonl')
  const calls = []
  const host = {
    evaluate: async (_sessionId, request) => {
      calls.push(request)
      const script = request.script
      if (script.includes('frame-inaccessible')) {
        return JSON.stringify({
          ok: true,
          url: 'https://example.com/page',
          frameUrl: 'https://example.com/embed#part',
          title: 'A frame',
          // A hostile page tries to name its own identity; the host must win.
          frameSelector: 'evil-selector',
          frameRoute: 'admin',
          events: [{ kind: 'text', exact: 'chosen words', prefix: 'before ', suffix: ' after' }],
        })
      }
      if (script.includes('return JSON.stringify(capture(spec))')) {
        return JSON.stringify({ ok: true, url: 'https://example.com/page', title: 'A page', events: [] })
      }
      throw new Error(`unrouted page script: ${script.slice(0, 80)}`)
    },
    exists: sessionId => sessionId === 'session-1',
  }
  const service = new BrowserReferenceService(host, new ReferenceStore(storePath), {
    assetDir: join(directory, 'assets'),
  })
  return { service, calls, storePath }
}

test('B32: a frame capture records host-owned frame identity and its parts', async t => {
  const { service, calls } = frameFixture(t)
  const outcome = await service.capture({ sessionId: 'session-1', frameSelector: '#editor iframe' })
  assert.ok(outcome.reference, 'a frame selection becomes a reference')
  assert.equal(outcome.reference.source.frameRoute, 'frame')
  assert.equal(outcome.reference.source.frameSelector, '#editor iframe')
  assert.equal(outcome.reference.source.frameUrl, 'https://example.com/embed#part')
  assert.equal(outcome.reference.source.pageUrl, 'https://example.com/page')
  assert.equal(outcome.reference.parts[0].type, 'text')
  assert.equal(outcome.reference.parts[0].text, 'chosen words')
  assert.equal(calls[0].args[0].frameSelector, '#editor iframe')
})

test('a malformed frame selector is refused before any page evaluation', async t => {
  const { service, calls } = frameFixture(t)
  const outcome = await service.capture({ sessionId: 'session-1', frameSelector: 'a; alert(1)' })
  assert.equal(outcome.reference, undefined)
  assert.equal(outcome.failures[0].reason, 'invalid-frame-selector')
  assert.equal(calls.length, 0)
})

test('without a frame selector the top-document path still says main', async t => {
  const { service } = frameFixture(t)
  const outcome = await service.capture({ sessionId: 'session-1', excerptText: 'agent note' })
  // The fake top-document capture returns no events, so the group is refused —
  // but the important part is which script ran and that no frameRoute leaked.
  assert.equal(outcome.failures.some(failure => failure.reason === 'nothing-captured'), true)
})

// --- frozen capture bounds -----------------------------------------------------

import { validateFrozenCapture } from '../lib/browser-reference/page-script.js'

test('a frozen capture keeps every event; the service, not the transport, owns the part limit', () => {
  // Truncating here used to drop fragments silently and turn an honest
  // `too-many-parts` refusal into a reference missing its tail.
  const events = Array.from({ length: 30 }, (_, index) => ({ kind: 'text', exact: `part ${index}`, prefix: '', suffix: '' }))
  const validated = validateFrozenCapture({ ok: true, url: 'https://example.com/', title: 'T', events })
  assert.ok(validated !== undefined)
  assert.equal(validated.events.length, 30)
})

test('an empty or unusably large frozen capture is refused, never partially trusted', () => {
  assert.equal(validateFrozenCapture({ ok: true, url: 'https://example.com/', events: [] }), undefined)
  const huge = Array.from({ length: 600 }, () => ({ kind: 'text', exact: 'x' }))
  assert.equal(validateFrozenCapture({ ok: true, url: 'https://example.com/', events: huge }), undefined)
})

// --- capture refusal feedback --------------------------------------------------

import { noticeScript } from '../lib/browser-reference/page-script.js'

test('a refused capture says so in the page, once, and reuses its toast', () => {
  const page = fakePage()
  const first = JSON.parse(page.run(noticeScript('这条引用没有加入')))
  assert.equal(first.ok, true)
  const toast = page.document.getElementById('__dsh-ref-notice')
  assert.ok(toast, 'a visible notice exists')
  assert.equal(toast.textContent, '这条引用没有加入')

  const again = JSON.parse(page.run(noticeScript('网页刚刚跳转了')))
  assert.equal(again.ok, true)
  assert.equal(page.body.children.filter(node => node.id === '__dsh-ref-notice').length, 1, 'no stacked toasts')
  assert.equal(page.document.getElementById('__dsh-ref-notice').textContent, '网页刚刚跳转了')
})

test('an absurd notice is bounded before it reaches the DOM', () => {
  const page = fakePage()
  page.run(noticeScript('x'.repeat(1000)))
  assert.equal(page.document.getElementById('__dsh-ref-notice').textContent.length, 200)
})
