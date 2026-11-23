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
import { conventionalInstallRoots, registeredInstallLocations } from '../desktop-bridge/desktop-discovery.mjs'

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
  const names = ['DSH_DESKTOP_PATH', 'DSH_DESKTOP_APP', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'APPDATA', 'ProgramData']
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
      withEnv(base, { ProgramFiles: join(base, 'ProgramFilesRoot') }, () => findDesktopInstall(undefined, () => [])),
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
    assert.equal(withEnv(base, { ProgramFiles: programs }, () => findDesktopInstall(undefined, () => [])), actual)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('an unreadable archive and a product-named executable are not identity evidence', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-discover-invalid-'))
  try {
    const root = fakeInstall(join(base, 'Elsewhere'))
    writeFileSync(join(root, 'resources', 'app.asar'), 'not an archive')
    assert.equal(withEnv(base, { DSH_DESKTOP_PATH: root }, () => findDesktopInstall(undefined, () => [], () => [])), undefined)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

/** A macOS `.app` bundle: the same archive, under Contents/Resources. */
function fakeBundle(parent, name = 'DeepSeek Harness.app') {
  const root = join(parent, name)
  mkdirSync(join(root, 'Contents', 'Resources'), { recursive: true })
  mkdirSync(join(root, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(join(root, 'Contents', 'Info.plist'), '<plist/>')
  writeFileSync(join(root, 'Contents', 'MacOS', 'DeepSeek Harness'), 'x')
  writeAsar(join(root, 'Contents', 'Resources', 'app.asar'), {
    'package.json': JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: '0.2.2-test', main: 'lib/main.js' }),
    'lib/main.js': MAIN_BODY,
  })
  return root
}

test('a macOS .app bundle is found by identity under Contents/Resources', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-discover-bundle-'))
  try {
    const parent = join(base, 'Applications')
    const root = fakeBundle(parent)
    assert.equal(withEnv(base, { DSH_DESKTOP_PATH: parent }, () => findDesktopInstall()), root)
    assert.equal(withEnv(base, { DSH_DESKTOP_PATH: root }, () => findDesktopInstall()), root)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

for (const parent of [false, true]) test(`DSH_DESKTOP_APP discovers an install (parent=${parent})`, t => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-discover-alias-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const directory = join(base, 'Apps'), root = fakeInstall(directory)
  assert.equal(withEnv(base, { DSH_DESKTOP_APP: parent ? directory : root }, () => findDesktopInstall()), root)
})

for (const source of ['registry', 'conventions']) test(`${source} discovery verifies candidates and preserves usual-root precedence`, t => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-discover-source-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const root = fakeInstall(join(base, 'Elsewhere'))
  const impostor = fakeInstall(join(base, 'Foreign'), 'DSH Desktop', 'unrelated-app')
  const sources = source === 'registry' ? [() => [join(base, 'missing'), impostor, root], () => []]
    : [() => [], () => [join(base, 'missing'), impostor, root]]
  assert.equal(withEnv(base, {}, () => findDesktopInstall(undefined, ...sources)), root)
  const usual = fakeInstall(join(base, 'Usual'))
  assert.equal(withEnv(base, { ProgramFiles: join(base, 'Usual') }, () => findDesktopInstall(undefined, ...sources)), usual)
  assert.equal(withEnv(base, {}, () => findDesktopInstall(undefined, () => [impostor], () => [impostor])), undefined)
})

test('empty and throwing discovery sources do not escape or prevent the next source', t => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-discover-errors-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const root = fakeInstall(join(base, 'Elsewhere'))
  const denied = () => { throw Error('unavailable') }
  assert.equal(withEnv(base, {}, () => findDesktopInstall(undefined, () => [], () => [])), undefined)
  assert.equal(withEnv(base, {}, () => findDesktopInstall(undefined, denied, denied)), undefined)
  assert.equal(withEnv(base, {}, () => findDesktopInstall(undefined, denied, () => [root])), root)
})

test('registry parsing accepts only InstallLocation and tolerates inaccessible keys', () => {
  const calls = []
  const query = (command, args, options) => {
    calls.push({ command, args, options })
    if (calls.length === 1) throw Error('denied')
    return '    DisplayName    REG_SZ    DeepSeek Harness\r\n    InstallLocation    REG_SZ    E:\\Apps\\DeepSeek Harness  \r\n'
  }
  assert.deepEqual(registeredInstallLocations('win32', query), ['E:\\Apps\\DeepSeek Harness', 'E:\\Apps\\DeepSeek Harness'])
  assert.equal(calls.length, 3)
  assert.ok(calls.every(call => call.command === 'reg' && call.options.windowsHide && call.options.timeout === 15000))
  assert.deepEqual(registeredInstallLocations('linux', () => { throw Error('must not query') }), [])
  assert.deepEqual(registeredInstallLocations('win32', () => ''), [])
})

test('platform conventions retain bundle roots and Linux system and per-user locations', () => {
  assert.deepEqual(conventionalInstallRoots('win32', '/home/test'), [])
  assert.ok(conventionalInstallRoots('darwin', '/home/test').includes(join('/home/test', 'Applications', 'DSH Desktop.app')))
  const linux = conventionalInstallRoots('linux', '/home/test')
  for (const base of ['/opt', '/usr/lib', '/home/test/.local/share']) {
    assert.ok(linux.includes(join(base, 'DeepSeek Harness')))
  }
  assert.equal(conventionalInstallRoots('linux', '').length, 4)
})

test('injected conventions discover macOS bundles without changing their root', t => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-discover-macos-source-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const root = fakeBundle(join(base, 'Applications'))
  assert.equal(withEnv(base, {}, () => findDesktopInstall(undefined, () => [], () => [root])), root)
})
