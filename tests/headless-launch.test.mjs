// Headless fallback for hosts without a display, from issue #32.
//
// Reported from a Debian 13 box running `dsh web` as a systemd service: every `dsh_browser_*` call
// failed with "exited immediately after launch (exit code 1)", the browser never wrote
// DevToolsActivePort, and the underlying cause was "could not connect to display" — Chromium exits
// when neither DISPLAY nor WAYLAND_DISPLAY is set, and the launch args never asked for headless.
//
// The fix has to be a persistent setting, not a source patch: the reporter's own workaround edited
// node_modules and would be lost on the next update.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { createFakeBrowser } from './fixtures/fake-cdp-browser.mjs'

const systemBrowser = readFileSync(new URL('../src/browser-electron/system-browser.ts', import.meta.url), 'utf8')
const settingsStore = readFileSync(new URL('../src/browser-electron/settings-store.ts', import.meta.url), 'utf8')

/** A child-process stub the launcher returns; the host only reads exit codes off it. */
function fakeChild() {
  return { exitCode: null, signalCode: null, kill() {}, once() {}, on() {} }
}

/**
 * A host that records the arguments a launch would use, without running a browser.
 *
 * The launcher never returns a real process, so `start()` fails — but it has already built the args,
 * which is what these tests are about. A fake browser supplies the CDP side for the cases that need
 * a connected session.
 */
async function capturedArgs(headlessMode) {
  const { SystemBrowserViewHost } = await import('../lib/browser-electron/system-browser.js')
  const seen = []
  const host = new SystemBrowserViewHost(
    { kind: 'chrome', path: 'fake-browser' },
    'D:/dsh-workspace/_scratch/headless-probe',
    [],
    undefined,
    (_path, args) => { seen.push(args); return fakeChild() },
    headlessMode,
  )
  try {
    await host.createView().sendCommand('Runtime.evaluate', { expression: '1' })
  } catch {
    // Expected: the stub is not a browser. The arguments are the evidence.
  } finally {
    host.dispose?.()
  }
  return seen[0] ?? []
}

test('a display-less host gets headless, a display gets a window', async () => {
  // The setting exists in the manifest, defaults to auto, and `auto` is resolved from the
  // environment rather than guessed.
  assert.match(settingsStore, /readonly headless: HeadlessMode/, 'the setting is declared')
  assert.match(settingsStore, /browser: \{ channel: 'bundled', headless: 'auto' \}/, 'and defaults to auto')
  assert.match(settingsStore, /export type HeadlessMode = 'auto' \| 'headless' \| 'windowed'/,
    'three modes, not a boolean — a JSON document mixing strings and booleans is ambiguous')
  // Booleans are still accepted, because "headless: true" is what a person writes first.
  assert.match(settingsStore, /if \(value === true\) return 'headless'/, 'true maps to headless')
  assert.match(settingsStore, /if \(value === false\) return 'windowed'/, 'false maps to windowed')
  // And a display-less host must actually be detected, on POSIX only.
  assert.match(systemBrowser, /env\.DISPLAY/, 'DISPLAY is read')
  assert.match(systemBrowser, /env\.WAYLAND_DISPLAY/, 'WAYLAND_DISPLAY is read')
})

test('the headless launch carries the switches a server needs', async () => {
  // `--headless=new`, not the legacy flag: the new mode behaves like a windowed browser, which is
  // what every command here was measured against — including CDP input, which Chromium drops for a
  // view it believes has no display surface.
  const args = await capturedArgs('headless')
  assert.ok(args.includes('--headless=new'), `headless=new must be present: ${JSON.stringify(args)}`)
  assert.ok(args.includes('--disable-gpu'), 'no GPU on a server')
  assert.ok(args.includes('--disable-dev-shm-usage'), '/dev/shm is small in the environments that need this')
  // The CDP plumbing must survive the change.
  assert.ok(args.some(a => a.startsWith('--remote-debugging-port=')), 'debugging port still requested')
  assert.ok(args.some(a => a.startsWith('--user-data-dir=')), 'private profile still used')
})

test('a windowed launch is untouched', async () => {
  // Desktop and sidebar users must not lose the visible window they have today.
  const args = await capturedArgs('windowed')
  assert.ok(!args.includes('--headless=new'), `no headless flag when a window is wanted: ${JSON.stringify(args)}`)
  assert.ok(!args.includes('--disable-gpu'), 'and no headless-only switches')
  assert.ok(args.some(a => a.startsWith('--remote-debugging-port=')), 'still a drivable browser')
})

test('--no-sandbox is conditional and announced, never silent', () => {
  // Dropping the sandbox weakens process isolation, so it happens only where the sandbox cannot
  // start (root, or a container) and is written to stderr — whoever reads the log has to be able
  // to disagree with the decision.
  assert.match(systemBrowser, /function needsNoSandbox\(/, 'the check exists')
  assert.match(systemBrowser, /process\.getuid\(\) === 0/, 'root is one reason')
  assert.match(systemBrowser, /\.dockerenv|env\.container/, 'a container is the other')
  assert.match(systemBrowser, /if \(launch\.headless && needsNoSandbox\(\)\)/,
    'and it only applies to a headless launch')
  assert.match(systemBrowser, /launching with --no-sandbox/, 'the decision is reported')
  // Not unconditional: a plain windowed launch on a desktop keeps the sandbox.
  const windowed = systemBrowser.slice(systemBrowser.indexOf("const launch = resolveLaunchMode"))
  assert.doesNotMatch(windowed.slice(0, windowed.indexOf('about:blank')), /'--no-sandbox'[^']*,\s*$/,
    'not appended unconditionally before the URL')
})

test('an operator can override the setting without editing it', () => {
  // The reporter's point 4.3: a deployment must be fixable by restarting the process with an
  // environment variable, not by patching installed code.
  assert.match(systemBrowser, /DSH_BROWSER_HEADLESS/, 'the variable is read')
  const fn = systemBrowser.slice(systemBrowser.indexOf('function resolveLaunchMode('))
  const body = fn.slice(0, fn.indexOf('\n}'))
  assert.match(body, /override === '1' \|\| override === 'true'/, 'truthy values force headless')
  assert.match(body, /override === '0' \|\| override === 'false'/, 'falsy values force a window')
  // The override must be consulted BEFORE the mode, or a stored setting would win over the
  // operator's explicit emergency switch.
  assert.ok(body.indexOf('DSH_BROWSER_HEADLESS') < body.indexOf("mode === 'headless'"),
    'the override is checked before the configured mode')
})
