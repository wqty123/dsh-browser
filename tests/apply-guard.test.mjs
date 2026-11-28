// The client half must refuse a repeated registration instead of half-applying it (issue #132).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApplyGuard } from '../src/client/apply-guard.ts'

test('the same context is registered once, and a new one is not refused', () => {
  const guard = createApplyGuard()
  const first = {}
  assert.equal(guard(first), true, 'the first pass applies')
  assert.equal(guard(first), false, 'a repeated pass on the same context is refused')
  assert.equal(guard({}), true, 'a different context still gets its registrations')
})

test('a new module instance has its own guard, so the self-update path still registers', () => {
  const context = {}
  const before = createApplyGuard()
  assert.equal(before(context), true)
  // A fresh bundle is a fresh module: its guard has never seen this context.
  assert.equal(createApplyGuard()(context), true)
})