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
import { readFileSync } from 'node:fs'

import {
  PROVISION_TIMEOUT_MS,
  defaultDeps,
  ensureElectronRuntime,
  provisionElectronInBackground,
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

test('the real defaults are offline until something asks', () => {
  // No spawn happens until a caller asks for a provision: the default dependency set is inert.
  const deps = defaultDeps(() => {})
  assert.equal(typeof deps.hasBinary, 'function')
  assert.equal(PROVISION_TIMEOUT_MS >= 60_000, true, 'a real download gets a real budget')
})
