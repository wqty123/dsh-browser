import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nativeMainReveal } from './fixtures/native-main-reveal.mjs'

test('the shipped Desktop main entry starts the bridge needed for source-bound reveal after restart', async t => {
  const snapshot = {
    version: 1, provider: 'dsh-browser', referenceId: 'native-reveal',
    owner: { sessionId: 'owner', browserSessionId: 'closed-session' },
    provenance: { origin: 'user-selection', entry: 'page-overlay' },
    source: { pageUrl: 'https://www.runoob.com/html/html-lists.html', title: 'Lists', carrier: 'sidebar', capturedAt: new Date().toISOString() },
    parts: [{ partId: 'text', type: 'text', text: 'selected words', anchor: { exact: 'selected words', prefix: 'before ', suffix: ' after' } }],
  }
  const live = { url: snapshot.source.pageUrl, ready: true, highlighted: false }
  const backend = await nativeMainReveal(snapshot, live)
  t.after(() => backend.close())
  const initial = await backend.post({ referenceId: snapshot.referenceId })
  assert.equal(initial.status, 'session-unavailable')
  const request = { referenceId: snapshot.referenceId, sourcePageId: '2' }
  const missing = await backend.post(request)
  assert.equal(missing.status, 'unavailable')
  assert.equal(missing.note, 'sidebar page binding unavailable')
  assert.equal(live.highlighted, false)
  await backend.start()
  const outcome = await backend.post(request)
  assert.equal(outcome.status, 'revealed', JSON.stringify(outcome))
  assert.equal(live.highlighted, true)
  assert.equal(backend.commands.length, 3)
  assert.equal((await backend.post({ referenceId: 'unknown', sourcePageId: '2' })).status, 'not-found')
})
