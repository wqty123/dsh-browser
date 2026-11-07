// Bridge installation remains explicit maintenance with Desktop closed. Historical automatic
// settings and attempt records must never reactivate a runtime installer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsStore } from '../lib/browser-electron/settings-store.js'

import {
  AUTO_INSTALL_COOLDOWN_MS,
  autoInstallDecision,
  autoInstallMarkerPath,
  BridgeAutoInstallPreferenceError,
  readAutoInstallMarker,
  readAutoInstallProfile,
  runWithManualBridgePreference,
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
    profile: 'desktop',
    channel: 'sidebar',
    quiet: false,
    installRoot: 'C:\\DSH Desktop',
    enabled: true,
    status: status(),
    marker: undefined,
    cooldownMs: AUTO_INSTALL_COOLDOWN_MS,
    now: Date.parse('2026-11-05T00:00:00Z'),
    ...overrides,
  }
}

test('runtime bridge installation stays disabled even with an explicit legacy opt-in', () => {
  const decision = autoInstallDecision(input())
  assert.equal(decision.run, false)
  assert.match(decision.why, /close DSH Desktop/i)
})

test('finding Desktop on disk does not let Web, CLI or unknown profiles restart it', () => {
  for (const profile of ['web', 'cli', 'spec', undefined]) {
    const decision = autoInstallDecision(input({ profile }))
    assert.equal(decision.run, false, String(profile))
    assert.match(decision.why, /runtime automatic bridge installation is disabled/)
  }
})

test('every browser and quiet-mode combination keeps runtime installation disabled', () => {
  for (const channel of ['chrome', 'edge', 'bundled', 'sidebar', 'auto']) {
    for (const quiet of [true, false]) {
      for (const enabled of [true, false]) {
        const decision = autoInstallDecision(input({ channel, quiet, enabled }))
        assert.equal(decision.run, false, JSON.stringify({ channel, quiet, enabled }))
        assert.match(decision.why, /run bridge maintenance explicitly/)
      }
    }
  }
})

test('surface identity comes from the launcher profile service', () => {
  const calls = []
  assert.equal(readAutoInstallProfile({ get(name) { calls.push(name); return { name: 'desktop' } } }), 'desktop')
  assert.deepEqual(calls, ['profileContext'])
  assert.equal(readAutoInstallProfile({ get: () => ({ name: 'web' }) }), 'web')
  for (const context of [undefined, {}, { get: () => undefined }, { get: () => ({ name: 1 }) }, { get() { throw Error('disposed') } }]) {
    assert.equal(readAutoInstallProfile(context), undefined)
  }
})

test('manual uninstall records the opt-out before its installer starts maintenance', async () => {
  const calls = []
  let enabled = true
  const result = await runWithManualBridgePreference('uninstall', patch => {
    calls.push('persist')
    enabled = patch.bridge.autoInstall
  }, async () => {
    calls.push('installer')
    assert.equal(enabled, false, 'subsequent desktop loads already see the opt-out')
    assert.equal(autoInstallDecision(input({ enabled })).run, false)
    return { ok: true }
  })
  assert.deepEqual(calls, ['persist', 'installer'])
  assert.deepEqual(result, { ok: true })
})

test('manual install and a failed uninstall preserve the explicit automatic-install opt-out', async () => {
  let enabled = false
  let writes = 0
  const update = patch => { enabled = patch.bridge.autoInstall; writes += 1 }
  await runWithManualBridgePreference('install', update, async () => ({ ok: true }))
  assert.equal(enabled, false)
  assert.equal(writes, 0, 'installing explicitly does not enable automatic restarts')
  const failure = { ok: false, error: 'archive locked' }
  assert.equal(await runWithManualBridgePreference('uninstall', update, async () => failure), failure)
  assert.equal(enabled, false, 'an installer failure does not undo the operator preference')
  assert.equal(writes, 1)
})

test('failure to persist the uninstall preference prevents the installer from starting', async () => {
  const cause = Error('settings directory is read-only')
  let ran = false
  await assert.rejects(runWithManualBridgePreference('uninstall', () => { throw cause }, async () => { ran = true }), error => {
    assert.ok(error instanceof BridgeAutoInstallPreferenceError)
    assert.match(error.message, /could not save.*read-only/)
    assert.equal(error.cause, cause)
    return true
  })
  assert.equal(ran, false)
})

test('the uninstall opt-out is readable by a fresh settings store before installer execution', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-manual-bridge-'))
  try {
    const path = join(dir, 'settings.json')
    const store = new SettingsStore(path)
    store.update({ bridge: { autoInstall: true } })
    assert.equal(store.get().bridge.autoInstall, true, 'simulate an existing legacy opt-in')
    await runWithManualBridgePreference('uninstall', patch => store.update(patch), async () => {
      assert.equal(new SettingsStore(path).get().bridge.autoInstall, false)
    })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a real settings write failure leaves the installer unstarted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-manual-bridge-failure-'))
  try {
    const blocker = join(dir, 'not-a-directory')
    writeFileSync(blocker, 'block settings writes')
    const store = new SettingsStore(join(blocker, 'settings.json'))
    let ran = false
    await assert.rejects(runWithManualBridgePreference('uninstall', patch => store.update(patch), async () => { ran = true }), error => {
      assert.ok(error instanceof BridgeAutoInstallPreferenceError)
      assert.match(error.message, /settings could not be saved/)
      return true
    })
    assert.equal(ran, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('nothing happens on the web end, or when the switch is off', () => {
  assert.equal(autoInstallDecision(input({ installRoot: undefined })).run, false)
  assert.match(autoInstallDecision(input({ installRoot: undefined })).why, /runtime automatic bridge installation is disabled/)
  assert.equal(autoInstallDecision(input({ enabled: false })).run, false)
})

test('an installed bridge is left alone', () => {
  assert.equal(autoInstallDecision(input({ status: status({ state: 'installed' }) })).run, false)
})

test('a directory that is not DSH Desktop is not patched', () => {
  assert.equal(autoInstallDecision(input({ status: status({ present: false }) })).run, false)
})

test('historical attempt records cannot activate runtime maintenance', () => {
  const marker = { build: '0.2.2-alpha.3', attemptedAt: '2026-11-04T23:00:00Z', outcome: 'started' }
  const decision = autoInstallDecision(input({ marker }))
  assert.equal(decision.run, false)
  assert.match(decision.why, /runtime automatic bridge installation is disabled/)
})

test('a desktop update cannot re-arm runtime installation', () => {
  const marker = { build: '0.2.2-alpha.1', attemptedAt: '2026-11-04T23:00:00Z', outcome: 'failed' }
  assert.equal(autoInstallDecision(input({ marker })).run, false)
})

test('an expired historical cooldown cannot enable runtime installation', () => {
  const marker = {
    build: '0.2.2-alpha.3',
    attemptedAt: new Date(Date.parse('2026-11-05T00:00:00Z') - AUTO_INSTALL_COOLDOWN_MS - 1_000).toISOString(),
    outcome: 'failed',
  }
  assert.equal(autoInstallDecision(input({ marker })).run, false)
})

test('the record survives a round trip and treats a corrupt file as absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-auto-bridge-'))
  try {
    const path = autoInstallMarkerPath(dir)
    assert.equal(readAutoInstallMarker(path), undefined, 'nothing recorded yet')
    assert.equal(writeAutoInstallMarker(path, { build: '0.2.2-alpha.3', attemptedAt: '2026-11-05T00:00:00.000Z', outcome: 'started' }), true)
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

test('an automatic attempt record reports a real write failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-auto-bridge-record-failure-'))
  try {
    const blocker = join(dir, 'not-a-directory')
    writeFileSync(blocker, 'prevent a durable restart-loop guard')
    assert.equal(writeAutoInstallMarker(join(blocker, 'record.json'), {
      build: 'qa', attemptedAt: '2026-11-05T00:00:00.000Z', outcome: 'started',
    }), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
