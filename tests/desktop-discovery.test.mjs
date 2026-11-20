// Finding DSH Desktop when it is not in the default place.
//
// The panel and the installer both used to probe a single root (%LOCALAPPDATA%\Programs), so an
// install on another drive was invisible to both — the panel said "no DSH Desktop here" and the
// automatic repair had nothing to aim at. These tests pin the widened probe, and that the answer
// still depends on the directory actually looking like DSH Desktop.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { findDesktopInstall } from '../lib/browser-electron/bridge-status.js'
import { MAIN_BODY, writeAsar } from './fake-asar.mjs'

/** A packed installation whose archive supplies the actual product identity. */
function fakeInstall(parent, name = 'DSH Desktop', packageName = '@deepseek-ai/dsh-desktop') {
  const root = join(parent, name)
  mkdirSync(join(root, 'resources'), { recursive: true })
  writeFileSync(join(root, 'DeepSeek Harness.exe'), 'x')
  writeAsar(join(root, 'resources', 'app.asar'), {
    'package.json': JSON.stringify({ name: packageName, version: '0.2.2-test', main: 'lib/main.js' }),
    'lib/main.js': MAIN_BODY,
  })
  return root
}

/**
 * Run a body with a controlled environment: every root the probe reads points inside `base`, so a real
 * install on this machine cannot answer instead.
 */
function withEnv(base, extra, body) {
  const names = ['DSH_DESKTOP_PATH', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'APPDATA', 'ProgramData']
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]))
  try {
    for (const name of names) delete process.env[name]
    process.env.LOCALAPPDATA = join(base, 'LocalAppData')
    process.env.ProgramData = join(base, 'ProgramData')
    process.env.APPDATA = join(base, 'Roaming')
    for (const [name, value] of Object.entries(extra)) process.env[name] = value
    return body()
  } finally {
    for (const name of names) {
      const value = saved[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

test('DSH_DESKTOP_PATH names the install directly, wherever it is', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-discover-'))
  try {
    const root = fakeInstall(join(base, 'Apps', 'Something else entirely'))
    assert.equal(withEnv(base, { DSH_DESKTOP_PATH: root }, () => findDesktopInstall()), root)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a parent directory is enough: the probe looks one level down', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-discover-'))
  try {
    const parent = join(base, 'Apps', 'Vendor')
    const root = fakeInstall(parent)
    assert.equal(withEnv(base, { DSH_DESKTOP_PATH: parent }, () => findDesktopInstall()), root)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('Program Files is scanned like %LOCALAPPDATA%\\Programs', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-discover-'))
  try {
    const programs = join(base, 'ProgramFilesRoot')
    const root = fakeInstall(programs, 'Installed Elsewhere')
    assert.equal(withEnv(base, { ProgramFiles: programs }, () => findDesktopInstall()), root)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('the per-user Program Files root also works', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-discover-'))
  try {
    const programs = join(base, 'ProgramFilesX86')
    const root = fakeInstall(programs, 'DSH Desktop')
    assert.equal(withEnv(base, { 'ProgramFiles(x86)': programs }, () => findDesktopInstall()), root)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a directory that is not DSH Desktop is not reported', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-discover-'))
  try {
    const stranger = join(base, 'ProgramFilesRoot', 'Some Electron App')
    mkdirSync(join(stranger, 'resources'), { recursive: true })
    writeFileSync(join(stranger, 'resources', 'app'), 'not an archive')
    assert.equal(
      withEnv(base, { ProgramFiles: join(base, 'ProgramFilesRoot') }, () => findDesktopInstall()),
      undefined,
      'an arbitrary directory must not be offered as DSH Desktop',
    )
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a foreign packed app cannot shadow the real DSH installation in a scanned root', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-discover-shadow-'))
  try {
    const programs = join(base, 'ProgramFilesRoot')
    fakeInstall(programs, 'DSH Desktop', 'unrelated-meeting-app')
    const actual = fakeInstall(programs, 'Verified DSH')
    assert.equal(withEnv(base, { ProgramFiles: programs }, () => findDesktopInstall()), actual)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('an unreadable archive and a product-named executable are not identity evidence', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-discover-invalid-'))
  try {
    const root = fakeInstall(join(base, 'Elsewhere'))
    writeFileSync(join(root, 'resources', 'app.asar'), 'not an archive')
    assert.equal(withEnv(base, { DSH_DESKTOP_PATH: root }, () => findDesktopInstall()), undefined)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
