// The publish guard that keeps a tab from waking the dock for an unchanged state (issue #127).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sameFrameState } from '../src/client/browser/frame-state.ts'

const base = () => ({
  navigationId: 3, target: { url: 'https://example.test/a', sandboxed: false },
  address: 'observed', loading: false, canGoBack: true, canGoForward: false, sandboxEnabled: false,
})

test('an unchanged frame state is not published again', () => {
  assert.equal(sameFrameState(base(), base()), true, 'a fresh object with the same values is equal')
})

test('any changed field makes it a publish', () => {
  for (const [key, value] of [['loading', true], ['address', 'unknown'], ['canGoBack', false], ['sandboxEnabled', true], ['navigationId', 4]]) {
    const next = { ...base(), [key]: value }
    assert.equal(sameFrameState(base(), next), false, `${key} must count as a change`)
  }
  const target = { ...base(), target: { url: 'https://example.test/b', sandboxed: false } }
  assert.equal(sameFrameState(base(), target), false, 'a different target is a change')
})

test('a field missing on one side counts as a change', () => {
  const a = { ...base() }
  const b = { ...base() }
  delete b.canGoForward
  assert.equal(sameFrameState(a, b), false)
})