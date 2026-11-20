// Issue #41: installing the plugin must not depend on a network download.
//
// The report is a plugin-market install of 0.5.2 that failed twice: first because pnpm's allowlist
// blocked our `postinstall` (`ERR_PNPM_IGNORED_BUILDS`), and then — once the build script was
// allowed — because the download inside it hit `TypeError: fetch failed` and the postinstall exited
// 1, which fails the whole install.
//
// Both defects are about WHERE the download lives, so the tests are about that too: the package must
// carry no install-time script, and whatever provisions the runtime later must be unable to fail an
// install or hold a tool call open.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import {
  PROVISION_TIMEOUT_MS,
  defaultDeps,
  ensureElectronRuntime,
  provisionElectronInBackground,
  provisionSnapshot,
  resetProvisionStateForTest,
} from '../lib/browser-electron/electron-provision.js'

const manifest = () => JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** Dependencies that record what was asked for, so a test can count attempts. */
function fakeDeps(overrides = {}) {
  const calls = { hasBinary: 0, installerScript: 0, run: 0, log: [] }
  const deps = {
    hasBinary: () => { calls.hasBinary += 1; return false },
    installerScript: () => { calls.installerScript += 1; return 'C:/fake/electron/install.js' },
    run: async () => { calls.run += 1; return { code: 0 } },
    log: message => { calls.log.push(String(message)) },
    skip: () => false,
    timeoutMs: 50,
    ...overrides,
  }
  return { deps, calls }
}

test('the package carries no install-time lifecycle script', () => {
  // The exact defect in the report. Every install-time hook is listed because pnpm's allowlist and
  // npm's lifecycle both key off these names, and one of them is enough to fail an install.
  const scripts = manifest().scripts ?? {}
  for (const forbidden of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert.equal(scripts[forbidden], undefined,
      `"${forbidden}" runs during installation, where a network download must never live`)
  }
  // The manual retry path stays available, and the runtime dependency stays declared.
  assert.equal(manifest().bin['dsh-browser-install-electron'], 'scripts/install-electron.mjs',
    'an operator can still provision it explicitly')
  assert.equal(typeof manifest().dependencies.electron, 'string',
    'and the package that ships the runtime is still a dependency')
})

test('a runtime that is already there is not touched', async () => {
  const { deps, calls } = fakeDeps({ hasBinary: () => true })
  const result = await ensureElectronRuntime(deps)
  assert.equal(result.status, 'present')
  assert.equal(calls.run, 0, 'no download, because none is needed')
})

test('the documented opt-out is honoured', async () => {
  const { deps, calls } = fakeDeps({ skip: () => true })
  const result = await ensureElectronRuntime(deps)
  assert.equal(result.status, 'skipped')
  assert.equal(calls.run, 0)
})

test('a successful provision reports ready and logs one line', async () => {
  const { deps, calls } = fakeDeps()
  const result = await ensureElectronRuntime(deps)
  assert.equal(result.status, 'ready')
  assert.equal(calls.run, 1)
  assert.equal(calls.log.length, 1, 'a download is announced, once')
})

test('a failed download is a status, not an exception, and names the retry', async () => {
  // This is the shape of the reported failure (`fetch failed`): a network error. It must not reach
  // the caller as a rejection — the caller is a plugin start, and an install must already be done.
  const { deps } = fakeDeps({ run: async () => ({ code: 1, detail: 'TypeError: fetch failed' }) })
  const result = await ensureElectronRuntime(deps)
  assert.equal(result.status, 'failed')
  assert.match(result.detail, /fetch failed/, 'the reason is carried through')
  assert.match(result.detail, /dsh-browser-install-electron/, 'and the command that retries it is named')
  assert.match(result.detail, /sidebar, Chrome or Edge/, 'and what still works meanwhile')
})

test('a throwing installer does not escape either', async () => {
  const { deps } = fakeDeps({ run: async () => { throw new Error('spawn EPERM') } })
  const result = await ensureElectronRuntime(deps)
  assert.equal(result.status, 'failed')
  assert.match(result.detail, /spawn EPERM/)
})

test('a download that never finishes is abandoned, not awaited forever', async () => {
  const { deps } = fakeDeps({ run: () => new Promise(() => {}), timeoutMs: 30 })
  const started = Date.now()
  const result = await ensureElectronRuntime(deps)
  assert.equal(result.status, 'failed')
  assert.match(result.detail, /gave up/, 'bounded, because this may run while a tool call is waiting')
  assert.ok(Date.now() - started < 5_000, 'and the bound is what the caller asked for')
})

test('an incomplete electron package is a named failure, not a crash', async () => {
  const { deps, calls } = fakeDeps({ installerScript: () => undefined })
  const result = await ensureElectronRuntime(deps)
  assert.equal(result.status, 'failed')
  assert.match(result.detail, /no install\.js/)
  assert.equal(calls.run, 0)
})

test('concurrent callers share one attempt', async () => {
  // Two tool calls arriving together must not start two downloads into the same directory.
  resetProvisionStateForTest()
  const { deps, calls } = fakeDeps({ run: async () => { calls.run += 1; return { code: 0 } } })
  const first = provisionElectronInBackground(() => {}, deps)
  const second = provisionElectronInBackground(() => {}, deps)
  assert.equal(first, second, 'the same promise is handed back')
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.status, 'ready')
  assert.equal(b.status, 'ready')
  assert.equal(calls.run, 1, 'one download for both callers')
  resetProvisionStateForTest()
})

test('the bound settles even when nothing else holds the event loop', async () => {
  // This is the shape CI caught and a normal in-process test does not: one pending download and no
  // other handles. The first implementation unref'd the timeout so it would not "keep the process
  // alive"; with nothing else on the loop that timer never fired, the promise never settled, and node
  // reported `Promise resolution is still pending but the event loop has already resolved`.
  const moduleUrl = new URL('../lib/browser-electron/electron-provision.js', import.meta.url).href
  const script = `
    import { ensureElectronRuntime } from ${JSON.stringify(moduleUrl)}
    const result = await ensureElectronRuntime({
      hasBinary: () => false,
      installerScript: () => 'C:/fake/install.js',
      run: () => new Promise(() => {}),
      log: () => {},
      skip: () => false,
      timeoutMs: 50,
    })
    console.log(JSON.stringify(result))
  `
  const started = Date.now()
  const { stdout, status } = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 20_000,
  })
  assert.equal(status, 0, `the child exited cleanly: ${stdout}`)
  const parsed = JSON.parse(stdout.trim().split('\n').at(-1))
  assert.equal(parsed.status, 'failed', 'the bound fired and reported a status')
  assert.match(parsed.detail, /gave up/)
  assert.ok(Date.now() - started < 15_000, 'and it did so promptly')
})

test('the real defaults are offline until something asks', () => {
  // No spawn happens until a caller asks for a provision: the default dependency set is inert.
  const deps = defaultDeps(() => {})
  assert.equal(typeof deps.hasBinary, 'function')
  assert.equal(PROVISION_TIMEOUT_MS >= 60_000, true, 'a real download gets a real budget')
})

test('a timeout kills the real installer process before another can write', async () => {
  resetProvisionStateForTest()
  const folder = mkdtempSync(join(tmpdir(), 'dsh-provision-cancel-'))
  const pidFile = join(folder, 'pid')
  const installer = join(folder, 'slow.cjs')
  writeFileSync(installer, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`)
  const runner = defaultDeps()
  const cleanup = new AbortController()
  let installerJob
  const deps = {
    ...runner,
    run: (script, signal) => {
      // The real provision signal still drives cancellation. A separate owned
      // signal lets finally settle this exact job without targeting a bare PID.
      installerJob = runner.run(script, signal === undefined ? cleanup.signal : AbortSignal.any([signal, cleanup.signal]))
      return installerJob
    },
    hasBinary: () => false,
    installerScript: () => installer,
    skip: () => false,
    // Full-suite process/CIM load can make a cold Node start exceed a second. The
    // process must be observed alive before this test claims its timeout killed it.
    timeoutMs: 8000,
  }
  const attempt = provisionElectronInBackground(() => {}, deps)
  let pid
  try {
    const startupDeadline = Date.now() + 6000
    while (Date.now() < startupDeadline) {
      if (existsSync(pidFile)) {
        const candidate = Number(readFileSync(pidFile, 'utf8'))
        if (Number.isSafeInteger(candidate) && candidate > 0) { pid = candidate; break }
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.ok(pid !== undefined, 'the actual installer initialized before its cancellation budget')
    assert.doesNotThrow(() => process.kill(pid, 0), 'the fixture child is alive before the provision timeout')
    const outcome = await attempt
    assert.equal(outcome.status, 'failed')
    assert.match(outcome.detail, /gave up/, 'the real provision deadline triggered cancellation')
    for (let n = 0; n < 200; n += 1) {
      try { process.kill(pid, 0) } catch { break }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.throws(() => process.kill(pid, 0), /ESRCH|no such process/i)
  } finally {
    // Retain and settle this exact fixture job even if readiness fails. The
    // cancellation assertion above runs before this cleanup signal is aborted.
    cleanup.abort()
    await attempt
    await installerJob
    resetProvisionStateForTest()
    const target = resolve(folder)
    assert.equal(dirname(target).toLowerCase(), resolve(tmpdir()).toLowerCase())
    assert.match(basename(target), /^dsh-provision-cancel-/)
    rmSync(target, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The readiness state machine the settings panel renders (0.5.6).
//
// "Nothing has been asked for" and "a download is running right now" are the two states a log line
// never needed and a user always does: they are exactly when a first browser call is slow or fails,
// and neither was visible anywhere in the product before this.
// ---------------------------------------------------------------------------

test('before anything is asked for, the state is idle and says so', () => {
  resetProvisionStateForTest()
  const snapshot = provisionSnapshot()
  assert.equal(snapshot.state, 'idle')
  assert.match(snapshot.detail, /not been asked/)
})

test('a download in flight is visible before it finishes', async () => {
  resetProvisionStateForTest()
  // A `run` that never settles: the point is what the STATE says while it hangs.
  const { deps } = fakeDeps({ run: () => new Promise(() => {}), timeoutMs: 30 })
  const attempt = ensureElectronRuntime(deps)
  // The state is written before the installer is awaited, so it is readable without a timer.
  assert.equal(provisionSnapshot().state, 'preparing')
  assert.match(provisionSnapshot().detail, /downloading Electron/)
  const result = await attempt
  assert.equal(result.status, 'failed', 'and it still settles, on the bound')
  assert.equal(provisionSnapshot().state, 'failed')
})

test('a settled failure can be retried, and an attempt in flight cannot', async () => {
  // Without `force`, the memoised attempt made a failed download permanent for the life of the
  // process: the panel could offer a retry button whose call returned the failure it was replacing.
  resetProvisionStateForTest()
  let runs = 0
  const deps = () => fakeDeps({ run: async () => { runs += 1; return { code: runs === 1 ? 1 : 0 } } }).deps
  const first = await provisionElectronInBackground(() => {}, deps())
  assert.equal(first.status, 'failed')

  const forced = await provisionElectronInBackground(() => {}, deps(), { force: true })
  assert.equal(forced.status, 'ready', 'a forced retry runs the installer again')
  assert.equal(runs, 2, 'exactly once more')

  // And a forced call while one is running joins it rather than starting a second download into the
  // same directory.
  resetProvisionStateForTest()
  let started = 0
  const slow = () => fakeDeps({ run: async () => { started += 1; return { code: 0 } } }).deps
  const a = provisionElectronInBackground(() => {}, slow())
  const b = provisionElectronInBackground(() => {}, slow(), { force: true })
  assert.equal(a, b, 'the in-flight attempt is shared')
  await Promise.all([a, b])
  assert.equal(started, 1)
  resetProvisionStateForTest()
})

test('a failure names the panel, not only the command line', async () => {
  // The old message told a GUI user to run `npx` in a terminal. It still says that, and now also
  // names the button that does the same thing without one.
  const { deps } = fakeDeps({ run: async () => ({ code: 1, detail: 'TypeError: fetch failed' }) })
  const result = await ensureElectronRuntime(deps)
  assert.match(result.detail, /Readiness/, 'the panel path is named')
  assert.match(result.detail, /dsh-browser-install-electron/, 'and the terminal path stays available')
})
