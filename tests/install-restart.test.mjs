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

test('a revert never closes the shell', () => {
  // --revert restores files, and closing a running DSH to do that would be a surprise the user did
  // not ask for.
  assert.match(source, /if \(restart && !revert\) \{/, 'the close is guarded by !revert')
})

test('closing asks politely first and forces only as a fallback', () => {
  // A forced kill can lose work. The user agreed to "close", not "kill".
  const stopAt = source.indexOf('async function stopShell')
  const stopBody = source.slice(stopAt, source.indexOf('function startShell'))
  const polite = stopBody.indexOf("runCapture('taskkill.exe', ['/PID'")
  const forced = stopBody.indexOf("runCapture('taskkill.exe', ['/IM'")
  assert.ok(polite !== -1, 'a per-process request without /F comes first')
  assert.ok(forced !== -1, 'and a forced kill exists as a fallback')
  assert.ok(polite < forced, 'polite before forced')
  assert.doesNotMatch(stopBody.slice(polite, polite + 80), /\/F/, 'the first request must not force')
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
