/**
 * Visible-region snapshots (B58/B12/B10) and image-version verification
 * (B33/B57). These are behaviour tests: the page is a fake that routes on the
 * script's own marker, and the host is injected with a fake clipped capture.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import {
  clipFromFacts,
  compareImageVersion,
  maskScript,
  probeDigest,
  unmaskScript,
  validateVisibleFacts,
  versionProbeScript,
  visibleFactsScript,
  MASK_HOST_ID,
  OVERLAY_HOST_ID,
} from '../lib/browser-reference/visible.js'
import { BrowserReferenceService } from '../lib/browser-reference/service.js'
import { ReferenceStore } from '../lib/browser-reference/store.js'

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('dsh-visible-test'),
])

const FACTS = {
  ok: true,
  probe: 'dsh-visible-facts',
  url: 'https://example.com/article',
  title: 'An article',
  frameUrl: 'https://example.com/article',
  frameRoute: 'main',
  dpr: 2,
  scrollX: 0,
  scrollY: 40,
  viewportWidth: 1000,
  viewportHeight: 800,
  visualScale: 1,
  rects: [
    { x: 10, y: 20, width: 100, height: 30 },
    { x: 300, y: 20, width: 100, height: 30 },
  ],
  multipleRanges: true,
}

// ---------------------------------------------------------------- pure helpers

test('validateVisibleFacts accepts a real sample and refuses a page that invents one', () => {
  const facts = validateVisibleFacts(FACTS)
  assert.ok(facts)
  assert.equal(facts.rects.length, 2)
  assert.equal(facts.dpr, 2)
  assert.equal(facts.multipleRanges, true)
  for (const bad of [
    undefined,
    null,
    {},
    { ...FACTS, ok: false },
    { ...FACTS, probe: 'something-else' },
    { ...FACTS, url: '' },
    { ...FACTS, viewportWidth: 0 },
    { ...FACTS, rects: [] },
    { ...FACTS, rects: [{ x: 1, y: 2, width: 0, height: 10 }] },
  ]) {
    assert.equal(validateVisibleFacts(bad), undefined)
  }
  const hostile = validateVisibleFacts({ ...FACTS, rects: [{ x: 1e9, y: -1e9, width: 1e9, height: 1e9 }] })
  assert.ok(hostile)
  assert.ok(hostile.rects[0].width <= 8192)
})

test('clipFromFacts keeps the visible intersection and records the scroll offset', () => {
  const facts = validateVisibleFacts(FACTS)
  const planned = clipFromFacts(facts)
  assert.ok(planned)
  assert.equal(planned.clip.x, 10)
  assert.equal(planned.clip.y, 60, 'viewport y 20 + scrollY 40')
  assert.equal(planned.clip.width, 390, 'outer box between the two selected columns')
  assert.equal(planned.clip.height, 30)
  assert.equal(planned.clip.scale, 1)
  assert.equal(planned.meta.rects, 2)
  assert.equal(planned.meta.partiallyVisible, true)
  assert.equal(planned.meta.dpr, 2)
  assert.deepEqual(planned.meta.scroll, { x: 0, y: 40 })

  const partlyOffscreen = validateVisibleFacts({
    ...FACTS,
    scrollY: 0,
    rects: [{ x: -50, y: 780, width: 200, height: 100 }],
  })
  const clipped = clipFromFacts(partlyOffscreen)
  assert.ok(clipped)
  assert.equal(clipped.clip.x, 0, 'left clipped at the viewport')
  assert.equal(clipped.clip.y, 780)
  assert.equal(clipped.clip.width, 150)
  assert.equal(clipped.clip.height, 20, 'only the visible 20px survive')
  assert.equal(clipped.meta.partiallyVisible, true)

  const offscreen = validateVisibleFacts({ ...FACTS, rects: [{ x: 2000, y: 20, width: 10, height: 10 }] })
  assert.equal(clipFromFacts(offscreen), undefined, 'a fully invisible target is not captured')
})

test('page and host compute the same version digest', async () => {
  const bytes = Uint8Array.from(PNG)
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  })
  const script = versionProbeScript().replace('(arguments[0] || {})', '(spec)')
  const run = new Function('spec', 'fetch', 'Uint8Array', 'Math', 'JSON', `return ${script}`)
  const answer = await run({ url: 'https://example.com/a.png' }, fakeFetch, Uint8Array, Math, JSON)
  const probe = JSON.parse(answer)
  assert.equal(probe.ok, true)
  assert.equal(probe.length, PNG.length)
  assert.equal(probe.digest, probeDigest(PNG))
  assert.equal(compareImageVersion(probe, PNG), 'verified')
})

test('compareImageVersion distinguishes verified, changed and unverifiable', () => {
  const probe = { ok: true, length: PNG.length, digest: probeDigest(PNG) }
  assert.equal(compareImageVersion(probe, PNG), 'verified')
  assert.equal(compareImageVersion({ ...probe, digest: 'deadbeef-0-1' }, PNG), 'changed')
  assert.equal(compareImageVersion({ ...probe, length: PNG.length + 1 }, PNG), 'changed')
  assert.equal(compareImageVersion({ ok: false, reason: 'page-fetch-unavailable' }, PNG), 'unverifiable')
  assert.equal(compareImageVersion(null, PNG), 'unverifiable')
  assert.equal(compareImageVersion({ ok: true, length: NaN, digest: 'x' }, PNG), 'unverifiable')
})

// -------------------------------------------------------------- page-side mask

function fakeDom() {
  const nodes = new Map()
  const make = (tag, ns) => ({
    tag, ns, id: '', attrs: {}, children: [], parentNode: null,
    style: { cssText: '', display: '' },
    setAttribute(key, value) { this.attrs[key] = String(value) },
    getAttribute(key) { return this.attrs[key] },
    appendChild(child) {
      this.children.push(child)
      child.parentNode = this
      if (child.id) nodes.set(child.id, child)
      return child
    },
    removeChild(child) {
      this.children = this.children.filter(node => node !== child)
      child.parentNode = null
      if (child.id) nodes.delete(child.id)
    },
  })
  const overlay = make('div')
  overlay.id = OVERLAY_HOST_ID
  overlay.style.display = 'flex'
  nodes.set(OVERLAY_HOST_ID, overlay)
  const document = {
    body: make('body'),
    getElementById: id => nodes.get(id) ?? null,
    createElement: tag => make(tag),
    createElementNS: (ns, tag) => make(tag, ns),
  }
  const window = { innerWidth: 1000, innerHeight: 800, __dshRefMaskHidden: [] }
  return { document, window, nodes, overlay, body: document.body }
}

function runPageScript(script, spec, dom) {
  const wrapped = script.replace('(arguments[0] || {})', '(spec)')
  const context = vm.createContext({
    spec,
    document: dom.document,
    window: dom.window,
    JSON,
    Math,
    Number,
    String,
    Array,
  })
  return vm.runInContext(wrapped, context)
}

test('maskScript punches a hole for every selected rect and hides our own overlay', () => {
  const dom = fakeDom()
  const answer = JSON.parse(runPageScript(maskScript(), {
    rects: FACTS.rects, viewportWidth: 1000, viewportHeight: 800,
  }, dom))
  assert.equal(answer.ok, true)
  assert.equal(answer.rects, 2)
  assert.equal(answer.hidden, 1)
  assert.equal(dom.overlay.style.display, 'none', 'the floating entry cannot be baked into the image')

  const host = dom.nodes.get(MASK_HOST_ID)
  assert.ok(host, 'mask host is attached')
  const svg = host.children[0]
  const mask = svg.children[0].children[0]
  const holes = mask.children.filter(node => node.attrs.fill === 'black')
  assert.equal(holes.length, 2, 'one hole per selected rectangle, not one big box')
  assert.equal(holes[0].attrs.x, '10')
  assert.equal(holes[1].attrs.x, '300')

  const restored = JSON.parse(runPageScript(unmaskScript(), {}, dom))
  assert.equal(restored.restored, 1)
  assert.equal(dom.overlay.style.display, 'flex')
  assert.equal(dom.nodes.get(MASK_HOST_ID), undefined, 'mask is removed again')
})

test('the facts and mask scripts are self-contained one-shot expressions', () => {
  for (const script of [visibleFactsScript(), versionProbeScript(), maskScript(), unmaskScript()]) {
    assert.ok(script.includes('arguments[0]'))
    assert.equal(script.includes('`'), false)
    assert.equal(script.includes('${'), false)
    assert.doesNotThrow(() => new Function(`return ${script}`))
  }
})

// --------------------------------------------------------------- service paths

function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-browser-ref-visible-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const storePath = join(directory, 'references.jsonl')
  const assets = join(directory, 'assets')
  const calls = []
  const state = {
    versionChanged: false,
    versionUnverifiable: false,
    downloadFails: false,
    captureThrows: false,
    shots: 0,
    masks: 0,
    unmasks: 0,
    ...overrides,
  }
  const imageEvent = { kind: 'image', src: 'https://example.com/photo.png', path: [3], geometry: { x: 10, y: 20, w: 100, h: 30 } }
  const capture = {
    ok: true,
    url: FACTS.url,
    title: FACTS.title,
    events: [imageEvent],
  }
  const host = {
    evaluate: async (_sessionId, request) => {
      calls.push(request)
      const script = request.script
      if (script.includes('return JSON.stringify(capture(spec))')) return JSON.stringify(capture)
      if (script.includes('probe: "dsh-visible-facts"')) return JSON.stringify(FACTS)
      if (script.includes('dshFnv(bytes)')) {
        if (state.versionUnverifiable) return JSON.stringify({ ok: false, reason: 'page-fetch-unavailable' })
        if (state.versionChanged) return JSON.stringify({ ok: true, length: PNG.length, digest: 'deadbeef-0-1' })
        return JSON.stringify({ ok: true, length: PNG.length, digest: probeDigest(PNG) })
      }
      if (script.includes('host.id = "__dsh-ref-visible-mask"')) {
        state.masks += 1
        return JSON.stringify({ ok: true, rects: FACTS.rects.length, hidden: 1 })
      }
      if (script.includes('restored: hidden.length')) {
        state.unmasks += 1
        return JSON.stringify({ ok: true, removed: 1, restored: 1 })
      }
      if (script.includes('rasterize(spec).then')) return JSON.stringify({ ok: false, reason: 'image-load-failed' })
      if (script.includes('String(location.href)')) return JSON.stringify({ ok: true, url: FACTS.url, title: FACTS.title })
      throw new Error(`unrouted page script: ${script.slice(0, 80)}`)
    },
    exists: sessionId => sessionId === 'session-1',
    download: async (_sessionId, _url, savePath) => {
      if (state.downloadFails) throw new Error('download refused')
      writeFileSync(savePath, PNG)
    },
    captureVisible: async () => {
      state.shots += 1
      if (state.captureThrows) throw new Error('no display surface')
      return { dataUrl: `data:image/png;base64,${PNG.toString('base64')}`, mime: 'image/png' }
    },
  }
  const service = new BrowserReferenceService(host, new ReferenceStore(storePath), { assetDir: assets })
  return { assets, calls, host, service, state, storePath }
}

test('a verified download is still a source-image and records the check', async t => {
  const { service, assets } = fixture(t)
  const outcome = await service.capture({ sessionId: 'session-1' })
  assert.ok(outcome.reference)
  const part = outcome.reference.parts[0]
  assert.equal(part.representation, 'source-image')
  assert.equal(part.anchor.versionStatus, 'verified')
  const meta = JSON.parse(readFileSync(join(assets, `${part.assetKey}.json`), 'utf8'))
  assert.equal(meta.versionStatus, 'verified')
})

test('an unprobeable page stays usable but is never called verified', async t => {
  const { service } = fixture(t, { versionUnverifiable: true })
  const outcome = await service.capture({ sessionId: 'session-1' })
  assert.ok(outcome.reference)
  assert.equal(outcome.reference.parts[0].anchor.versionStatus, 'unverifiable')
})

test('B57: a re-download whose bytes changed is never advertised as the selected source image', async t => {
  const { service, state } = fixture(t, { versionChanged: true })
  const outcome = await service.capture({ sessionId: 'session-1' })
  // Either a masked visible snapshot (the design's preferred retry) or an
  // explicit re-capture failure: never 'source-image' from the newer bytes.
  if (outcome.reference !== undefined) {
    assert.equal(outcome.reference.parts[0].representation, 'visible-snapshot')
  } else {
    assert.ok(outcome.failures.some(failure => failure.reason === 'image-version-changed'))
  }
  assert.equal(state.shots > 0 || outcome.reference === undefined, true)
})

test('B58: when source bytes are unavailable the masked visible region is saved and described', async t => {
  const { service, state, assets } = fixture(t, { downloadFails: true })
  const outcome = await service.capture({ sessionId: 'session-1' })
  assert.ok(outcome.reference, 'the capture succeeds with a visible snapshot')
  const part = outcome.reference.parts[0]
  assert.equal(part.representation, 'visible-snapshot')
  assert.equal(part.anchor.visible.rects, 2, 'both selected columns are recorded')
  assert.equal(part.anchor.visible.partiallyVisible, true)
  assert.equal(part.anchor.visible.dpr, 2)
  assert.equal(part.anchor.visible.clip.y, 60)
  assert.equal(state.masks, 1)
  assert.equal(state.unmasks, 1, 'the mask is removed even on the success path')
  const meta = JSON.parse(readFileSync(join(assets, `${part.assetKey}.json`), 'utf8'))
  assert.equal(meta.representation, 'visible-snapshot')
  assert.equal(meta.visible.rects, 2)
})

test('a failed clipped capture still removes the mask and keeps the old failure reason', async t => {
  const { service, state } = fixture(t, { downloadFails: true, captureThrows: true })
  const outcome = await service.capture({ sessionId: 'session-1' })
  assert.equal(outcome.reference, undefined)
  assert.ok(outcome.failures.some(failure => failure.reason === 'image-unavailable'))
  assert.equal(state.masks, 1)
  assert.equal(state.unmasks, 1, 'cleanup is in a finally, so a failed shot cannot leave a mask on the page')
})

test('a host without a clipped-capture capability keeps the legacy failure exactly', async t => {
  const { host, storePath } = fixture(t, { downloadFails: true })
  delete host.captureVisible
  const service = new BrowserReferenceService(host, new ReferenceStore(storePath), { assetDir: join(storePath, '..', 'assets') })
  const outcome = await service.capture({ sessionId: 'session-1' })
  assert.equal(outcome.reference, undefined)
  assert.ok(outcome.failures.some(failure => failure.reason === 'image-unavailable'))
})

test('a long-page scroll offset is not clamped to 65 536px, so the clip lands correctly', () => {
  const facts = validateVisibleFacts({ ...FACTS, scrollY: 120_000, scrollX: 90_000 })
  assert.ok(facts)
  assert.equal(facts.scrollY, 120_000, 'a long document keeps its real scroll offset')
  assert.equal(facts.scrollX, 90_000)
  const planned = clipFromFacts(facts)
  assert.ok(planned)
  assert.equal(planned.clip.y, 120_020, 'client y 20 translated by the FULL scrollY, not a clamped one')
  assert.equal(planned.clip.x, 90_010)
  assert.deepEqual(planned.meta.scroll, { x: 90_000, y: 120_000 })

  // Still bounded: an absurd value cannot turn into Infinity or an unbounded clip.
  const wild = validateVisibleFacts({ ...FACTS, scrollY: 1e12 })
  assert.equal(wild.scrollY, 1e7)
  assert.equal(validateVisibleFacts({ ...FACTS, scrollY: Number.POSITIVE_INFINITY }).scrollY, 0,
    'a non-finite scroll falls back to 0')
})
