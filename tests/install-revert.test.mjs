import { fileURLToPath } from 'node:url'
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
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInstallerSandbox } from './helpers/installer-sandbox.mjs'

const sandbox = createInstallerSandbox()
after(() => sandbox.close())

const repo = fileURLToPath(new URL('..', import.meta.url))
const script = join(repo, 'desktop-bridge', 'install.mjs')

/** A minimal but structurally valid desktop install. */
function makeInstall() {
  const root = sandbox.temp('dsh-install-')
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
  // Identity (issue #40): a shape is not an identity. The installer refuses a tree whose manifest
  // does not name DSH Desktop, so every fixture that expects it to act has to carry one.
  writeFileSync(join(root, 'resources', 'app', 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-desktop',
    version: '0.2.1-rc.5',
    main: 'lib/main.js',
  }))
  return { root, body }
}

const run = args => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: 'pipe', windowsHide: true, env: sandbox.env() }) }
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

test('the default install is found by identity, not by a fixed product name', () => {
  // The product directory is `DeepSeek Harness` on some builds and `DSH Desktop` on others, so a
  // hardcoded name makes the documented bare command fail. What identifies the install is the app's
  // own manifest (issue #40), not its folder name: a differently named directory is found when the
  // manifest says DSH Desktop, and ignored when it does not.
  const fake = sandbox.temp('dsh-localappdata-')
  const programs = join(fake, 'Programs')
  const named = join(programs, 'Some Other Name')
  mkdirSync(join(named, 'resources', 'app', 'lib'), { recursive: true })
  writeFileSync(join(named, 'resources', 'app', 'lib', 'main.js'), 'const app = {};\n\nexport {};\n')
  writeFileSync(join(named, 'resources', 'app', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: '0.2.1-rc.5', main: 'lib/main.js' }))
  try {
    const result = execFileSync(process.execPath, [script], {
      encoding: 'utf8',
      stdio: 'pipe',
      windowsHide: true,
      env: sandbox.env({ LOCALAPPDATA: fake }),
    })
    assert.match(result, /Some Other Name/, 'the probe found the install despite the directory name')
  } catch (error) {
    // A non-zero exit is the failure this test exists to catch; report what the script said.
    assert.fail(`the bare command must find the install: ${String(error.stdout ?? error.message)}`)
  } finally {
    rmSync(fake, { recursive: true, force: true })
  }
})

test('the default install probe refuses a directory whose manifest is another app', () => {
  // The same probe, with the shape but somebody else's name: the documented bare command must not
  // pick it up and try to patch it.
  const fake = sandbox.temp('dsh-localappdata-')
  const named = join(fake, 'Programs', 'DeepSeek Harness')
  mkdirSync(join(named, 'resources', 'app', 'lib'), { recursive: true })
  writeFileSync(join(named, 'resources', 'app', 'lib', 'main.js'), 'const app = {};\n\nexport {};\n')
  writeFileSync(join(named, 'resources', 'app', 'package.json'),
    JSON.stringify({ name: 'unrelated-meeting-app', main: 'lib/main.js' }))
  try {
    try {
      execFileSync(process.execPath, [script], { encoding: 'utf8', stdio: 'pipe', windowsHide: true, env: sandbox.env({ LOCALAPPDATA: fake }) })
      assert.fail('the installer must not act on another application')
    } catch (error) {
      assert.notEqual(error.status, 0, 'it exits non-zero')
      assert.match(`${error.stdout ?? ''}${error.stderr ?? ''}`, /refusing to touch|DSH Desktop install/)
      assert.equal(readFileSync(join(named, 'resources', 'app', 'lib', 'main.js'), 'utf8'),
        'const app = {};\n\nexport {};\n', 'and the file is untouched')
    }
  } finally {
    rmSync(fake, { recursive: true, force: true })
  }
})

test('--revert preserves a newer archive installed over the old bridge backup', () => {
  const { root } = makeInstall()
  const archive = join(root, 'resources', 'app.asar')
  const backup = `${archive}.before-bridge`
  try {
    writeFileSync(archive, 'new-desktop-build')
    writeFileSync(backup, 'old-desktop-build')
    const result = run([root, '--revert'])
    assert.equal(readFileSync(archive, 'utf8'), 'new-desktop-build')
    assert.equal(readFileSync(backup, 'utf8'), 'old-desktop-build')
    assert.notEqual(result.code, 0)
    assert.match(result.out, /archive.*exists|newer|refus/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * An unpacked install that also carries the Desktop CLI launcher. The installer patches that
 * launcher and backs it up; on --revert the launcher restore used to set the single `reverted`
 * flag, so the script exited 0 even when a foreign patch kept our bridge import in main.js.
 * Reported as "uninstallExitCode=0, afterUninstallState=installed, mainStillImportsBridge=true".
 */
function makeInstallWithCliShim() {
  const { root, body } = makeInstall()
  const shim = join(root, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd')
  mkdirSync(dirname(shim), { recursive: true })
  const launcher = [
    '@echo off',
    'setlocal',
    '"%~dp0..\\..\\..\\DeepSeek Harness.exe" "%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" %*',
    '',
  ].join('\n')
  writeFileSync(shim, launcher)
  return { root, body, shim, launcher }
}

test('a restored CLI launcher must not report success while main.js still loads the bridge', () => {
  const { root, body, shim, launcher } = makeInstallWithCliShim()
  const mainPath = join(root, 'resources', 'app', 'lib', 'main.js')
  const backupPath = `${mainPath}.before-bridge`
  try {
    assert.equal(run([root]).code, 0, 'install exits 0')
    const originalShim = readFileSync(shim, 'utf8')
    assert.notEqual(originalShim, launcher, 'the CLI launcher was patched and backed up')

    // A second tool edits main.js AFTER our backup was taken. Our bridge snippet stays inside.
    const patched = readFileSync(mainPath, 'utf8')
    writeFileSync(mainPath, patched.replace('export {};', 'const otherTool = true;\nexport {};'))
    const before = readFileSync(mainPath, 'utf8')

    const result = run([root, '--revert'])
    assert.equal(readFileSync(mainPath, 'utf8'), before, 'the foreign patch is still preserved')
    assert.equal(readFileSync(backupPath, 'utf8'), body, 'and the original backup survives')
    assert.equal(readFileSync(shim, 'utf8'), launcher, 'the CLI component really was restored')
    assert.notEqual(result.code, 0, 'but a CLI restore alone is NOT a successful uninstall')
    assert.match(result.out, /INCOMPLETE|still imports the bridge/,
      'and the reason is named rather than reported as success')
    assert.ok(readFileSync(mainPath, 'utf8').includes('plugin-browser-bridge.js'),
      'the bridge import is still present on disk, which is why the exit is non-zero')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a clean uninstall with a CLI launcher still exits 0', () => {
  const { root, body, shim, launcher } = makeInstallWithCliShim()
  const mainPath = join(root, 'resources', 'app', 'lib', 'main.js')
  try {
    assert.equal(run([root]).code, 0, 'install exits 0')
    const result = run([root, '--revert'])
    assert.equal(result.code, 0, 'an uninstall that really removed the bridge still succeeds')
    assert.equal(readFileSync(mainPath, 'utf8'), body, 'main.js is restored byte-for-byte')
    assert.equal(readFileSync(shim, 'utf8'), launcher, 'and the CLI launcher is restored too')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
