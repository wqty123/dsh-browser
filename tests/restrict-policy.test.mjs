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
  'dsh_browser_a11y', 'dsh_browser_auth', 'dsh_browser_back', 'dsh_browser_challenge',
  'dsh_browser_check', 'dsh_browser_clear', 'dsh_browser_click', 'dsh_browser_close_tab',
  'dsh_browser_content', 'dsh_browser_download', 'dsh_browser_execute', 'dsh_browser_fill',
  'dsh_browser_forward', 'dsh_browser_get_value', 'dsh_browser_history', 'dsh_browser_key',
  'dsh_browser_list_tabs', 'dsh_browser_open', 'dsh_browser_refresh', 'dsh_browser_replay',
  'dsh_browser_reset', 'dsh_browser_reset_session', 'dsh_browser_restrict', 'dsh_browser_scrape',
  'dsh_browser_screenshot', 'dsh_browser_scroll', 'dsh_browser_select', 'dsh_browser_session',
  'dsh_browser_set_value', 'dsh_browser_snapshot', 'dsh_browser_switch_tab', 'dsh_browser_type',
  'dsh_browser_visited', 'dsh_browser_wait',
]

test('the read-only set contains only tools that exist', () => {
  // A name that is not a registered tool is dead weight, and it hides the fact that the
  // tool it was meant to cover is missing.
  for (const name of READ_ONLY_TOOLS) {
    assert.ok(REGISTERED.includes(name), `${name} is in READ_ONLY_TOOLS but is not a registered tool`)
  }
})

// dsh_browser_auth is deliberately absent: it is a two-action tool whose "restore" WRITES
// cookies to arbitrary domains, so exempting it would let a task that restricted its own
// actions still rewrite the shared browser state. "flush" alone would qualify, but a tool
// is exempt or not — the action is what the allow-list governs.
test('every observing tool is exempt from an allow-list', () => {
  // Restricting what the agent may DO must not blind it: the tools that only look must
  // survive any allow-list.
  const observing = [
    'dsh_browser_snapshot', 'dsh_browser_a11y', 'dsh_browser_content', 'dsh_browser_scrape', 'dsh_browser_screenshot',
    'dsh_browser_get_value', 'dsh_browser_wait', 'dsh_browser_challenge', 'dsh_browser_list_tabs',
    'dsh_browser_session', 'dsh_browser_history', 'dsh_browser_visited',
  ]
  for (const name of observing) {
    assert.ok(READ_ONLY_TOOLS.has(name), `${name} observes, so it must never be blocked`)
  }
})

test('the tools that undo a restriction are exempt', () => {
  // Without these, a task that restricted everything could neither recover nor be
  // released — the allow-list would be a trap rather than a guard.
  for (const name of ['dsh_browser_restrict', 'dsh_browser_reset_session', 'dsh_browser_reset']) {
    assert.ok(READ_ONLY_TOOLS.has(name), `${name} must stay usable to escape a restriction`)
  }
})

test('acting tools are NOT exempt, or the allow-list would do nothing', () => {
  for (const name of ['dsh_browser_open', 'dsh_browser_click', 'dsh_browser_type', 'dsh_browser_fill', 'dsh_browser_execute', 'dsh_browser_download']) {
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
