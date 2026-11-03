// Issue #40: what proves a directory is DSH Desktop, and what must happen before anything is touched.
//
// Reported: an app in a temp directory whose own package.json said `unrelated-meeting-app` was
// accepted by discovery, reported as "DSH Desktop, bridge missing" with a ready-to-run installer
// command aimed at it, and (with that command) had its entry file rewritten and the bridge copied in.
// A second sample lost `resources/app` to the packed-layout rebuild before the archive was found
// unusable.
//
// The tests below are byte-level: they run the real installer against real directories and compare
// contents before and after, because "it refused" is not the property — "it changed nothing" is.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FALLBACK_RULE, readAsarFile, readDesktopIdentity, readIdentityRule } from '../lib/browser-electron/desktop-identity.js'
import { findDesktopInstall, readBridgeStatus } from '../lib/browser-electron/bridge-status.js'
import { MAIN_BODY, makePackedInstall, makeUnpackedInstall, writeAsar } from './fake-asar.mjs'

const repo = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const script = join(repo, 'desktop-bridge', 'install.mjs')

/** Run the installer and report its exit code and combined output. */
const run = args => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: 'pipe' }) }
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

/** SHA-256 of a file. */
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex')

/** Every file under a directory and its digest, so a refusal can be proven to have changed nothing. */
function snapshot(root) {
  const out = {}
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      out[full] = digest(full)
    }
  }
  walk(root)
  return out
}
test('an unpacked DSH Desktop tree is accepted, by name and not by shape', () => {
  const root = makeUnpackedInstall()
  try {
    const identity = readDesktopIdentity(root)
    assert.equal(identity.ok, true, 'the name is @deepseek-ai/dsh-desktop')
    assert.equal(identity.layout, 'unpacked')
    assert.equal(identity.packageName, '@deepseek-ai/dsh-desktop')
    assert.equal(identity.version, '0.2.1-rc.5')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('another Electron app with the same shape is refused, and the installer changes no bytes', () => {
  const root = makeUnpackedInstall({ name: 'unrelated-meeting-app' })
  const mainPath = join(root, 'resources', 'app', 'lib', 'main.js')
  try {
    const before = snapshot(root)

    const identity = readDesktopIdentity(root)
    assert.equal(identity.ok, false)
    assert.match(identity.reason, /unrelated-meeting-app/, 'the refusal names what the app calls itself')
    assert.match(identity.reason, /different application/)

    const result = run([root])
    assert.equal(result.code, 1, 'the installer refuses')
    assert.match(result.out, /refusing to touch/)
    assert.match(result.out, /Nothing was stopped, deleted, extracted or written/)
    assert.deepEqual(snapshot(root), before, 'byte-for-byte unchanged: no patch, no backup, no bridge')
    assert.equal(existsSync(join(root, 'resources', 'app', 'lib', 'plugin-browser-bridge.js')), false)
    assert.equal(existsSync(`${mainPath}.before-bridge`), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('identity is read from the archive, so a foreign package inside it is refused', () => {
  // The sibling `resources/app` directory carries a plausible DSH name here on purpose: Electron
  // loads the archive, so the directory's name must not decide anything.
  const root = makePackedInstall({ name: 'unrelated-meeting-app' })
  mkdirSync(join(root, 'resources', 'app', 'lib'), { recursive: true })
  writeFileSync(join(root, 'resources', 'app', 'lib', 'main.js'), MAIN_BODY)
  writeFileSync(join(root, 'resources', 'app', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-desktop' }))
  try {
    const before = snapshot(root)
    const identity = readDesktopIdentity(root)
    assert.equal(identity.ok, false, 'the archive says unrelated-meeting-app')
    assert.equal(identity.layout, undefined)

    const result = run([root])
    assert.equal(result.code, 1)
    assert.deepEqual(snapshot(root), before, 'neither the archive nor the directory was touched')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an unusable archive is refused BEFORE the existing extraction is deleted', () => {
  // The measured defect: `resources/app` was removed, and only then did the archive turn out to be
  // unreadable — so the run cost the directory and gained nothing.
  const root = mkdtempSync(join(tmpdir(), 'dsh-install-bad-'))
  try {
    mkdirSync(join(root, 'resources', 'app', 'lib'), { recursive: true })
    writeFileSync(join(root, 'resources', 'app', 'lib', 'main.js'), MAIN_BODY)
    writeFileSync(join(root, 'resources', 'app', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-desktop' }))
    writeFileSync(join(root, 'resources', 'app.asar'), 'not really an archive')
    const before = snapshot(root)

    const result = run([root])
    assert.equal(result.code, 1)
    assert.match(result.out, /refusing to touch|refusing to rebuild/)
    assert.ok(existsSync(join(root, 'resources', 'app', 'lib', 'main.js')),
      'the existing extraction survived the refusal')
    assert.deepEqual(snapshot(root), before, 'and nothing under the install root changed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the identity check runs before the shell may be stopped', () => {
  // `--restart` closes the desktop app before doing anything else, so a check that only guarded the
  // writes would still let a wrong directory take down whatever application it names.
  const source = readFileSync(script, 'utf8')
  const identityAt = source.indexOf('const identity = verifyDesktopIdentity(installRoot)')
  const stopAt = source.indexOf('await stopShell(')
  const deleteAt = source.indexOf('rmSync(appDir')
  const writeAt = source.indexOf('copyFileSync(bridgeSource, bridgeTarget)')
  assert.ok(identityAt !== -1, 'the installer verifies identity')
  assert.ok(stopAt !== -1 && identityAt < stopAt, 'identity is checked BEFORE the shell is stopped')
  assert.ok(deleteAt !== -1 && identityAt < deleteAt, 'and before any tree is deleted')
  assert.ok(writeAt !== -1 && identityAt < writeAt, 'and before anything is written')
})

test('the identity rule has one source, and the shipped fallback matches it', () => {
  const rule = readIdentityRule()
  assert.ok(!('error' in rule), 'the JSON rule loads')
  assert.deepEqual({ ...rule }, { ...FALLBACK_RULE }, 'the fallback is the same rule, not a stale copy')
  const json = JSON.parse(readFileSync(join(repo, 'desktop-bridge', 'desktop-identity.json'), 'utf8'))
  assert.deepEqual(json.packageNames, FALLBACK_RULE.packageNames)
  assert.equal(json.mainEntry, FALLBACK_RULE.mainEntry)

  // The installer must not carry a second list of accepted names.
  const installer = readFileSync(script, 'utf8')
  assert.match(installer, /desktop-identity\.json/, 'it reads the shared rule')
  for (const name of FALLBACK_RULE.packageNames) {
    assert.equal(installer.includes(`'${name}'`), false,
      `the installer must not hard-code ${name}; that is how two rules drift apart`)
  }
})

test('bridge status refuses a foreign app and offers no installer command for it', () => {
  const root = makeUnpackedInstall({ name: 'unrelated-meeting-app' })
  try {
    const status = readBridgeStatus(root)
    assert.equal(status.present, false, 'not a DSH Desktop install')
    assert.equal(status.state, 'missing')
    assert.match(status.detail, /not a DSH Desktop install/)
    assert.equal(status.command, undefined,
      'no command is offered: pointing the installer at an unverified directory is the reported defect')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('discovery skips a foreign app even when its product directory is named like ours', () => {
  const base = mkdtempSync(join(tmpdir(), 'localappdata-'))
  try {
    const impostor = join(base, 'Programs', 'DeepSeek Harness')
    mkdirSync(join(impostor, 'resources', 'app', 'lib'), { recursive: true })
    writeFileSync(join(impostor, 'resources', 'app', 'lib', 'main.js'), MAIN_BODY)
    writeFileSync(join(impostor, 'resources', 'app', 'package.json'), JSON.stringify({ name: 'unrelated-meeting-app' }))

    assert.equal(findDesktopInstall(base), undefined, 'a name-bearing product directory is not proof')

    const real = join(base, 'Programs', 'DSH Desktop')
    mkdirSync(join(real, 'resources', 'app', 'lib'), { recursive: true })
    writeFileSync(join(real, 'resources', 'app', 'lib', 'main.js'), MAIN_BODY)
    writeFileSync(join(real, 'resources', 'app', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-desktop' }))
    assert.equal(findDesktopInstall(base), real, 'and the real one is still found')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a packed archive with a DSH manifest is read without extracting it', () => {
  const root = makePackedInstall()
  try {
    const identity = readDesktopIdentity(root)
    assert.equal(identity.ok, true)
    assert.equal(identity.layout, 'packed')
    const manifest = readAsarFile(join(root, 'resources', 'app.asar'), 'package.json')
    assert.ok(manifest !== undefined && manifest.length > 0, 'the manifest bytes come out of the archive')
    assert.equal(JSON.parse(manifest.toString('utf8')).name, '@deepseek-ai/dsh-desktop')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a packed install whose archive lacks the shell entry is refused', () => {
  const root = makePackedInstall({ withMain: false })
  try {
    const identity = readDesktopIdentity(root)
    assert.equal(identity.ok, false)
    assert.match(identity.reason, /lib\/main\.js is not present/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an archive with no manifest inside is refused rather than assumed', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-install-nomanifest-'))
  try {
    writeAsar(join(root, 'resources', 'app.asar'), { 'lib/main.js': MAIN_BODY })
    const identity = readDesktopIdentity(root)
    assert.equal(identity.ok, false)
    assert.match(identity.reason, /package\.json/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
