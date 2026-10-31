import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { electronRuntimeDiagnosticLines } from '../lib/browser-electron/runtime-diagnostics.js'
import { internals, RemoteElectronViewHost } from '../lib/browser-electron/remote-host.js'

const stamp = '2026-10-31T06:00:00.000Z'

test('runtime diagnostics identify the running Electron, Chromium and Node versions', () => {
  const lines = electronRuntimeDiagnosticLines({
    electron: '44.10.0', chrome: '152.0.7977.169', node: '24.22.1',
  }, stamp)
  assert.deepEqual(lines, [
    `${stamp} runtime: electron=44.10.0 chromium=152.0.7977.169 node=24.22.1`,
  ])
})

test('44.x versions below the patched release warn without rejecting the runtime', () => {
  for (const electron of ['44.0.0', '44.8.9', '44.9.0', '44.9.1-beta.1']) {
    const lines = electronRuntimeDiagnosticLines({ electron }, stamp)
    assert.equal(lines.length, 2, electron)
    assert.match(lines[1], /security minimum 44\.9\.1.*GHSA-jr5w-w6x2-84p9/, electron)
    assert.match(lines[1], /continuing with the selected runtime/, electron)
    assert.match(lines[1], /ELECTRON_PATH/, electron)
    assert.ok(lines.every(line => line.startsWith(stamp + ' ')), 'all host-log lines are dated')
  }
})

test('the patched stable boundary and newer 44.x releases have no warning', () => {
  for (const electron of ['44.9.1', '44.9.1+custom', '44.9.2', '44.10.0', '44.100.0']) {
    assert.equal(electronRuntimeDiagnosticLines({ electron }, stamp).length, 1, electron)
  }
})

test('other majors, prereleases and unknown versions are unverified, not labelled vulnerable', () => {
  // 43.8.6 is patched for this advisory: a simple numeric <44.9.1 test
  // would falsely call it vulnerable. Compatibility and security differ.
  for (const electron of ['43.8.6', '45.0.0', '44.10.0-beta.1', '', 'unexpected', undefined]) {
    const lines = electronRuntimeDiagnosticLines({ electron }, stamp)
    assert.equal(lines.length, 2, String(electron))
    assert.match(lines[1], /not verified/, String(electron))
    assert.doesNotMatch(lines[1], /GHSA-|security minimum/, String(electron))
    assert.match(lines[1], /continuing with the selected runtime/, String(electron))
  }
  assert.match(electronRuntimeDiagnosticLines({}, stamp)[0], /electron=unknown chromium=unknown node=unknown/)
})

test('an explicit Electron override still wins without running fallback probes', () => {
  const noFallback = () => { throw new Error('override must not probe or install a fallback') }
  assert.equal(internals.resolveElectronPathImpl({
    override: process.execPath,
    inElectron: false,
    execPath: process.execPath,
    bundled: noFallback,
    anchored: noFallback,
    ancestry: noFallback,
  }), process.execPath)
})

// The fixture is deliberately plain Node: test the launch path and source
// reporting without downloading Electron or opening a browser window.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-runtime-log-'))

test('a real spawn records that ELECTRON_PATH selected the executable', async () => {
  const previous = process.env.ELECTRON_PATH
  process.env.ELECTRON_PATH = process.execPath
  const fixture = fileURLToPath(new URL('./fixtures/fake-host-child.mjs', import.meta.url))
  const host = new RemoteElectronViewHost(fixture)
  try {
    const view = host.createView()
    await view.sendCommand('Runtime.evaluate', { expression: '1' })
    const log = readFileSync(join(process.env.DSH_HOME, 'logs', 'dsh-builtin-browser-host.log'), 'utf8')
    assert.match(log, /spawning: electron=.*source=ELECTRON_PATH/, 'the chosen override is named in the launch log')
  } finally {
    host.dispose()
    if (previous === undefined) delete process.env.ELECTRON_PATH
    else process.env.ELECTRON_PATH = previous
  }
})
