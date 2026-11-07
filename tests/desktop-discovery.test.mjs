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
 *
 * `DSH_DESKTOP_APP` and `HOME` are cleared for the same reason — the first is another name for the
 * same question (see `tools/install-web-plugin.mjs`), the second decides the per-user half of the
 * macOS/Linux conventions. A test that asserts "nothing here" must not be answered by the machine.
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

/**
 * The two sources this change adds, closed by default in these fixtures.
 *
 * The registry and the platform conventions are answered by the machine, so a fixture that only
 * controls environment variables would still find a real install — exactly the drift that makes such
 * a test pass on one computer and fail on the next.
 */
const noRegistry = () => []
const noConventions = () => []

test('DSH_DESKTOP_PATH names the install directly, wherever it is', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-discover-'))
  try {
    const root = fakeInstall(join(base, 'Apps', 'Something else entirely'))
    assert.equal(withEnv(base, { DSH_DESKTOP_PATH: root }, () => findDesktopInstall(undefined, noRegistry, noConventions)), root)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a parent directory is enough: the probe looks one level down', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-discover-'))
  try {
    const parent = join(base, 'Apps', 'Vendor')
    const root = fakeInstall(parent)
    assert.equal(withEnv(base, { DSH_DESKTOP_PATH: parent }, () => findDesktopInstall(undefined, noRegistry, noConventions)), root)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('Program Files is scanned like %LOCALAPPDATA%\\Programs', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-discover-'))
  try {
    const programs = join(base, 'ProgramFilesRoot')
    const root = fakeInstall(programs, 'Installed Elsewhere')
    assert.equal(withEnv(base, { ProgramFiles: programs }, () => findDesktopInstall(undefined, noRegistry, noConventions)), root)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('the per-user Program Files root also works', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-discover-'))
  try {
    const programs = join(base, 'ProgramFilesX86')
    const root = fakeInstall(programs, 'DSH Desktop')
    assert.equal(withEnv(base, { 'ProgramFiles(x86)': programs }, () => findDesktopInstall(undefined, noRegistry, noConventions)), root)
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
      withEnv(base, { ProgramFiles: join(base, 'ProgramFilesRoot') }, () => findDesktopInstall(undefined, noRegistry, noConventions)),
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
    assert.equal(withEnv(base, { ProgramFiles: programs }, () => findDesktopInstall(undefined, noRegistry, noConventions)), actual)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('an unreadable archive and a product-named executable are not identity evidence', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-discover-invalid-'))
  try {
    const root = fakeInstall(join(base, 'Elsewhere'))
    writeFileSync(join(root, 'resources', 'app.asar'), 'not an archive')
    assert.equal(withEnv(base, { DSH_DESKTOP_PATH: root }, () => findDesktopInstall(undefined, noRegistry, noConventions)), undefined)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------------------------
// What the widened Windows roots still cannot see (issue #40 follow-up).
//
// The multi-root probe above is entirely environment-variable driven, which leaves two real installs
// invisible: one recorded only in the uninstall registry (a custom install directory — measured at
// `E:\Applications\DeepSeek Harness`), and any install on macOS or Linux, where every one of those
// variables is empty. Both are added as further sources, each still gated on identity.
// ---------------------------------------------------------------------------------------------

test('DSH_DESKTOP_APP is accepted as well as DSH_DESKTOP_PATH', () => {
  // The repository already documents DSH_DESKTOP_APP for this question in
  // tools/install-web-plugin.mjs, so a user who set that one must not be told there is no desktop.
  const base = mkdtempSync(join(tmpdir(), 'dsh-discover-appvar-'))
  try {
    const root = fakeInstall(join(base, 'Apps', 'Somewhere else'))
    assert.equal(
      withEnv(base, { DSH_DESKTOP_APP: root }, () => findDesktopInstall(undefined, noRegistry, noConventions)),
      root,
    )
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('DSH_DESKTOP_APP may name a parent of the install, not just the root itself', () => {
  // install-web-plugin.mjs documents this variable as pointing INSIDE the install (it joins
  // `node_modules` onto it), so people will not necessarily set it to the root. Both readings are
  // supported: the value is tried as an install root, then as a directory containing one.
  const base = mkdtempSync(join(tmpdir(), 'dsh-discover-appvar-dsh-'))
  try {
    const parent = join(base, 'Apps')
    const root = fakeInstall(parent, 'DeepSeek Harness')
    assert.equal(
      withEnv(base, { DSH_DESKTOP_APP: parent }, () => findDesktopInstall(undefined, noRegistry, noConventions)),
      root,
      'the install is found one level down from the declared directory',
    )
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('the uninstall registry finds an install in a custom directory', () => {
  // The reported case: nothing under any environment root, an install on another drive, and the only
  // record of it is what the installer wrote when it ran. No variable is set.
  const base = mkdtempSync(join(tmpdir(), 'dsh-discover-registry-'))
  try {
    const root = fakeInstall(join(base, 'E-drive', 'DeepSeek Harness'))
    assert.equal(
      withEnv(base, {}, () => findDesktopInstall(undefined, () => [root], noConventions)),
      root,
      'a registry-backed install is found with no configuration at all',
    )
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a registry value that is not an install is skipped, and the next one is tried', () => {
  // Registry values outlive the directories they name: an uninstall that left its key behind, a path
  // restored from another machine. Each must be skipped rather than trusted, and a bad one must not
  // stop the search.
  const base = mkdtempSync(join(tmpdir(), 'dsh-discover-registry-stale-'))
  try {
    const root = fakeInstall(join(base, 'E-drive', 'DeepSeek Harness'))
    const leftover = join(base, 'leftover')
    mkdirSync(leftover, { recursive: true })
    const registry = () => [join(base, 'gone'), leftover, root]
    assert.equal(withEnv(base, {}, () => findDesktopInstall(undefined, registry, noConventions)), root)
    assert.equal(
      withEnv(base, {}, () => findDesktopInstall(undefined, () => [join(base, 'gone'), leftover], noConventions)),
      undefined,
      'and when none of them is an install, the answer is still "nothing found"',
    )
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a registry lookup that throws is a state, not a crash', () => {
  // reg.exe is best-effort: a locked-down machine, a restricted key, a machine with no such tool.
  const base = mkdtempSync(join(tmpdir(), 'dsh-discover-registry-throws-'))
  try {
    const throwing = () => { throw new Error('reg.exe is unavailable') }
    assert.equal(
      withEnv(base, {}, () => findDesktopInstall(undefined, throwing, noConventions)),
      undefined,
      'the failure does not escape the probe',
    )
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a macOS bundle is found through its Contents directory', () => {
  // macOS has no registry and none of the Windows roots, so without the conventions the probe answers
  // "no desktop here" on a machine that has one. The candidate is the bundle's `Contents` directory:
  // `Contents/Resources` is where Electron's `resources` lives, and the identity rule looks for
  // `resources/app` beneath the root it is handed.
  const base = mkdtempSync(join(tmpdir(), 'dsh-discover-macos-'))
  try {
    const contents = join(base, 'Applications', 'DSH Desktop.app', 'Contents')
    mkdirSync(join(contents, 'Resources', 'app', 'lib'), { recursive: true })
    writeFileSync(join(contents, 'Resources', 'app', 'lib', 'main.js'), MAIN_BODY)
    writeFileSync(join(contents, 'Resources', 'app', 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: '0.2.2-test', main: 'lib/main.js' }))
    assert.equal(
      withEnv(base, {}, () => findDesktopInstall(undefined, noRegistry, () => [contents])),
      contents,
      'the bundle Contents directory is the install root',
    )
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a Linux install is found, and the first conventional candidate need not exist', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-discover-linux-'))
  try {
    const opt = fakeInstall(join(base, 'opt', 'DeepSeek Harness'))
    assert.equal(
      withEnv(base, {}, () => findDesktopInstall(undefined, noRegistry, () => [join(base, 'opt', 'DSH Desktop'), opt])),
      opt,
      'a candidate that is absent does not stop the scan',
    )
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('conventional locations and registry values are still held to the identity rule', () => {
  // Widening where the probe looks must not widen what counts as DSH Desktop: that is the boundary
  // issue #40 established, and a bundle left behind by an uninstall or an unrelated app in /opt is
  // exactly the case it exists for.
  const base = mkdtempSync(join(tmpdir(), 'dsh-discover-conventional-impostor-'))
  try {
    const impostor = fakeInstall(join(base, 'opt', 'DeepSeek Harness'), 'DeepSeek Harness', 'unrelated-meeting-app')
    assert.equal(
      withEnv(base, {}, () => findDesktopInstall(undefined, noRegistry, () => [impostor])),
      undefined,
      'an unrelated app in a conventional location is not DSH Desktop',
    )
    assert.equal(
      withEnv(base, {}, () => findDesktopInstall(undefined, () => [impostor], noConventions)),
      undefined,
      'nor is an unrelated app recorded in the registry',
    )
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a conventional lookup that throws is a state, not a crash', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-discover-conventional-throws-'))
  try {
    const throwing = () => { throw new Error('permission denied reading /Applications') }
    assert.equal(withEnv(base, {}, () => findDesktopInstall(undefined, noRegistry, throwing)), undefined)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('the usual roots still win over the registry and the conventions', () => {
  // Order matters: adding sources must not change which install an ordinary machine reports, so a
  // leftover registry entry cannot retarget the panel on a normal install.
  const base = mkdtempSync(join(tmpdir(), 'dsh-discover-precedence-'))
  try {
    const usual = fakeInstall(join(base, 'ProgramFilesRoot'), 'DSH Desktop')
    const elsewhere = fakeInstall(join(base, 'E-drive', 'DeepSeek Harness'))
    assert.equal(
      withEnv(base, { ProgramFiles: join(base, 'ProgramFilesRoot') },
        () => findDesktopInstall(undefined, () => [elsewhere], () => [elsewhere])),
      usual,
      'the ordinary root answers first',
    )
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
