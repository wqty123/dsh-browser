/**
 * Sidebar guest ownership across a conversation switch.
 *
 * The sidebar reuses ONE guest when the user switches conversations. The host's
 * panel listing is the authority on which conversation that guest belongs to,
 * so `list` must TRANSFER a stale claim. When it did not, the reference pump saw
 * zero pages for the new conversation and the in-page cite bar silently stopped
 * appearing — no error, no card, nothing in any log.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const bridgePath = resolve(dirname(fileURLToPath(import.meta.url)), '../desktop-bridge/plugin-browser-bridge.js')

test('a guest follows the conversation panel that currently shows it', () => {
  const bridge = readFileSync(bridgePath, 'utf8')
  // Every id the host reports for this panel is claimed for this conversation,
  // unconditionally — the previous conversation's claim must move.
  assert.match(bridge, /for \(const id of ids\) \{/u)
  assert.match(bridge, /entry\.owner !== scope\.owner/u)
  assert.match(bridge, /retireHandle\(key\)/u)
  // `list` still has to agree with the transfer, or the guest stays filtered out.
  assert.match(bridge, /bindGuest\(handle, guest\)/u)
})

test('driving a guest still re-registers it when the ledger is cold', () => {
  const bridge = readFileSync(bridgePath, 'utf8')
  assert.match(bridge, /ids\.includes\(Number\(match\[1\]\)\)/u)
  assert.match(bridge, /bindGuest\(request\.handle, guest\)/u)
})
