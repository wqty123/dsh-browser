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
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/browser-electron/system-browser.ts', import.meta.url), 'utf8')

/** A child-process stub the launcher returns; the host only reads exit codes off it. */
function fakeChild() {
  return { exitCode: null, signalCode: null, kill() {}, once() {}, on() {} }
}

/** The arguments a launch would use, captured without running a browser. */
async function capturedArgs(headlessMode) {
  const { SystemBrowserViewHost } = await import('../lib/browser-electron/system-browser.js')
  const seen = []
  const host = new SystemBrowserViewHost(
    { kind: 'chrome', path: 'fake-browser' },
    'D:/dsh-workspace/_scratch/startup-args-probe',
    [],
    undefined,
    (_path, args) => { seen.push(args); return fakeChild() },
    headlessMode,
  )
  try {
    await host.createView().sendCommand('Runtime.evaluate', { expression: '1' })
  } catch {
    // Expected: the stub is not a browser.
  } finally {
    host.dispose?.()
  }
  return seen[0] ?? []
}

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

test('a hand-off is adopted with a bounded retry, not a single attempt', () => {
  // The reporter's measurement: the stub is gone before the port file lands, so one attempt reads
  // too early. The loop must exist, must be bounded, and must stop when the host is disposed.
  assert.match(source, /const HANDOFF_ADOPT_MS = 8_000/, 'the bound is a named constant')
  const branch = source.slice(source.indexOf("if (clean) {"))
  const body = branch.slice(0, branch.indexOf('throw new Error('))
  assert.match(body, /const deadline = Date\.now\(\) \+ HANDOFF_ADOPT_MS/, 'a deadline is computed')
  assert.match(body, /for \(;;\) \{/, 'and the adoption is retried in a loop')
  assert.match(body, /await this\.adoptRunningBrowser\('after a hand-off'\)/, 'attempting adoption each pass')
  assert.match(body, /if \(recovered !== undefined\) return recovered/, 'returning as soon as it works')
  assert.match(body, /this\.disposed \|\| Date\.now\(\) >= deadline/, 'and stopping on disposal or timeout')
  // Polling on the same interval as the port probe keeps one iteration's worst case predictable.
  assert.match(body, /setTimeout\(resolve, PORT_PROBE_MS\)/, 'polling at the established interval')
})

test('a failed launch is still reported as a failure, not retried into silence', () => {
  // The retry is only for exit code 0. A non-zero code or a signal means the browser died on its
  // own, and retrying would turn a clear "check that it can run" into an 8-second pause before the
  // same message.
  const branch = source.slice(source.indexOf('if (stopped === \'exited\') {'))
  const body = branch.slice(0, branch.indexOf('if (stopped === \'released\')'))
  assert.match(body, /const clean = code === 0 && signal === null/, 'only a clean exit is a hand-off')
  const retryAt = body.indexOf('const deadline = Date.now()')
  const cleanGuardAt = body.indexOf('if (clean) {')
  assert.ok(cleanGuardAt !== -1 && retryAt > cleanGuardAt, 'the retry lives INSIDE the clean branch')
  // And the non-clean message still says the browser failed rather than deferring.
  assert.match(body, /did not\s*\n?\s*\+?\s*'?\s*hand the request anywhere|hand the request anywhere/,
    'a dirty exit still says it never handed off')
})
