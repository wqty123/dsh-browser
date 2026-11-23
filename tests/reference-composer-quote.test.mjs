import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createProductionRuntime } from '../src/client/reference/client/production/runtime.ts'
import { composerReference } from '../src/client/reference/client/production/production-submission.ts'
import { createAssetStore } from '../src/client/reference/client/production/asset-store.ts'
import { toOrderedGroup } from '../src/client/reference/client/production/snapshot-adapter.ts'
import { createBrowserSourceRule, browserSourceRule } from '../src/client/reference/client/production/user-text-rule.ts'
import { attachImages } from '../src/client/reference/client/production/composer-attachments.ts'
import {
  ASSET_MAP, FakeReferenceHttp, LONG_TEXT, TAIL_TEXT, assetOf, deliveriesResponse, makeDelivery, makeSnapshot, memoryKV,
} from '../src/client/reference/client/__tests__/production.fixtures.ts'

// `formatQuoteText` from @deepseek-ai/dsh-client-ui-primitives 0.2.2-rc.5 and 0.2.3-alpha.2: a quote
// node's text is sent with every line prefixed by `> `.
const formatQuoteText = text => text.replace(/\r\n?/gu, '\n').split('\n').map(line => `> ${line}`).join('\n')

/**
 * The stock composer of 0.2.2-rc.5 / 0.2.3-alpha.2: quotes are editor nodes, images are draft attachments,
 * and the send is `[...await serializeAttachments(), { type: 'text', text }]` — no plugin call in between.
 */
function stockComposer(typed) {
  const quotes = []
  const attachments = []
  const face = {
    captureInsertion: () => ({ start: typed.length, end: typed.length, draftRev: 1 }),
    insertText: () => false,
    persistDraft() {},
    readText: () => [...quotes.map(formatQuoteText), typed].join(' '),
    insertQuote: text => { quotes.push(text); return true },
    attachImages: images => images.map(image => {
      const id = `draft-${attachments.length}`
      attachments.push({ id, part: { type: 'image', mediaType: image.binding.mime, data: image.binding.data } })
      return id
    }),
    removeAttachments: ids => { attachments.splice(0, attachments.length, ...attachments.filter(entry => !ids.includes(entry.id))) },
  }
  const send = () => {
    const text = [...quotes.map(quote => `${formatQuoteText(quote)} `), typed].join('')
    return [...attachments.map(entry => entry.part), ...text === '' ? [] : [{ type: 'text', text }]]
  }
  return { face, quotes, attachments, send }
}

async function captured(typed = '这张表的第二行是什么？') {
  const http = new FakeReferenceHttp()
  http.assets = Object.fromEntries(Object.entries(ASSET_MAP).map(([key, bytes]) => [key, assetOf(key, bytes)]))
  const composer = stockComposer(typed)
  const runtime = createProductionRuntime({
    http, storage: memoryKV(), initialSessionId: 'sess-A', hostInputFor: () => composer.face, now: () => 1700000000000,
  })
  http.enqueue(deliveriesResponse([makeDelivery({ state: 'acknowledged', sequence: 1 })], 1))
  await runtime.pollOnce()
  return { runtime, composer }
}

const occurrences = (text, needle) => text.split(needle).length - 1

test('a captured reference reaches the model through the stock send path, exactly once', async t => {
  const { runtime, composer } = await captured()
  t.after(() => runtime.dispose())
  const content = composer.send()
  const text = content.filter(part => part.type === 'text').map(part => part.text).join('')
  assert.equal(occurrences(text, `${formatQuoteText(LONG_TEXT)}\n`), 1, 'the captured text reaches the model verbatim, once')
  assert.equal(occurrences(text, TAIL_TEXT), 1)
  assert.match(text, /> \| .+ \|\n> \| --- \|/u, 'the table goes to the model as a Markdown table')
  assert.equal(occurrences(text, '<dsh-browser-reference uri="dsh-browser-ref:'), 1)
  assert.ok(text.endsWith('这张表的第二行是什么？'), 'the typed question stays last')
})

test('captured images travel as composer attachments ahead of the text', async t => {
  const { runtime, composer } = await captured()
  t.after(() => runtime.dispose())
  const content = composer.send()
  const images = content.filter(part => part.type === 'image')
  const expected = composerReference(toOrderedGroup(makeSnapshot()), { index: 0, assets: boundAssets() }).images
  assert.ok(expected.length > 0)
  assert.deepEqual(images.map(image => image.data), expected.map(image => image.binding.data))
  assert.equal(content.at(-1).type, 'text')
  const text = content.at(-1).text
  for (const image of expected) assert.equal(occurrences(text, image.partId), 1)
  assert.doesNotMatch(text, /image unavailable/u)
})

test('the plugin publishes no submission seam for the send path to call', async t => {
  const { runtime } = await captured()
  t.after(() => runtime.dispose())
  assert.equal('submission' in runtime, false)
  assert.equal('projectContent' in runtime, false)
  assert.equal(globalThis.__DSH_BROWSER_REF_SUBMISSION__, undefined)
  const assembly = readFileSync(new URL('../src/client/reference/client/production/assembly.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(assembly, /browserReferenceSubmission|__DSH_BROWSER_REF_SUBMISSION__/u)
})

test('the sent bubble shows the capsule in place of the quoted body', async t => {
  const { runtime, composer } = await captured()
  t.after(() => runtime.dispose())
  const text = composer.send().at(-1).text
  const match = browserSourceRule.match(text, 0)
  assert.equal(match.id, 'browser-ref')
  assert.equal(match.start, 0)
  assert.equal(text.slice(match.end), ' 这张表的第二行是什么？')
  assert.match(match.data.uri, /^dsh-browser-ref:/u)

  const evicted = createBrowserSourceRule(() => false).match(text, 0)
  assert.equal(evicted.id, 'text')
  assert.ok(evicted.data.display.includes(TAIL_TEXT), 'an evicted reference keeps its readable body')
  assert.equal(browserSourceRule.match(text, evicted.end).id, 'browser-ref')
})

test('a user quote that is not a composer reference is left alone', () => {
  const text = '> <dsh-browser-quote>\n> 正文\n> 没有闭合标签\n\n问题'
  assert.equal(browserSourceRule.match(text, 0), undefined)
})

test('images go through the host drop path: createDrafts then addAttachments', () => {
  const [image] = composerReference(toOrderedGroup(makeSnapshot()), { index: 0, assets: boundAssets() }).images
  const created = []
  const added = []
  const ctx = {
    get: name => name === 'conversation'
      ? { createDrafts: (sessionId, files, uploadImages) => { created.push({ sessionId, files, uploadImages }); return files.map((_, i) => ({ id: `draft-${i}` })) } }
      : name === 'sessions' ? { binding: () => ({ session: { getSnapshot: () => ({ subagent: null }) } }) } : undefined,
  }
  assert.deepEqual(attachImages(ctx, 'session-1', [image], { addAttachments: ids => { added.push(...ids); return true } }), ['draft-0'])
  assert.deepEqual(added, ['draft-0'])
  const [{ sessionId, files, uploadImages }] = created
  assert.equal(sessionId, 'session-1')
  assert.equal(uploadImages, true)
  assert.equal(files[0].type, image.binding.mime)
  assert.equal(files[0].size, image.binding.bytes)
})

test('a refused attachment is released, not leaked', () => {
  const [image] = composerReference(toOrderedGroup(makeSnapshot()), { index: 0, assets: boundAssets() }).images
  const released = []
  const ctx = { get: name => name === 'conversation'
    ? { createDrafts: (_s, files) => files.map((_, i) => ({ id: `d${i}` })), releaseDraftAttachments: drafts => released.push(...drafts) }
    : undefined }
  assert.deepEqual(attachImages(ctx, 's', [image], { addAttachments: () => false }), [])
  assert.deepEqual(released, [{ id: 'd0' }])
})

function boundAssets() {
  const assets = createAssetStore(memoryKV(), 'sess-A')
  for (const [key, bytes] of Object.entries(ASSET_MAP)) assets.bind(assetOf(key, bytes))
  return assets
}

test('deleting the host quote removes its card, and nothing removed is sent', async t => {
  const { runtime, composer } = await captured()
  t.after(() => runtime.dispose())
  const session = runtime.currentSessionId()
  runtime.noteDraft(session, composer.face.readText())
  assert.equal(runtime.cards().length, 1)
  composer.quotes.length = 0
  runtime.noteDraft(session, composer.face.readText())
  assert.equal(runtime.cards().length, 0, 'the card follows the quote the host sends')
  const text = composer.send().filter(part => part.type === 'text').map(part => part.text).join('')
  assert.equal(occurrences(text, LONG_TEXT.split('\n')[0]), 0)
  assert.equal(composer.send().filter(part => part.type === 'image').length, 0, 'its image attachments go with it')
})

test('a card is kept until its quote has been seen in the draft', async t => {
  const { runtime } = await captured()
  t.after(() => runtime.dispose())
  runtime.noteDraft(runtime.currentSessionId(), '这张表的第二行是什么？')
  assert.equal(runtime.cards().length, 1, 'a draft read before the editor applies the quote does not drop the card')
})
