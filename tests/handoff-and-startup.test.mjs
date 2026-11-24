// Two defects from issue #33, both measured on Windows 11 with Chrome 156.
//
// Bug 1: the launcher stub exits 0 before the browser writes DevToolsActivePort (300 ms vs 441 ms),
// so a single adoption attempt read too early and reported "exited immediately after launch" for a
// browser that was starting normally. Exit code 0 is the hand-off story, and it needs a retry.
//
// Bug 2: the launch args ended with `about:blank`, so every browser opened a startup tab that the
// plugin never created and never closes. `dsh_browser_list_tabs` reported only the real page while
// the tab strip showed two.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const source = readFileSync(new URL('../src/browser-electron/system-browser.ts', import.meta.url), 'utf8')

/** A child-process stub the launcher returns; the host only reads exit codes off it. */
function fakeChild() {
  return { exitCode: 1, signalCode: null, kill() {}, once() {}, on() {} }
}

/** The arguments a launch would use, captured without running a browser. */
async function capturedArgs(headlessMode, quiet = false) {
  const { SystemBrowserViewHost } = await import('../lib/browser-electron/system-browser.js')
  const seen = []
  const profile = mkdtempSync(join(tmpdir(), 'dsh-startup-args-'))
  const host = new SystemBrowserViewHost(
    { kind: 'chrome', path: 'fake-browser' },
    profile,
    [],
    undefined,
    (_path, args) => { seen.push(args); return fakeChild() },
    headlessMode,
    () => quiet,
  )
  try {
    await host.createView().sendCommand('Runtime.evaluate', { expression: '1' })
  } catch {
    // Expected: the stub is not a browser.
  } finally {
    host.dispose?.()
    rmSync(profile, { recursive: true, force: true })
  }
  return seen[0] ?? []
}

test('the launch keeps an off-screen quiet window rendering at full speed', async () => {
  const args = await capturedArgs('windowed')
  for (const flag of ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling']) {
    assert.ok(args.includes(flag), flag + ' must be present: ' + JSON.stringify(args))
  }
})

test('a quiet launch places new windows off-screen before Chromium shows them', async () => {
  const args = await capturedArgs('windowed', true)
  assert.ok(args.includes('--window-position=10000,0'), JSON.stringify(args))
  assert.ok(args.includes('--window-size=1280,800'), JSON.stringify(args))
  for (const [mode, quiet] of [['windowed', false], ['headless', true]]) {
    const other = await capturedArgs(mode, quiet)
    assert.ok(!other.some(arg => arg.startsWith('--window-position') || arg.startsWith('--window-size')), mode + ' ' + JSON.stringify(other))
  }
})

test('the launch asks for no startup window, so no tab appears that we never created', async () => {
  const args = await capturedArgs('windowed')
  assert.ok(args.includes('--no-startup-window'),
    `--no-startup-window must be present: ${JSON.stringify(args)}`)
  // `about:blank` as a positional URL is what opened the unwanted tab. It may still appear as a
  // navigable string elsewhere in the source, so this checks the ARGUMENTS, not the file.
  assert.ok(!args.includes('about:blank'),
    `no positional startup page: ${JSON.stringify(args)}`)
  // The browser still has to be drivable: the plugin creates its own page afterwards.
  assert.ok(args.some(a => a.startsWith('--remote-debugging-port=')), 'CDP port still requested')
  assert.ok(args.some(a => a.startsWith('--user-data-dir=')), 'private profile still used')
})

test('a hand-off shares the launch deadline instead of a second adoption budget', () => {
  // The reporter's measurement: the stub is gone before the port file lands, so one attempt reads
  // too early. The loop must exist, must be bounded, and must stop when the host is disposed.
  assert.doesNotMatch(source, /HANDOFF_ADOPT_MS/)
  const body = source.slice(source.indexOf('private async start('), source.indexOf('  available():'))
  assert.equal((body.match(/const deadline =/g) ?? []).length, 1)
  assert.match(body, /child\.exitCode !== null && child\.exitCode !== 0/)
  assert.match(body, /Date\.now\(\) > deadline/)
  assert.match(body, /client\.whenReady\(deadline\)/)
  // Polling on the same interval as the port probe keeps one iteration's worst case predictable.
  assert.match(body, /setTimeout\(resolve, 250\)/)
})

test('a failed launch is still reported as a failure, not retried into silence', () => {
  // The retry is only for exit code 0. A non-zero code or a signal means the browser died on its
  // own, and retrying would turn a clear "check that it can run" into an 8-second pause before the
  // same message.
  const branch = source.slice(source.indexOf('if (stopped === \'exited\') {'))
  const body = branch.slice(0, branch.indexOf('if (stopped === \'released\')'))
  assert.match(source, /child\.signalCode !== null \|\| \(child\.exitCode !== null && child\.exitCode !== 0\)/)
  assert.doesNotMatch(body, /const deadline =/, 'a failed launch cannot reset its deadline')
  // And the non-clean message still says the browser failed rather than deferring.
  assert.match(body, /did not\s*\n?\s*\+?\s*'?\s*hand the request anywhere|hand the request anywhere/,
    'a dirty exit still says it never handed off')
})
