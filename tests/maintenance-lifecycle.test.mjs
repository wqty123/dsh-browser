import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runMaintenanceLifecycle } from '../lib/browser-electron/maintenance-lifecycle.js'

function fixture(overrides = {}) {
  const calls = []
  const states = []
  const deps = {
    requestQuit: async () => { calls.push('quit') },
    waitUntilClosed: async () => { calls.push('closed') },
    maintain: async () => { calls.push('maintain'); return { ok: true, code: 0, output: 'installed', command: 'fixture' } },
    restart: async () => { calls.push('restart'); return 12345 },
    verify: async (pid, action) => { calls.push(`verify:${pid}:${action}`) },
    publish: async state => { states.push(state) },
    ...overrides,
  }
  return { calls, states, deps }
}

test('explicit installation closes normally, installs, restarts and verifies before success', async () => {
  const f = fixture()
  const result = await runMaintenanceLifecycle('install', f.deps)
  assert.deepEqual(f.calls, ['quit', 'closed', 'maintain', 'restart', 'verify:12345:install'])
  assert.deepEqual(f.states.map(s => s.phase), ['armed', 'closing', 'installing', 'restarting', 'verifying', 'completed'])
  assert.equal(result.ok, true)
  assert.equal(result.restarted, true)
})

test('missing quit capability never installs or restarts', async () => {
  const f = fixture({ requestQuit: async () => { throw new Error('official Quit menu unavailable') } })
  const result = await runMaintenanceLifecycle('install', f.deps)
  assert.equal(result.phase, 'cancelled')
  assert.equal(result.restarted, false)
  assert.deepEqual(f.calls, [])
})

test('cancelled or timed-out native quit never installs or restarts', async () => {
  const f = fixture({ waitUntilClosed: async () => { throw new Error('Desktop remains open') } })
  const result = await runMaintenanceLifecycle('install', f.deps)
  assert.equal(result.phase, 'cancelled')
  assert.deepEqual(f.calls, ['quit'])
  assert.match(result.error, /remains open/)
})

test('installer failure reopens Desktop and preserves the failure', async () => {
  const f = fixture({ maintain: async () => ({ ok: false, code: 1, output: 'archive damaged', command: 'fixture' }) })
  const result = await runMaintenanceLifecycle('install', f.deps)
  assert.equal(result.phase, 'failed')
  assert.equal(result.ok, false)
  assert.equal(result.restarted, true)
  assert.match(result.error, /archive damaged/)
  assert.deepEqual(f.calls, ['quit', 'closed', 'restart', 'verify:12345:uninstall'])
})

test('a spawned Desktop without a working new bridge cannot be reported installed', async () => {
  const f = fixture({ verify: async () => { throw new Error('bridge handshake failed') } })
  const result = await runMaintenanceLifecycle('install', f.deps)
  assert.equal(result.phase, 'failed')
  assert.equal(result.restarted, true)
  assert.match(result.error, /handshake failed/)
})

test('uninstall is verified as an uninstall after the same safe lifecycle', async () => {
  const f = fixture()
  const result = await runMaintenanceLifecycle('uninstall', f.deps)
  assert.equal(result.ok, true)
  assert.equal(f.calls.at(-1), 'verify:12345:uninstall')
})
test('failure to save a post-quit progress update cannot prevent recovery or restart', async () => {
  for (const phase of ['closing', 'installing', 'restarting', 'verifying']) {
    const f = fixture({ publish: async state => { if (state.phase === phase) throw new Error('disk unavailable') } })
    const result = await runMaintenanceLifecycle('install', f.deps)
    assert.equal(result.phase, 'failed')
    assert.equal(result.restarted, true)
    assert.ok(f.calls.includes('maintain'))
    assert.ok(f.calls.includes('restart'))
    assert.match(result.error, /progress could not be saved/)
  }
})
test('failure to persist armed state prevents all Desktop actions', async () => {
  const f = fixture({ publish: async () => { throw new Error('disk unavailable') } })
  await assert.rejects(runMaintenanceLifecycle('install', f.deps), /disk unavailable/)
  assert.deepEqual(f.calls, [])
})
