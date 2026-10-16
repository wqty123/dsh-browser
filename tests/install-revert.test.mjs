// desktop-bridge/install.mjs, from #31.
//
// The reported defect is not visible in a unit test of the decision logic: what has to hold is that
// a NORMAL install followed by `--revert` restores main.js AND leaves the original backup intact.
// The old branch asked whether the current file carries our marker while the backup does not —
// which is true of every freshly installed file, because the backup is taken before patching. So a
// normal revert refreshed the backup from the patched file and destroyed the restore point it had
// just declined to use, exiting 0.
//
// These tests drive the real script over a real directory shape and compare bytes. A first version
// of them was run against the pre-fix script from git and failed there, which is what makes them
// evidence rather than a restatement of the implementation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const script = join(repo, 'desktop-bridge', 'install.mjs')

/** A minimal but structurally valid desktop install. */
function makeInstall() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-install-'))
  mkdirSync(join(root, 'resources', 'app', 'lib'), { recursive: true })
  const body = [
    '// a stand-in for the shell entry point',
    'const app = { whenReady: () => Promise.resolve() };',
    'app.whenReady().then(() => console.log("shell up"));',
    '',
    'export {};',
    '',
  ].join('\n')
  writeFileSync(join(root, 'resources', 'app', 'lib', 'main.js'), body)
  return { root, body }
}

const run = args => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: 'pipe' }) }
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

test('a normal install followed by --revert restores the file and keeps the backup', () => {
  const { root, body } = makeInstall()
  const mainPath = join(root, 'resources', 'app', 'lib', 'main.js')
  const backupPath = `${mainPath}.before-bridge`
  try {
    const installed = run([root])
    assert.equal(installed.code, 0, 'install exits 0')
    assert.ok(readFileSync(mainPath, 'utf8').length > body.length, 'the installer patched main.js')
    assert.equal(readFileSync(backupPath, 'utf8'), body, 'the backup is the pre-patch body')

    const reverted = run([root, '--revert'])
    assert.equal(reverted.code, 0, 'revert exits 0')
    assert.equal(readFileSync(mainPath, 'utf8'), body, 'revert restored main.js byte-for-byte')
    assert.equal(readFileSync(backupPath, 'utf8'), body,
      'and the original backup survived — the report says this is what was destroyed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a patch made around our snippet is not discarded, and the backup survives it', () => {
  const { root, body } = makeInstall()
  const mainPath = join(root, 'resources', 'app', 'lib', 'main.js')
  const backupPath = `${mainPath}.before-bridge`
  try {
    run([root])
    // A second tool patching the same file AFTER our backup was taken — the situation the old
    // heuristic was aimed at, and the one it could not tell apart from a fresh install.
    const patched = readFileSync(mainPath, 'utf8')
    writeFileSync(mainPath, patched.replace('export {};', 'const otherTool = true;\nexport {};'))
    const before = readFileSync(mainPath, 'utf8')

    const result = run([root, '--revert'])
    assert.equal(readFileSync(mainPath, 'utf8'), before, 'the foreign patch is left in place')
    assert.equal(readFileSync(backupPath, 'utf8'), body, 'and the backup is still the original')
    assert.match(result.out, /another tool has patched this file/,
      'and the reason is reported rather than a bare success')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the "safe to delete resources/app" note only appears where an archive exists', () => {
  const { root } = makeInstall()
  try {
    run([root])
    const reverted = run([root, '--revert'])
    // No app.asar here, so resources/app is the live application: advising its deletion would
    // invite the user to remove the thing Electron loads.
    assert.doesNotMatch(reverted.out, /is inert while app\.asar exists/,
      'the unpacked layout is not described as inert')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the default install is found by shape, not by a fixed product name', () => {
  // The product directory is `DeepSeek Harness` on some builds and `DSH Desktop` on others, so a
  // hardcoded name makes the documented bare command fail. Both are probed here, and a differently
  // named directory is found too — the shape is what identifies an install.
  const fake = mkdtempSync(join(tmpdir(), 'dsh-localappdata-'))
  const programs = join(fake, 'Programs')
  const named = join(programs, 'Some Other Name')
  mkdirSync(join(named, 'resources', 'app', 'lib'), { recursive: true })
  writeFileSync(join(named, 'resources', 'app', 'lib', 'main.js'), 'const app = {};\n\nexport {};\n')
  try {
    const result = execFileSync(process.execPath, [script], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, LOCALAPPDATA: fake },
    })
    assert.match(result, /Some Other Name/, 'the probe found the install despite the directory name')
  } catch (error) {
    // A non-zero exit is the failure this test exists to catch; report what the script said.
    assert.fail(`the bare command must find the install: ${String(error.stdout ?? error.message)}`)
  } finally {
    rmSync(fake, { recursive: true, force: true })
  }
})
