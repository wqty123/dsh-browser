// N6: pin the read-only promise.
//
// The tool description and both READMEs state that read-only tools are never blocked by an
// allow-list. Nothing tested it, so the promise could be removed — or the restriction
// re-keyed to a single global value — with the suite still green. This asserts what the
// promise actually is, and that no name in the set is a typo.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { READ_ONLY_TOOLS } from '../lib/tool-browser/index.js'

/** Every browser tool this plugin registers. */
const REGISTERED = [
  'browser_a11y', 'browser_auth', 'browser_back', 'browser_challenge',
  'browser_check', 'browser_clear', 'browser_click', 'browser_close_tab',
  'browser_content', 'browser_download', 'browser_execute', 'browser_fill',
  'browser_forward', 'browser_get_value', 'browser_history', 'browser_key',
  'browser_list_tabs', 'browser_open', 'browser_refresh', 'browser_replay',
  'browser_reset', 'browser_reset_session', 'browser_restrict', 'browser_scrape',
  'browser_screenshot', 'browser_scroll', 'browser_select', 'browser_session',
  'browser_set_value', 'browser_snapshot', 'browser_switch_tab', 'browser_type',
  'browser_visited', 'browser_wait',
]

test('the read-only set contains only tools that exist', () => {
  // A name that is not a registered tool is dead weight, and it hides the fact that the
  // tool it was meant to cover is missing.
  for (const name of READ_ONLY_TOOLS) {
    assert.ok(REGISTERED.includes(name), `${name} is in READ_ONLY_TOOLS but is not a registered tool`)
  }
})

// browser_auth is deliberately absent: it is a two-action tool whose "restore" WRITES
// cookies to arbitrary domains, so exempting it would let a task that restricted its own
// actions still rewrite the shared browser state. "flush" alone would qualify, but a tool
// is exempt or not — the action is what the allow-list governs.
test('every observing tool is exempt from an allow-list', () => {
  // Restricting what the agent may DO must not blind it: the tools that only look must
  // survive any allow-list.
  const observing = [
    'browser_snapshot', 'browser_a11y', 'browser_content', 'browser_scrape', 'browser_screenshot',
    'browser_get_value', 'browser_wait', 'browser_challenge', 'browser_list_tabs',
    'browser_session', 'browser_history', 'browser_visited',
  ]
  for (const name of observing) {
    assert.ok(READ_ONLY_TOOLS.has(name), `${name} observes, so it must never be blocked`)
  }
})

test('the tools that undo a restriction are exempt', () => {
  // Without these, a task that restricted everything could neither recover nor be
  // released — the allow-list would be a trap rather than a guard.
  for (const name of ['browser_restrict', 'browser_reset_session', 'browser_reset']) {
    assert.ok(READ_ONLY_TOOLS.has(name), `${name} must stay usable to escape a restriction`)
  }
})

test('acting tools are NOT exempt, or the allow-list would do nothing', () => {
  for (const name of ['browser_open', 'browser_click', 'browser_type', 'browser_fill', 'browser_execute', 'browser_download']) {
    assert.ok(!READ_ONLY_TOOLS.has(name), `${name} is an action and must remain restrictable`)
  }
})

test('the set has no duplicates', () => {
  // A duplicated entry means the real one was probably mistyped somewhere.
  const source = readFileSync(new URL('../src/tool-browser/index.ts', import.meta.url), 'utf8')
  const block = source.slice(source.indexOf('READ_ONLY_TOOLS'), source.indexOf('])', source.indexOf('READ_ONLY_TOOLS')))
  const names = [...block.matchAll(/'([a-z0-9_]+)'/g)].map(m => m[1])
  const seen = new Set()
  for (const name of names) {
    assert.ok(!seen.has(name), `${name} appears twice in the set`)
    seen.add(name)
  }
})
