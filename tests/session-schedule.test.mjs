// The dock reports a Session on every render; the scheduler must collapse those reports so two live
// docks cannot switch the runtime back and forth inside a render cycle (issue #127).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSessionScheduler } from '../src/client/reference/client/session-schedule.ts'

function harness() {
  const applied = []
  const tasks = []
  const report = createSessionScheduler(id => applied.push(id), task => tasks.push(task))
  return { applied, tasks, report, flush: () => { for (const task of tasks.splice(0)) task() } }
}

test('two docks reporting different sessions in one render tick switch once', () => {
  const h = harness()
  h.report('session-a')
  h.report('session-b')
  h.report('session-a')
  assert.equal(h.applied.length, 0, 'nothing switches during render')
  h.flush()
  assert.deepEqual(h.applied, ['session-a'], 'only the last report of the tick is applied')
})

test('a repeated report of the same session does not schedule another switch', () => {
  const h = harness()
  h.report('session-a')
  h.report('session-a')
  assert.equal(h.tasks.length, 1, 'the same session is coalesced')
  h.flush()
  h.report('session-a')
  h.flush()
  assert.deepEqual(h.applied, ['session-a'], 'an already-applied session is a no-op')
})

test('a later tick still applies a new session', () => {
  const h = harness()
  h.report('session-a')
  h.flush()
  h.report('session-b')
  h.flush()
  assert.deepEqual(h.applied, ['session-a', 'session-b'])
})
