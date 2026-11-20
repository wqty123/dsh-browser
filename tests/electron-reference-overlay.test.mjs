import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { installReferenceOverlay } from '../src/client/electron/reference-overlay.ts'
import { captureReferenceIntent } from '../src/client/reference-intents.ts'

const tick = () => new Promise(resolve => setImmediate(resolve))

test('installs a standalone overlay and drains the live document queue in order', async () => {
  const controller = new AbortController()
  const queue = [{ comment: 'quote' }, { comment: 'comment' }]
  const received = []
  let calls = 0
  installReferenceOverlay(async source => {
    calls++
    if (calls === 1) {
      assert.doesNotThrow(() => new vm.Script(source))
      assert.ok(source.includes('引用到 DSH'))
      return undefined
    }
    return vm.runInNewContext(source, { window: { __dshRefTake: () => queue.shift() } })
  }, intent => received.push(intent), controller.signal)
  await tick()
  controller.abort()
  assert.deepEqual(received, [{ comment: 'quote' }, { comment: 'comment' }])
  assert.equal(calls, 2)
})

test('empty queues and navigation errors do not deliver; malformed results are reported', async () => {
  for (const result of ['[]', 'invalid JSON', '{}', '[null, 3]']) {
    const controller = new AbortController()
    let calls = 0
    const notices = []
    const warnings = []
    const warn = console.warn
    console.warn = (...args) => warnings.push(args)
    try {
      installReferenceOverlay(async source => {
        if (++calls === 1) throw new Error('document navigated')
        if (source.includes('__dsh-ref-notice')) { notices.push(source); return undefined }
        return result
      }, () => assert.fail('unexpected intent'), controller.signal)
      await tick()
      assert.equal(notices.length, result === '[null, 3]' ? 2 : 0)
      assert.equal(warnings.length, result === '[]' ? 0 : result === '[null, 3]' ? 2 : 1)
      assert.equal(calls, 2 + notices.length)
    } finally { controller.abort(); console.warn = warn }
  }
})

test('dropping a guest delivers an already taken intent and stops polling', async () => {
  const controller = new AbortController()
  let resolveDrain
  let calls = 0
  const received = []
  installReferenceOverlay(async () => {
    if (++calls === 1) return undefined
    return new Promise(resolve => { resolveDrain = resolve })
  }, intent => received.push(intent), controller.signal)
  await tick()
  controller.abort()
  resolveDrain('[{"comment":"stale"}]')
  await new Promise(resolve => setTimeout(resolve, 350))
  assert.equal(calls, 2)
  assert.deepEqual(received, [{ comment: 'stale' }])
})

test('shared capture uses the owning session and reports missing owners and transport errors', async () => {
  const original = globalThis.fetch
  const requests = []
  try {
    globalThis.fetch = async (...args) => { requests.push(args); throw new Error('offline') }
    await assert.rejects(captureReferenceIntent({ comment: 'quote', sessionId: 'untrusted' }, 'owner'), /offline/)
    await assert.rejects(captureReferenceIntent({ comment: 'empty session' }, ''), /owner is unavailable/)
    assert.equal(requests.length, 1)
    assert.equal(requests[0][0], '/dsh-builtin-browser/reference/capture')
    assert.equal(requests[0][1].method, 'POST')
    assert.equal(requests[0][1].credentials, 'include')
    assert.deepEqual(JSON.parse(requests[0][1].body), { comment: 'quote', sessionId: 'owner' })
  } finally { globalThis.fetch = original }
})

test('shared capture rejects HTTP and application failures, and accepts only a successful capture', async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async () => ({ ok: false, status: 403 })
    await assert.rejects(captureReferenceIntent({}, 'owner'), /403/)
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: false }) })
    await assert.rejects(captureReferenceIntent({}, 'owner'), /not accepted/)
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) })
    await captureReferenceIntent({}, 'owner')
  } finally { globalThis.fetch = original }
})

test('a failed submission shows a notice in the originating document', async () => {
  const controller = new AbortController()
  const scripts = []
  const warn = console.warn
  try {
    console.warn = () => {}
    installReferenceOverlay(async source => {
      scripts.push(source)
      return scripts.length === 2 ? '[{"comment":"quote"}]' : undefined
    }, async () => { throw new Error('capture refused') }, controller.signal)
    await tick()
    assert.equal(scripts.length, 3)
    assert.match(scripts[2], /__dsh-ref-notice/)
    assert.match(scripts[2], /引用未能加入当前会话/)
  } finally { controller.abort(); console.warn = warn }
})
