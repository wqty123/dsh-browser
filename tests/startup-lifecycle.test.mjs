// The system-browser startup lifecycle, from #29.
//
// Two defects that were reported together because they both happen at the same moment — when the
// plugin brings a browser up — and they have nothing else in common. One lost a page; the other
// lost the whole browser, every time DSH restarted.
//
// The browser here is a real Chrome, and the assertions are about the ORDER of operations and the
// SHAPE of the decisions, because the failures are invisible in a unit: an extra page is invisible
// to the tool layer, and a hand-off looks like a launch failure.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = () => readFileSync(new URL('../src/browser-electron/system-browser.ts', import.meta.url), 'utf8')

/** The body of one method, so an assertion cannot be satisfied by a neighbouring one. */
function body(name) {
  const text = source()
  // Three forms appear in this class: `private async x(`, `private x(`, and a bare `x(` for the
  // public members (`dispose`).
  const candidates = [`private async ${name}(`, `private ${name}(`, `\n  ${name}(`]
  const start = candidates.map(candidate => text.indexOf(candidate)).find(found => found !== -1)
  assert.notEqual(start, undefined, `${name} exists`)
  // Braces are balanced in this file, so the first column-2 close is the end of the member.
  const end = text.indexOf('\n  }\n', start)
  assert.notEqual(end, -1, `${name} has an end`)
  return text.slice(start, end)
}

test('a browser left running by a previous DSH is adopted, not raced', async () => {
  const start = body('start')
  // Adoption comes FIRST. It has to: by the time a launch has been attempted and come back as a
  // hand-off, the profile is already held and the user has already seen a failure.
  const adoptAt = start.indexOf('this.adoptRunningBrowser(')
  const spawnAt = start.indexOf('this.launcher(')
  assert.notEqual(adoptAt, -1, 'start() tries to adopt a running browser')
  assert.notEqual(spawnAt, -1, 'and still launches when there is none')
  assert.ok(adoptAt < spawnAt, 'adoption is attempted before launching, not after')

  const adopt = body('adoptRunningBrowser')
  // A port number proves nothing on its own — it can be reused once the browser that owned it
  // exits. The endpoint has to identify itself, twice, through two different channels.
  assert.match(adopt, /version\.Browser/, 'the HTTP endpoint is asked to name itself')
  assert.match(adopt, /Browser\.getVersion/, 'and the protocol is asked too')
  assert.match(adopt, /chrome\|chromium\|edge/i, 'and the answer must name a browser')
})

test('a hand-off reads as "the browser is already there", not as a failure', () => {
  const text = source()
  const exitedAt = text.indexOf("if (stopped === 'exited')")
  assert.notEqual(exitedAt, -1, 'the exited branch exists')
  const branch = text.slice(exitedAt, text.indexOf('if (stopped === ', exitedAt + 10))
  // Exit code 0 is the hand-off signature: the request went to the instance holding the profile.
  // That instance is the browser this host wanted, so the right answer is to connect to it.
  assert.match(branch, /if \(clean\) \{[\s\S]{0,200}adoptRunningBrowser/, 'a clean exit retries adoption')
  // The non-zero case still has to reach the user: a crash or a missing library is not a hand-off.
  assert.match(branch, /clean\s*\n?\s*\?/, 'and the message still distinguishes the two')
})

test('blank pages are collapsed, with discovery enabled first', () => {
  const normalize = body('normalizeBlankPages')
  // Without discovery the browser may omit pages that existed before this client connected —
  // which is exactly the page that needs closing. Skipping it is how the first attempt failed
  // silently.
  const discoverAt = normalize.indexOf('Target.setDiscoverTargets')
  const getAt = normalize.indexOf('Target.getTargets')
  assert.notEqual(discoverAt, -1, 'discovery is turned on')
  assert.notEqual(getAt, -1, 'and the targets are listed')
  assert.ok(discoverAt < getAt, 'discovery comes first')

  // One blank is KEPT — buildSession adopts it. Closing all of them would put the plugin back to
  // creating a page while the browser's own page sits there unclaimed.
  assert.match(normalize, /if \(!kept\) \{ kept = true; continue \}/, 'exactly one blank is kept')
  // And a page the plugin is already driving is never closed, however blank it looks.
  assert.match(normalize, /claimed\.has\(targetId\)/, 'claimed targets are skipped')
})

test('a view adopts a blank page instead of discarding the one the browser opened', () => {
  const build = body('buildSession')
  assert.match(build, /await this\.adoptBlankTarget\(client\)/, 'adoption is attempted')
  assert.match(build, /adopted \?\? await this\.createTarget\(client\)/, 'and creation is the fallback')

  const adopt = body('adoptBlankTarget')
  // Two views sharing one page would be worse than an extra tab, so an already-claimed target is
  // not eligible.
  assert.match(adopt, /claimed\.has\(entry\.targetId\)/, 'a claimed page is never handed to a second view')
  assert.match(adopt, /isBlankUrl\(entry\.url\)/, 'and only blanks are considered')
})

test('only real blanks are eligible for closing', () => {
  const text = source()
  const at = text.indexOf('function isBlankUrl(')
  assert.notEqual(at, -1, 'the predicate exists')
  const fn = text.slice(at, text.indexOf('\n}\n', at))
  // Narrow on purpose: the caller CLOSES what this returns, so a loose test ("no path",
  // "starts with chrome://") would eventually match a page the user is reading.
  assert.match(fn, /url === 'about:blank'/, 'about:blank qualifies')
  assert.match(fn, /chrome:\/\/newtab/, "Chrome's new-tab page qualifies")
  assert.doesNotMatch(fn, /startsWith\('chrome:\/\/'\)\)/, 'but not every chrome:// page')
  assert.doesNotMatch(fn, /url === ''|url\.length === 0/, 'and not an empty string')
})

test('teardown asks the browser to close before killing it', () => {
  const dispose = body('dispose')
  // A hard kill is TerminateProcess on Windows: the browser never flushes its profile, and Chrome
  // records how it ended — so the NEXT launch reads the profile as crashed and offers to restore
  // a session. That is a visible extra window, traced back to this line.
  const closeAt = dispose.indexOf("'Browser.close'")
  const doomAt = dispose.indexOf('const doomed')
  assert.notEqual(closeAt, -1, 'the browser is asked to close')
  assert.notEqual(doomAt, -1, 'and the kill path still exists')
  assert.ok(closeAt < doomAt, 'the request comes before the kill')
  assert.match(dispose, /setTimeout\(force, CLOSE_GRACE_MS\)/, 'the kill waits a bounded grace period')
  assert.match(dispose, /timer\.unref\?\.\(\)/, "and the timer never holds the process open")
})
