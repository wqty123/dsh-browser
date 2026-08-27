import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { internals } from '../lib/browser-electron/remote-host.js'

/**
 * Regression for issue #6: resolveElectronPath() used to hand back the host's
 * PACKAGED app executable (e.g. DSH Desktop.exe) as the "electron binary"
 * (step 0 / step 4). Spawning a packaged exe with a script argument launches
 * the app itself and exits immediately (single-instance lock) — the
 * "browser host exited (code=0)" failure. Only a BARE electron (no
 * resources/app.asar beside the binary) can be spawned with a script.
 */
test('isBareElectron: packaged apps are never spawnable as bare electron', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-browser-bare-'))
  try {
    // Packaged app: resources/app.asar present -> NOT bare (even when the exe
    // name carries the product name, like "DSH Desktop.exe", and even when
    // electron.asar is present — packaged apps ship both).
    mkdirSync(join(dir, 'packaged', 'resources'), { recursive: true })
    writeFileSync(join(dir, 'packaged', 'resources', 'app.asar'), 'x')
    writeFileSync(join(dir, 'packaged', 'resources', 'electron.asar'), 'x')
    assert.equal(internals.isBareElectron(join(dir, 'packaged', 'DSH Desktop.exe')), false)
    // An exe NAMED electron but with app.asar is still a packaged app.
    assert.equal(internals.isBareElectron(join(dir, 'packaged', 'electron.exe')), false)
    // Unpacked-app packaged build (resources/app instead of app.asar): same
    // verdict — spawn would launch the app itself.
    mkdirSync(join(dir, 'packaged-unpacked', 'resources', 'app'), { recursive: true })
    assert.equal(internals.isBareElectron(join(dir, 'packaged-unpacked', 'electron.exe')), false)

    // Bare electron: electron.asar / default_app.asar WITHOUT app.asar -> bare.
    mkdirSync(join(dir, 'bare', 'resources'), { recursive: true })
    writeFileSync(join(dir, 'bare', 'resources', 'electron.asar'), 'x')
    assert.equal(internals.isBareElectron(join(dir, 'bare', 'electron.exe')), true)
    writeFileSync(join(dir, 'bare', 'resources', 'default_app.asar'), 'x')
    assert.equal(internals.isBareElectron(join(dir, 'bare', 'electron.exe')), true)

    // Portable single-file build: no resources dir at all -> not bare,
    // even when the name says electron (it cannot run a script argument).
    assert.equal(internals.isBareElectron(join(dir, 'electron.exe')), false)

    // No electron markers at all -> not bare.
    assert.equal(internals.isBareElectron(join(dir, 'plain.exe')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveElectronPath order: override > bundled > anchors > bare host > ancestry, packaged host skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-browser-resolve-'))
  try {
    // A fake BARE electron (resources/electron.asar, no app.asar) — the exe
    // file itself must exist (the resolver checks existsSync on execPath).
    mkdirSync(join(dir, 'bare', 'resources'), { recursive: true })
    writeFileSync(join(dir, 'bare', 'resources', 'electron.asar'), 'x')
    const bareExe = join(dir, 'bare', 'electron.exe')
    writeFileSync(bareExe, 'x')
    // A fake PACKAGED app (resources/app.asar) — must be skipped everywhere.
    mkdirSync(join(dir, 'packaged', 'resources'), { recursive: true })
    writeFileSync(join(dir, 'packaged', 'resources', 'app.asar'), 'x')
    const packagedExe = join(dir, 'packaged', 'DSH Desktop.exe')
    writeFileSync(packagedExe, 'x')

    const impl = (overrides) => internals.resolveElectronPathImpl({
      override: undefined,
      inElectron: false,
      execPath: packagedExe,
      bundled: () => undefined,
      anchored: () => undefined,
      ancestry: () => undefined,
      ...overrides,
    })

    // 0. A valid override (a file that exists) beats every auto-discovery.
    assert.equal(impl({ override: process.execPath, bundled: () => 'bundled-exe' }), process.execPath)
    // 1. Bundled package wins when no override.
    assert.equal(impl({ bundled: () => 'bundled-exe' }), 'bundled-exe')
    // 2. Anchors beat host reuse.
    assert.equal(impl({ inElectron: true, execPath: bareExe, anchored: () => 'anchored-exe' }), 'anchored-exe')
    // 3. In-process host reuse only for a BARE electron.
    assert.equal(impl({ inElectron: true, execPath: bareExe }), bareExe)
    // 4. A PACKAGED host is skipped -> falls through to ancestry.
    assert.equal(impl({ inElectron: true, execPath: packagedExe, ancestry: () => 'ancestor-exe' }), 'ancestor-exe')
    // 5. Not in electron + packaged execPath + no ancestry -> nothing left.
    assert.throws(() => impl({}), /cannot locate/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
