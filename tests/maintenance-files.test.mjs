import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renameMaintenanceFile, renameMaintenanceFileSync } from '../desktop-bridge/maintenance-files.mjs'

for (const sync of [false, true]) {
  const replace = sync ? renameMaintenanceFileSync : renameMaintenanceFile
  test(`${sync ? 'sync' : 'async'} maintenance rename retries Windows reader locks with bounded backoff`, async () => {
    for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
      const waits = [], calls = []
      let remaining = 3
      await replace('state.tmp', 'state.json', {
        rename: (source, target) => {
          calls.push([source, target])
          if (remaining-- > 0) throw Object.assign(new Error('reader lock'), { code })
        },
        pause: ms => { waits.push(ms) },
      })
      assert.deepEqual(waits, [20, 40, 80])
      assert.equal(calls.length, 4)
      assert.ok(calls.every(call => call[0] === 'state.tmp' && call[1] === 'state.json'))
    }
  })
  test(`${sync ? 'sync' : 'async'} maintenance rename succeeds immediately and rejects permanent errors`, async () => {
    let calls = 0
    const waits = []
    await replace('a', 'b', { rename: () => { calls++ }, pause: ms => { waits.push(ms) } })
    assert.equal(calls, 1)
    assert.deepEqual(waits, [])
    const error = Object.assign(new Error('missing source'), { code: 'ENOENT' })
    await assert.rejects(async () => replace('a', 'b', { rename: () => { throw error }, pause: ms => { waits.push(ms) } }), e => e === error)
    assert.deepEqual(waits, [])
  })
  test(`${sync ? 'sync' : 'async'} maintenance rename stops retrying a persistent lock`, async () => {
    let calls = 0
    const waits = [], error = Object.assign(new Error('locked'), { code: 'EPERM' })
    await assert.rejects(async () => replace('a', 'b', {
      rename: () => { calls++; throw error }, pause: ms => { waits.push(ms) },
    }), e => e === error)
    assert.equal(calls, 9)
    assert.equal(waits.reduce((a, b) => a + b, 0), 1300)
  })
}

test('completion-write failure does not replace a real maintenance failure', async () => {
  const { runMaintenanceLifecycle } = await import('../lib/browser-electron/maintenance-lifecycle.js')
  const result = await runMaintenanceLifecycle('install', {
    requestQuit: async () => {}, waitUntilClosed: async () => {}, restart: async () => 123,
    verify: async () => {}, maintain: async () => ({ ok: false, output: 'installer failed' }),
    publish: async state => { if (state.phase !== 'armed') throw new Error('locked') },
  })
  assert.equal(result.phase, 'failed')
  assert.match(result.error, /installer failed/)
})
