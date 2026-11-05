// `install.mjs --restart`: close DSH, install, start it again — in one process (issue #36).
//
// The reported failures are why this shape and not another: the archive cannot be moved while the
// shell runs (EBUSY), and nothing launched from outside survives the exit long enough to install
// afterwards. A hidden PowerShell started through WMI vanished with the process tree; a scheduled
// task reported LastTaskResult 0xC000013A (STATUS_CONTROL_C_EXIT). So the installer must do the
// closing itself, and must start the shell detached so it does not die with the installer.
//
// These tests read the script rather than run it: the behaviours worth pinning down are ordering and
// intent, and actually stopping a live shell in a test would be destructive.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../desktop-bridge/install.mjs', import.meta.url), 'utf8')

test('the flags exist and are parsed from the command line', () => {
  assert.match(source, /const restart = args\.includes\('--restart'\)/, '--restart is parsed')
  assert.match(source, /const assumeYes = args\.includes\('--yes'\) \|\| args\.includes\('-y'\)/,
    '--yes is parsed, with -y as a short form')
})

test('the shell is closed BEFORE the archive is touched', () => {
  // The whole point: EBUSY happens at rename, so closing has to precede the pack step. Comparing
  // source offsets proves the ordering without running anything.
  const closeCall = source.indexOf('stopShell(installRoot')
  const packStep = source.indexOf('const packedLayout = existsSync(asarPath)')
  assert.ok(closeCall !== -1, 'the installer calls stopShell')
  assert.ok(packStep !== -1, 'and still computes the layout')
  assert.ok(closeCall < packStep, 'closing must come first')
})

test('explicit restart also covers revert and idempotent install exits', () => {
  assert.match(source, /if \(restart\) \{/, 'both actions honour an explicit restart')
  assert.match(source, /process\.once\('exit'/, 'successful early returns also run the restart')
  const archiveCheck = source.indexOf('const checked = validateArchive(asarPath)')
  assert.ok(archiveCheck < source.indexOf('stopShell(installRoot'), 'archive checks precede shutdown')
})

test('closing asks politely first and forces only as a fallback', () => {
  // A forced kill can lose work. The user agreed to "close", not "kill".
  const stopAt = source.indexOf('async function stopShell')
  const stopBody = source.slice(stopAt, source.indexOf('function startShell'))
  const polite = stopBody.indexOf("runCapture('taskkill.exe', before.flatMap")
  const forced = stopBody.indexOf("runCapture('taskkill.exe', [...left.flatMap")
  assert.ok(polite !== -1, 'a per-process request without /F comes first')
  assert.ok(forced !== -1, 'and a forced kill exists as a fallback')
  assert.ok(polite < forced, 'polite before forced')
  assert.doesNotMatch(stopBody.slice(polite, polite + 80), /\/F/, 'the first request must not force')
  assert.doesNotMatch(stopBody, /'\/IM'/, 'a second installation is never killed by image name')
  assert.doesNotMatch(stopBody, /'\/T'/, 'a GUI process cannot kill unselected Node-mode descendants')
  // Both waits are bounded: a process that refuses to die must not hang the installer.
  assert.match(stopBody, /const deadline = Date\.now\(\) \+ graceMs/, 'the polite wait is bounded')
  assert.match(stopBody, /const forcedBy = Date\.now\(\) \+ 15_000/, 'and so is the forced one')
})

test('the shell is started detached, so it outlives the installer', () => {
  const startAt = source.indexOf('function startShell')
  const body = source.slice(startAt, startAt + 900)
  assert.match(body, /detached: true/, 'detached from this process')
  assert.match(body, /stdio: 'ignore'/, 'with no inherited streams')
  assert.match(body, /child\.unref\(\)/, 'and unref-ed so the installer can exit')
  // The trap this avoids: a child of a dying parent dies too, which is exactly how the
  // wait-for-exit daemons lost the shell.
  assert.match(source, /startShell\(installRoot\)/, 'and the install path actually calls it')
})

test('an unattended run without --yes refuses instead of closing a window', () => {
  // Closing a user's shell because a service happened to run the installer would be worse than
  // failing; the check makes that impossible rather than merely unlikely.
  assert.match(source, /--restart needs confirmation; pass --yes when there is no console to ask\./,
    'the refusal is explicit')
  const confirmAt = source.indexOf('if (!assumeYes)')
  const confirmBody = source.slice(confirmAt, confirmAt + 900)
  assert.match(confirmBody, /answer !== 'y' && answer !== 'yes'/, 'only an explicit yes proceeds')
})

test('an install that could not stop the shell fails instead of half-installing', () => {
  assert.match(source, /DSH Desktop did not exit, so the archive cannot be replaced\./,
    'the message names the actual cause')
  // Guarded by an exit, so the pack step is never reached with the shell still holding the archive.
  const failAt = source.indexOf('DSH Desktop did not exit')
  const nextPack = source.indexOf('const packedLayout = existsSync(asarPath)')
  assert.ok(failAt !== -1 && failAt < nextPack, 'and it happens before the pack step')
})

// Execute the actual selection function with process tables that would previously kill native
// CLI/installer processes. The real process table and running desktop are never modified.
function processSelection() {
  const start = source.indexOf('function selectShellProcesses')
  const end = source.indexOf('/**\n * Run a command and return its stdout', start)
  return source.slice(start, end)
}

test('the selected GUI processes exclude native CLI, installer and other installations', () => {
  const root = resolve('test-desktop')
  const exe = resolve(root, 'DeepSeek Harness.exe')
  const select = runInNewContext(processSelection() + '; selectShellProcesses', { resolve })
  const row = (pid, parent, commandLine, executablePath = exe) => ({
    ProcessId: pid, ParentProcessId: parent, Name: 'DeepSeek Harness.exe', ExecutablePath: executablePath, CommandLine: commandLine,
  })
  const selected = select([
    row(10, 1, '"' + exe + '"'),
    row(11, 10, '"' + exe + '" --type=renderer'),
    row(20, 1, '"' + exe + '" --expose-internals "resources/app.asar/cli.js"'),
    row(21, 20, '"' + exe + '" "desktop-bridge/install.mjs" --restart'),
    row(30, 1, '"' + exe + '" --eval "console.log(1)"'),
    row(40, 1, '"other/DeepSeek Harness.exe"', resolve('other-desktop', 'DeepSeek Harness.exe')),
  ], root, 21)
  assert.deepEqual(Array.from(selected), [10, 11])
})

test('an installer beneath the GUI refuses before any GUI process can be closed', () => {
  const root = resolve('test-desktop')
  const exe = resolve(root, 'DeepSeek Harness.exe')
  const select = runInNewContext(processSelection() + '; selectShellProcesses', { resolve })
  const rows = [
    { ProcessId: 10, ParentProcessId: 1, Name: 'DeepSeek Harness.exe', ExecutablePath: exe, CommandLine: '"' + exe + '"' },
    { ProcessId: 20, ParentProcessId: 10, Name: 'DeepSeek Harness.exe', ExecutablePath: exe, CommandLine: '"' + exe + '" --expose-internals cli.js' },
    { ProcessId: 21, ParentProcessId: 20, Name: 'DeepSeek Harness.exe', ExecutablePath: exe, CommandLine: '"' + exe + '" install.mjs --restart' },
  ]
  assert.throws(() => select(rows, root, 21), /separate terminal with Node.js/)
})

test('failed or malformed process enumeration never means the GUI is stopped', () => {
  const root = resolve('test-desktop')
  for (const output of [undefined, '', 'not json', 'null', '[]', '{}', '[null]']) {
    const enumerate = runInNewContext(processSelection() + '; shellProcesses', {
      resolve, process: { pid: 21 }, runCapture: () => output,
    })
    assert.throws(() => enumerate(root), /process|enumerate|parse|invalid/i)
  }
  const select = runInNewContext(processSelection() + '; selectShellProcesses', { resolve })
  assert.throws(() => select([
    { ProcessId: 10, ParentProcessId: 1, Name: 'DeepSeek Harness.exe', ExecutablePath: null, CommandLine: null },
  ], root, 21), /could not identify/)
})

test('GUI restart clears Electron Node mode while retaining the remaining environment', () => {
  const start = source.indexOf('function startShell')
  const end = source.indexOf('\nconst args =', start)
  let options
  let detached = false
  const environment = { ELECTRON_RUN_AS_NODE: '1', electron_run_as_node: '1', RETAINED_TEST_SETTING: 'retained' }
  const startGui = runInNewContext(source.slice(start, end) + '; startShell', {
    join: (...parts) => parts.join('/'),
    existsSync: () => true,
    process: { env: environment },
    console: { log() {}, error() {} },
    spawn: (_exe, _argv, config) => {
      options = config
      return { pid: 123, on() {}, unref() { detached = true } }
    },
  })
  assert.equal(startGui('test-desktop'), true)
  assert.equal(options.env.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(options.env.electron_run_as_node, undefined)
  assert.equal(options.env.RETAINED_TEST_SETTING, 'retained')
  assert.equal(environment.ELECTRON_RUN_AS_NODE, '1', 'the parent host remains in its original mode')
  assert.equal(options.detached, true)
  assert.equal(detached, true)
})
