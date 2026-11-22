/**
 * Reference service: capture validation, asset materialisation, partial-failure
 * policy, reveal statuses and the reserved draft adapter.
 *
 * The page is faked by routing on the script's own marker, so these tests check
 * the host half's rules — what is accepted from an untrusted page, what is
 * refused, and what is stored — without needing a browser.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserReferenceService } from '../lib/browser-reference/service.js'
import { ReferenceStore } from '../lib/browser-reference/store.js'
import { manifestHashOf } from '../lib/browser-reference/store.js'
import { captureScript } from '../lib/browser-reference/page-script.js'

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('dsh-reference-test'),
])

function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-browser-ref-svc-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const storePath = join(directory, 'references.jsonl')
  const assets = join(directory, 'assets')
  const calls = []
  const page = {
    capture: { ok: true, url: 'https://example.com/article', title: 'An article', events: [] },
    facts: { ok: true, url: 'https://example.com/article', title: 'An article' },
    text: { ok: true, url: 'https://example.com/article', title: 'An article', text: '', truncated: false },
    highlight: { ok: true, rects: 1, scrolled: true },
    reveal: { ok: true, status: 'found', matches: 1, rects: 1 },
    raster: { ok: false, reason: 'image-load-failed' },
    ...overrides,
  }
  const host = {
    evaluate: async (sessionId, request) => {
      calls.push(request)
      const script = request.script
      if (script.includes('return JSON.stringify(capture(spec))')) return JSON.stringify(page.capture)
      if (script.includes('text: map.text, truncated: map.truncated')) return JSON.stringify(page.text)
      if (script.includes('return JSON.stringify(highlightText(spec))')) return JSON.stringify(page.highlight)
      if (script.includes('return JSON.stringify(revealElement(spec))')) return JSON.stringify(page.reveal)
      if (script.includes('rasterize(spec).then')) return JSON.stringify(page.raster)
      if (script.includes('String(location.href)')) return JSON.stringify(page.facts)
      throw new Error(`unrouted page script: ${script.slice(0, 80)}`)
    },
    exists: sessionId => sessionId === 'session-1',
    download: async (_sessionId, _url, savePath) => {
      if (page.downloadFails === true) throw new Error('download refused')
      writeFileSync(savePath, PNG)
    },
  }
  const service = new BrowserReferenceService(host, new ReferenceStore(storePath), { assetDir: assets })
  return { directory, storePath, assets, calls, page, host, service }
}

function textEvent(exact = 'selected words', prefix = 'before ', suffix = ' after') {
  return { kind: 'text', exact, prefix, suffix }
}

test('each capture is stored for its requested owner, even when other sessions quote identical content', async t => {
  const { service } = fixture(t)
  const frozenCapture = { ok: true, url: 'https://example.com/article', title: 'Article', events: [textEvent()] }
  const first = await service.capture({ sessionId: 'owner-A', frozenCapture })
  const second = await service.capture({ sessionId: 'owner-B', frozenCapture })
  const repeated = await service.capture({ sessionId: 'owner-B', frozenCapture })
  assert.deepEqual(first.failures, [])
  assert.deepEqual(second.failures, [])
  assert.equal(second.reference.owner.sessionId, 'owner-B')
  assert.notEqual(second.reference.referenceId, first.reference.referenceId)
  assert.notEqual(repeated.reference.referenceId, second.reference.referenceId)
  assert.deepEqual(service.list({ sessionId: 'owner-A' }).map(item => item.referenceId), [first.reference.referenceId])
  assert.deepEqual(service.list({ sessionId: 'owner-B' }).map(item => item.referenceId), [second.reference.referenceId, repeated.reference.referenceId])
})

test('different table-only selections on one page remain distinct references', async t => {
  const { service } = fixture(t)
  const capture = text => service.capture({ sessionId: 'owner', frozenCapture: {
    ok: true, url: 'https://example.com/article', title: 'Article', events: [{ kind: 'table', table: {
      rowCount: 1, columnCount: 1, completeness: 'selected-cells', cells: [{ row: 0, column: 0, text }],
    } }],
  } })
  const first = await capture('one')
  const second = await capture('two')
  assert.deepEqual(second.failures, [])
  assert.notEqual(second.reference.referenceId, first.reference.referenceId)
  assert.equal(second.reference.parts[0].table.cells[0].text, 'two')
})

test('capture commits an ordered reference with a self-consistent hash', async t => {
  const { page, service, storePath, assets } = fixture(t)
  page.capture = {
    ok: true,
    url: 'https://example.com/article',
    title: 'An article',
    events: [
      textEvent('A'),
      { kind: 'image', src: 'https://example.com/a.png', currentSrc: 'https://example.com/a.png', alt: 'A picture', selector: '#pic', path: [1, 2], geometry: { x: 1, y: 2, w: 10, h: 10 } },
      {
        kind: 'table',
        selector: '#results',
        table: {
          rowCount: 2,
          columnCount: 2,
          completeness: 'selected-cells',
          cells: [
            { row: 0, column: 0, role: 'header', text: 'Name', includedAs: 'selection' },
            { row: 0, column: 1, role: 'header', text: 'Score', includedAs: 'selection' },
            { row: 1, column: 0, role: 'data', text: 'Ada', includedAs: 'selection', partialText: false },
          ],
        },
      },
      textEvent('B'),
    ],
  }
  const outcome = await service.capture({ sessionId: 'session-1', entry: 'agent-tool' })
  assert.equal(outcome.failures.length, 0)
  const reference = outcome.reference
  assert.ok(reference)
  assert.deepEqual(reference.parts.map(part => part.type), ['text', 'image', 'table', 'text'])
  assert.deepEqual(reference.parts.map(part => part.partId), ['p1', 'p2', 'p3', 'p4'])
  assert.equal(reference.parts[1].assetKey, createHash('sha256').update(PNG).digest('hex'))
  assert.equal(reference.parts[1].representation, 'source-image')
  assert.equal(reference.parts[2].anchor.headers[0], 'Name')
  assert.equal(reference.parts[2].anchor.headers[1], 'Score')
  assert.equal(reference.manifestHash, manifestHashOf(reference))
  assert.equal(service.get(reference.referenceId).manifestHash, reference.manifestHash)
  assert.equal(readFileSync(join(assets, `${reference.parts[1].assetKey}.bin`)).toString('base64'), PNG.toString('base64'))
  assert.equal(new ReferenceStore(storePath).count(), 1)
})

test('a failed image refuses the whole group by default and keeps the failure listed', async t => {
  const { page, service, storePath } = fixture(t)
  page.downloadFails = true
  page.capture = {
    ok: true,
    url: 'https://example.com/article',
    title: 'An article',
    events: [textEvent('A'), { kind: 'image', src: 'https://example.com/missing.png', path: [9] }, textEvent('B')],
  }
  const refused = await service.capture({ sessionId: 'session-1' })
  assert.equal(refused.reference, undefined)
  assert.equal(refused.failures.some(failure => failure.kind === 'image' && failure.reason === 'image-unavailable'), true)
  assert.equal(new ReferenceStore(storePath).count(), 0)

  const partial = await service.capture({ sessionId: 'session-1', allowPartial: true })
  assert.ok(partial.reference)
  assert.deepEqual(partial.reference.parts.map(part => part.type), ['text', 'text'])
  assert.equal(partial.failures.some(failure => failure.kind === 'image'), true)
})

test('a page cannot choose part ids, invent kinds or exceed the text cap', async t => {
  const { page, service } = fixture(t)
  page.capture = {
    ok: true,
    url: 'https://example.com/article',
    title: 'An article',
    events: [
      { kind: 'text', partId: 'attacker', exact: 'visible text', prefix: '', suffix: '' },
      { kind: 'script', exact: 'alert(1)' },
      { kind: 'text', exact: 'x'.repeat(20_001) },
    ],
  }
  const outcome = await service.capture({ sessionId: 'session-1', allowPartial: true })
  assert.ok(outcome.reference)
  assert.deepEqual(outcome.reference.parts.map(part => part.partId), ['p1'])
  assert.equal(outcome.reference.parts[0].text, 'visible text')
  const reasons = outcome.failures.map(failure => failure.reason)
  assert.ok(reasons.includes('unsupported-part'))
  assert.ok(reasons.includes('text-too-long'))
})

test('an oversized table is refused instead of being silently shortened', async t => {
  const { page, service } = fixture(t)
  page.capture = {
    ok: true,
    url: 'https://example.com/article',
    title: 'An article',
    events: [{
      kind: 'table',
      table: { truncated: true, rowCount: 9000, columnCount: 20, completeness: 'visible-rows', cells: [{ row: 0, column: 0, text: 'a' }] },
    }],
  }
  const outcome = await service.capture({ sessionId: 'session-1' })
  assert.equal(outcome.reference, undefined)
  assert.equal(outcome.failures[0].reason, 'table-too-large')
})

test('a cell image becomes its own part after the table and stays linked', async t => {
  const { page, service } = fixture(t)
  page.capture = {
    ok: true,
    url: 'https://example.com/article',
    title: 'An article',
    events: [{
      kind: 'table',
      table: {
        rowCount: 1,
        columnCount: 1,
        completeness: 'dom-table',
        cells: [{
          row: 0,
          column: 0,
          role: 'data',
          text: 'chart',
          includedAs: 'selection',
          inlineContent: [{ type: 'text', text: 'chart' }, { type: 'image', src: 'https://example.com/cell.png', currentSrc: 'https://example.com/cell.png', alt: 'cell chart' }],
        }],
      },
    }],
  }
  const outcome = await service.capture({ sessionId: 'session-1' })
  assert.equal(outcome.failures.length, 0)
  const [table, image] = outcome.reference.parts
  assert.equal(table.type, 'table')
  assert.equal(image.type, 'image')
  assert.deepEqual(table.table.cells[0].inlineContent[1], { type: 'image', partId: 'p2', assetKey: image.assetKey })
})

test('the excerpt path is passed to the page as data, never spliced into code', async t => {
  const { page, service, calls } = fixture(t)
  page.capture = { ok: true, url: 'https://example.com/article', title: 'An article', events: [textEvent('quoted')] }
  await service.capture({ sessionId: 'session-1', excerptText: '"; alert(1); //' })
  const capture = calls.find(call => call.script.includes('return JSON.stringify(capture(spec))'))
  assert.ok(capture)
  assert.deepEqual(capture.args[0].excerptText, '"; alert(1); //')
  assert.equal(capture.script.includes('alert(1)'), false)
})

test('capture refuses a missing session and an empty selection', async t => {
  const { page, service } = fixture(t)
  page.capture = { ok: false, reason: 'no-selection' }
  assert.deepEqual((await service.capture({ sessionId: 'other' })).failures.map(f => f.reason), ['session-unavailable'])
  assert.deepEqual((await service.capture({ sessionId: 'session-1' })).failures.map(f => f.reason), ['no-selection'])
})

test('reveal locates the first part and highlights its exact text offsets', async t => {
  const { page, service, calls } = fixture(t)
  page.capture = { ok: true, url: 'https://example.com/article', title: 'An article', events: [textEvent('selected words')] }
  page.text = { ok: true, text: 'alpha selected words omega', truncated: false }
  const reference = (await service.capture({ sessionId: 'session-1' })).reference
  const outcome = await service.reveal(reference.referenceId)
  assert.equal(outcome.status, 'revealed')
  assert.equal(outcome.parts[0].status, 'revealed')
  assert.equal(outcome.parts[0].matches, 1)
  const highlight = calls.find(call => call.script.includes('return JSON.stringify(highlightText(spec))'))
  assert.deepEqual({ start: highlight.args[0].start, end: highlight.args[0].end }, { start: 6, end: 20 })
})

test('reveal recognizes the same document across normalized URLs and fragment changes', async t => {
  const { page, service } = fixture(t)
  page.capture = { ok: true, url: 'https://example.com/article#quoted', events: [textEvent('selected words')] }
  page.text = { ok: true, text: 'alpha selected words omega', truncated: false }
  const reference = (await service.capture({ sessionId: 'session-1' })).reference
  page.facts = { ok: true, url: 'https://EXAMPLE.com:443/article#current' }
  assert.equal((await service.reveal(reference.referenceId)).status, 'revealed')
})

test('reveal reports ambiguity instead of guessing between equal matches', async t => {
  const { page, service, calls } = fixture(t)
  page.capture = { ok: true, url: 'https://example.com/article', title: 'An article', events: [textEvent('same', '', '')] }
  page.text = { ok: true, text: 'same and same', truncated: false }
  const reference = (await service.capture({ sessionId: 'session-1' })).reference
  const outcome = await service.reveal(reference.referenceId)
  assert.equal(outcome.status, 'ambiguous')
  assert.equal(outcome.parts[0].status, 'ambiguous')
  assert.equal(calls.some(call => call.script.includes('return JSON.stringify(highlightText(spec))')), false)
})

test('reveal distinguishes a page mismatch from a missing session', async t => {
  const { page, service } = fixture(t)
  page.capture = { ok: true, url: 'https://example.com/article', title: 'An article', events: [textEvent('x')] }
  const reference = (await service.capture({ sessionId: 'session-1' })).reference
  page.facts = { ok: true, url: 'https://example.com/other', title: 'Other' }
  const mismatch = await service.reveal(reference.referenceId)
  assert.equal(mismatch.status, 'page-mismatch')
  assert.equal(mismatch.currentUrl, 'https://example.com/other')

  const unavailable = await service.reveal('missing-id')
  assert.equal(unavailable.status, 'not-found')
})

test('reveal never treats an unacknowledged navigation request as page readiness', async t => {
  const { page, service, host } = fixture(t)
  page.capture = { ok: true, url: 'https://example.com/article', title: 'An article', events: [textEvent('selected words')] }
  page.text = { ok: true, text: 'alpha selected words omega', truncated: false }
  const reference = (await service.capture({ sessionId: 'session-1' })).reference
  // The sidebar is parked on another page: without navigation this is a mismatch.
  page.facts = { ok: true, url: 'https://example.com/other', title: 'Other' }
  assert.equal((await service.reveal(reference.referenceId)).status, 'page-mismatch')

  const navigate = host.evaluate
  host.evaluate = async (sessionId, request, signal) => {
    if (String(request.script).includes('location.href =')) {
      page.facts = { ok: true, url: 'https://example.com/article', title: 'An article' }
      return 'ok'
    }
    return await navigate(sessionId, request, signal)
  }
  const outcome = await service.reveal(reference.referenceId, { navigate: true })
  assert.equal(outcome.status, 'page-mismatch')
  assert.equal(outcome.currentUrl, 'https://example.com/other')
})

for (const storedPage of ['iframe:stored', 'native-stored']) {
  for (const requestedPage of [undefined, 'iframe:requested', 'native-requested', '']) {
    test(`reveal source precedence: stored=${storedPage}, requested=${requestedPage}`, async t => {
      const { page, service, host, assets } = fixture(t)
      page.capture = { ok: true, url: 'https://example.com/article', title: 'Article', events: [textEvent('selected words')] }
      page.text = { ok: true, text: 'alpha selected words omega', truncated: false }
      const original = (await service.capture({ sessionId: 'session-1' })).reference
      const reference = { ...original, referenceId: `${original.referenceId}-stored`, owner: { ...original.owner, sourcePageId: storedPage } }
      reference.manifestHash = manifestHashOf(reference)
      service.references.append(reference)
      const webCalls = [], nativeCalls = []
      const revived = new BrowserReferenceService(host, service.references, {
        assetDir: assets,
        webSources: { reveal: async (_reference, pageId) => { webCalls.push(pageId); return 'revealed' } },
        sourceSession: async (_owner, pageId) => {
          nativeCalls.push(pageId)
          if (pageId === '') throw new Error('source page missing')
          return 'session-1'
        },
      })
      const outcome = await revived.reveal(reference.referenceId, requestedPage === undefined ? {} : { sourcePageId: requestedPage })
      const selected = requestedPage ?? storedPage
      assert.equal(outcome.status, selected === '' ? 'unavailable' : 'revealed')
      assert.deepEqual(webCalls, selected.startsWith('iframe:') ? [selected] : [])
      assert.deepEqual(nativeCalls, selected.startsWith('iframe:') ? [] : [selected])
    })
  }
}

test('reveal binds the exact acknowledged source page when the capture session was replaced', async t => {
  const { page, service, host, assets } = fixture(t)
  page.capture = { ok: true, url: 'https://example.com/article', title: 'An article', events: [textEvent('selected words')] }
  page.text = { ok: true, text: 'alpha selected words omega', truncated: false }
  const reference = (await service.capture({ sessionId: 'session-1' })).reference

  // Same stored reference, but the sidebar page was re-adopted under a new id
  // (what a DSH restart does): the captured session no longer exists.
  const revived = new BrowserReferenceService(
    { ...host, exists: id => id === 'session-new' },
    service.references,
    { assetDir: assets, sourceSession: async (owner, pageId) => {
      assert.equal(owner, '1')
      assert.equal(pageId, '42')
      return 'session-new'
    } },
  )
  assert.equal((await revived.reveal(reference.referenceId)).status, 'session-unavailable')
  assert.equal((await revived.reveal(reference.referenceId, { sourcePageId: '42' })).status, 'revealed')

  // Without that live page the outcome must stay honest, not optimistic.
  const blind = new BrowserReferenceService(
    { ...host, exists: () => false },
    service.references,
    { assetDir: assets },
  )
  const outcome = await blind.reveal(reference.referenceId)
  assert.equal(outcome.status, 'session-unavailable')
})

test('reveal of a table part asks the page for an element locator', async t => {
  const { page, service, calls } = fixture(t)
  page.capture = {
    ok: true,
    url: 'https://example.com/article',
    title: 'An article',
    events: [{ kind: 'table', table: { rowCount: 1, columnCount: 1, completeness: 'dom-table', cells: [{ row: 0, column: 0, role: 'data', text: '42', includedAs: 'selection' }] } }],
  }
  page.reveal = { ok: true, status: 'found', matches: 1, rects: 1 }
  const reference = (await service.capture({ sessionId: 'session-1' })).reference
  const outcome = await service.reveal(reference.referenceId, { partId: reference.parts[0].partId })
  assert.equal(outcome.status, 'revealed')
  const call = calls.find(entry => entry.script.includes('return JSON.stringify(revealElement(spec))'))
  assert.equal(call.args[0].kind, 'table')
  assert.deepEqual(call.args[0].anchor.cell, { row: 0, column: 0 })
  assert.deepEqual(call.args[0].cells, [{ row: 0, column: 0 }])
})

test('the draft adapter is a reserved seam that answers honestly when absent', async t => {
  const { page, service } = fixture(t)
  page.capture = { ok: true, url: 'https://example.com/article', title: 'An article', events: [textEvent('x')] }
  const reference = (await service.capture({ sessionId: 'session-1' })).reference
  assert.deepEqual(await service.insertIntoDraft(reference.referenceId), { ok: false, reason: 'draft-adapter-unavailable' })
  let seen
  service.setDraftAdapter({ insertReference: async (stored, options) => { seen = { stored, options }; return { applied: true } } })
  assert.deepEqual(await service.insertIntoDraft(reference.referenceId), { ok: true })
  assert.equal(seen.stored.referenceId, reference.referenceId)
  assert.equal(seen.options.focus, false)
})

test('the capture script is self-contained and receives its options as an argument', () => {
  const script = captureScript()
  assert.match(script, /arguments\[0\]/)
  assert.equal(script.includes('${'), false)
  assert.equal(script.includes('`'), false)
  assert.match(script, /ariaTableSnapshot/)
  assert.match(script, /toDataURL\('image\/png'\)/)
})

test('capture records the main frame and accepts canvas pixels without storing the data URL', async t => {
  const { page, service } = fixture(t)
  const dataUrl = `data:image/png;base64,${PNG.toString('base64')}`
  page.capture = {
    ok: true,
    url: 'https://example.com/chart#part',
    frameUrl: 'https://example.com/chart#part',
    title: 'A chart',
    events: [{
      kind: 'image', src: dataUrl, currentSrc: dataUrl, attributeSrc: dataUrl, dataUrl,
      canvas: true, selector: '#chart', path: [2], geometry: { x: 0, y: 0, w: 120, h: 80 },
    }],
  }
  const reference = (await service.capture({ sessionId: 'session-1' })).reference
  assert.equal(reference.source.frameUrl, 'https://example.com/chart#part')
  assert.equal(reference.source.frameRoute, 'main')
  assert.equal(reference.parts[0].type, 'image')
  assert.equal(reference.parts[0].anchor.src, undefined)
  assert.equal(reference.parts[0].anchor.currentSrc, undefined)
  assert.equal(JSON.stringify(reference).includes('data:image/png'), false)
})

test('ARIA grid completeness survives validation', async t => {
  const { page, service } = fixture(t)
  page.capture = {
    ok: true, url: 'https://example.com/grid', title: 'A grid',
    events: [{
      kind: 'table', selector: '[role="grid"]',
      table: {
        rowCount: 2, columnCount: 2, completeness: 'aria-grid',
        cells: [
          { row: 0, column: 0, role: 'header', text: 'Name', includedAs: 'header-context' },
          { row: 0, column: 1, role: 'header', text: 'Value', includedAs: 'header-context' },
          { row: 1, column: 0, role: 'data', text: 'Alpha', includedAs: 'selection' },
          { row: 1, column: 1, role: 'data', text: '1', includedAs: 'selection' },
        ],
      },
    }],
  }
  const reference = (await service.capture({ sessionId: 'session-1' })).reference
  assert.equal(reference.parts[0].table.completeness, 'aria-grid')
})

function zipEntryNames(buffer) {
  const names = []
  let offset = 0
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034B50) {
    const size = buffer.readUInt32LE(offset + 18)
    const nameLength = buffer.readUInt16LE(offset + 26)
    const extraLength = buffer.readUInt16LE(offset + 28)
    names.push(buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8'))
    offset += 30 + nameLength + extraLength + size
  }
  return names
}

function zipEntryData(buffer, wanted) {
  let offset = 0
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034B50) {
    const size = buffer.readUInt32LE(offset + 18)
    const nameLength = buffer.readUInt16LE(offset + 26)
    const extraLength = buffer.readUInt16LE(offset + 28)
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8')
    const start = offset + 30 + nameLength + extraLength
    if (name === wanted) return buffer.subarray(start, start + size)
    offset = start + size
  }
  return undefined
}

test('exports JSONL, readable Markdown, and a ZIP carrying the actual image bytes', async t => {
  const { page, service } = fixture(t)
  page.capture = {
    ok: true, url: 'https://example.com/article', title: 'An article',
    events: [
      textEvent('Alpha'),
      { kind: 'image', src: 'https://example.com/a.png', currentSrc: 'https://example.com/a.png', alt: 'Pic', selector: '#pic' },
    ],
  }
  await service.capture({ sessionId: 'session-1' })

  const jsonl = service.exportBundle({ format: 'jsonl' })
  assert.match(jsonl.body.toString('utf8'), /"referenceId"/)
  assert.match(jsonl.body.toString('utf8'), /Alpha/)

  const markdown = service.exportBundle({ format: 'markdown' })
  assert.match(markdown.body.toString('utf8'), /Alpha/)
  assert.match(markdown.body.toString('utf8'), /https:\/\/example\.com\/a\.png/)
  assert.equal(markdown.body.toString('utf8').includes('data:'), false)

  const zip = service.exportBundle({ format: 'zip' })
  const names = zipEntryNames(zip.body)
  assert.ok(names.includes('references.jsonl'))
  assert.ok(names.includes('manifest.json'))
  assert.ok(names.includes('references.md'))
  const assetName = names.find(name => name.startsWith('assets/') && name.endsWith('.png'))
  assert.ok(assetName !== undefined)
  assert.deepEqual(zipEntryData(zip.body, assetName), PNG)

  const resourceMarkdown = service.exportBundle({ format: 'markdown-zip' })
  const resourceNames = zipEntryNames(resourceMarkdown.body)
  assert.ok(resourceNames.includes('references.md'))
  assert.ok(resourceNames.some(name => name.startsWith('assets/')))
})

test('a frozen page-bar capture is used as-is, without re-searching the page', async t => {
  // The bar froze this while the real range existed. Re-locating by wording
  // afterwards loses images/tables and can pick another occurrence.
  const frozen = {
    ok: true,
    url: 'https://example.com/article',
    title: 'An article',
    events: [{ kind: 'text', exact: 'quoted words', prefix: 'before ', suffix: ' after' }],
  }
  const { service, calls } = fixture(t, {
    // A fresh capture would answer something else entirely; it must not be asked.
    capture: { ok: true, url: 'https://example.com/other', title: 'Other', events: [{ kind: 'text', exact: 'other words' }] },
  })
  const outcome = await service.capture({ sessionId: 'session-1', frozenCapture: frozen })
  assert.ok(outcome.reference, JSON.stringify(outcome.failures))
  assert.ok(outcome.reference.parts.some(part => part.type === 'text' && part.text.includes('quoted words')))
  assert.equal(
    calls.some(call => call.script.includes('return JSON.stringify(capture(spec))')),
    false,
    'the page must not be re-captured when a frozen snapshot exists',
  )
})

test('a frozen capture is refused when the page has navigated since it was taken', async t => {
  const frozen = {
    ok: true,
    url: 'https://example.com/old',
    title: 'Old',
    events: [{ kind: 'text', exact: 'old words' }],
  }
  const { service } = fixture(t, { facts: { ok: true, url: 'https://example.com/new', title: 'New' } })
  const outcome = await service.capture({ sessionId: 'session-1', browserSessionId: 'session-1', frozenCapture: frozen })
  assert.equal(outcome.reference, undefined, 'a different document must not become a quote of the old text')
  assert.ok(outcome.failures.some(failure => failure.reason === 'page-changed'), JSON.stringify(outcome.failures))
})

test('a capture with no page address is refused, because it could never be revealed', async t => {
  const { service } = fixture(t, {
    capture: { ok: true, url: '', title: 'no address', events: [{ kind: 'text', exact: 'quoted', prefix: '', suffix: '' }] },
  })
  const outcome = await service.capture({ sessionId: 'session-1' })
  assert.equal(outcome.reference, undefined)
  assert.equal(outcome.failures[0].reason, 'page-url-missing')
})

test('an asset sidecar is a complete JSON file and leaves no temporary file behind', async t => {
  const { readdirSync } = await import('node:fs')
  const { page, service, assets } = fixture(t)
  page.capture = {
    ok: true, url: 'https://example.com/article', title: 'An article',
    events: [{ kind: 'image', src: 'https://example.com/a.png', currentSrc: 'https://example.com/a.png', path: [1] }],
  }
  const outcome = await service.capture({ sessionId: 'session-1' })
  assert.ok(outcome.reference)
  const key = outcome.reference.parts[0].assetKey
  // The sidecar is written with temp + renameSync, so /asset can never observe
  // a half-written JSON; a fresh capture must find a fully parseable file.
  const meta = JSON.parse(readFileSync(join(assets, `${key}.json`), 'utf8'))
  assert.equal(meta.assetKey, key)
  assert.equal(meta.mime, 'image/png')
  // `.tmp` is also the NAME OF A DIRECTORY used for in-flight downloads; only
  // stray FILES count as a leaked atomic-write temporary.
  const leftovers = readdirSync(assets, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.tmp'))
  assert.equal(leftovers.length, 0,
    'the temporary file is renamed away, not left beside the sidecar')
})
