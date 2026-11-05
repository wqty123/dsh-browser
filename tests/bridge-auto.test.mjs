// The automatic bridge install: is it allowed right now, and does the record stop a restart loop.
//
// The install itself is `runBridgeAction` (the same code the panel's button runs), so what is worth
// testing here is the decision — above all that a failing install cannot turn every launch into a
// restart, and that a desktop UPDATE re-arms the attempt.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AUTO_INSTALL_COOLDOWN_MS,
  autoInstallDecision,
  autoInstallMarkerPath,
  readAutoInstallMarker,
  writeAutoInstallMarker,
} from '../lib/browser-electron/bridge-auto.js'

/** A status the panel could show. */
function status(overrides = {}) {
  return {
    state: 'stale',
    present: true,
    archivePresent: true,
    version: '0.2.2-alpha.3',
    detail: 'the desktop is packed',
    ...overrides,
  }
}

/** A decision input with everything allowed. */
function input(overrides = {}) {
  return {
    installRoot: 'C:\\DSH Desktop',
    enabled: true,
    status: status(),
    marker: undefined,
    cooldownMs: AUTO_INSTALL_COOLDOWN_MS,
    now: Date.parse('2026-11-05T00:00:00Z'),
    ...overrides,
  }
}

test('a stale bridge on a verifiable desktop install is installed automatically', () => {
  const decision = autoInstallDecision(input())
  assert.equal(decision.run, true)
  assert.match(decision.why, /installing it once for this build/)
})

test('nothing happens on the web end, or when the switch is off', () => {
  assert.equal(autoInstallDecision(input({ installRoot: undefined })).run, false)
  assert.match(autoInstallDecision(input({ installRoot: undefined })).why, /no DSH Desktop/)
  assert.equal(autoInstallDecision(input({ enabled: false })).run, false)
})

test('an installed bridge is left alone', () => {
  assert.equal(autoInstallDecision(input({ status: status({ state: 'installed' }) })).run, false)
})

test('a directory that is not DSH Desktop is not patched', () => {
  assert.equal(autoInstallDecision(input({ status: status({ present: false }) })).run, false)
})

test('the same build is attempted once, so a failure cannot become a restart loop', () => {
  const marker = { build: '0.2.2-alpha.3', attemptedAt: '2026-11-04T23:00:00Z', outcome: 'started' }
  const decision = autoInstallDecision(input({ marker }))
  assert.equal(decision.run, false)
  assert.match(decision.why, /already attempted for this build/)
})

test('a desktop update re-arms the attempt, because that is when the bridge is lost again', () => {
  const marker = { build: '0.2.2-alpha.1', attemptedAt: '2026-11-04T23:00:00Z', outcome: 'failed' }
  assert.equal(autoInstallDecision(input({ marker })).run, true)
})

test('the cooldown expires, so a fixed network gives the plugin another chance', () => {
  const marker = {
    build: '0.2.2-alpha.3',
    attemptedAt: new Date(Date.parse('2026-11-05T00:00:00Z') - AUTO_INSTALL_COOLDOWN_MS - 1_000).toISOString(),
    outcome: 'failed',
  }
  assert.equal(autoInstallDecision(input({ marker })).run, true)
})

test('the record survives a round trip and treats a corrupt file as absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-auto-bridge-'))
  try {
    const path = autoInstallMarkerPath(dir)
    assert.equal(readAutoInstallMarker(path), undefined, 'nothing recorded yet')
    writeAutoInstallMarker(path, { build: '0.2.2-alpha.3', attemptedAt: '2026-11-05T00:00:00.000Z', outcome: 'started' })
    assert.deepEqual(readAutoInstallMarker(path), {
      build: '0.2.2-alpha.3',
      attemptedAt: '2026-11-05T00:00:00.000Z',
      outcome: 'started',
    })
    writeFileSync(path, '{ not json', 'utf8')
    assert.equal(readAutoInstallMarker(path), undefined, 'a broken record must not block a real install')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
