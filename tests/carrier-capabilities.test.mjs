// Tools ask the carrier for one capability instead of testing which carrier a task is on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { assertCapability, CarrierCapabilityError, CDP_CARRIER_CAPABILITIES, WEB_PANEL_CAPABILITIES } from '../lib/browser/types.js'
import { carrierCapabilities, createState, maxWaitFor } from '../lib/tool-browser/state.js'
import * as policy from '../assets/browser-policy.mjs'

test('a missing capability is a structured refusal carrying the guidance', () => {
  assert.doesNotThrow(() => assertCapability(CDP_CARRIER_CAPABILITIES, 'screenshot', 'unused'))
  assert.throws(() => assertCapability(WEB_PANEL_CAPABILITIES, 'screenshot', 'switch to the desktop sidebar'), error => {
    assert.ok(error instanceof CarrierCapabilityError && error instanceof HarnessError)
    assert.equal(error.code, 'BROWSER_CARRIER_CAPABILITY_UNAVAILABLE')
    assert.equal(error.capability, 'screenshot')
    assert.equal(error.message, 'switch to the desktop sidebar')
    return true
  })
})

test('both capability sets name every capability', () => {
  assert.deepEqual(Object.keys(WEB_PANEL_CAPABILITIES).sort(), Object.keys(CDP_CARRIER_CAPABILITIES).sort())
  assert.ok(Object.isFrozen(CDP_CARRIER_CAPABILITIES) && Object.isFrozen(WEB_PANEL_CAPABILITIES))
})

test('a panel placement without a live session is the Web iframe panel', () => {
  const live = new Set(['browser:1'])
  const browser = { exists: session => live.has(session) }
  const state = createState()
  assert.equal(carrierCapabilities(browser, state, 'task'), CDP_CARRIER_CAPABILITIES, 'nothing placed yet')
  state.panelUrlByTask.set('task', 'https://example.com/')
  assert.equal(carrierCapabilities(browser, state, 'task'), WEB_PANEL_CAPABILITIES, 'placed, no session')
  state.sessionsByTask.set('task', 'browser:1')
  assert.equal(carrierCapabilities(browser, state, 'task'), CDP_CARRIER_CAPABILITIES, 'the CDP-backed sidebar')
  live.clear()
  assert.equal(carrierCapabilities(browser, state, 'task'), WEB_PANEL_CAPABILITIES, 'its session closed')
})

test('tool wait budgets come from the browser policy', () => {
  assert.equal(maxWaitFor(policy.TOOL_DEFAULT_TIMEOUT_MS), policy.TOOL_DEFAULT_TIMEOUT_MS - policy.TOOL_WAIT_RESERVE_MS)
  assert.equal(maxWaitFor(1000), policy.TOOL_WAIT_MIN_MS)
})
