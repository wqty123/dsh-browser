// DSH 0.2.3-alpha.2 compatibility contracts that the plugin can check by itself.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { BrowserToolError, toBrowserToolError } from '../src/tool-browser/errors.ts'
import { readSurface } from '../src/tool-browser/state.ts'

const repo = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))

test('Node engines follow the DSH 0.2.3 floor', () => {
  assert.equal(manifest.engines.node, '^24.22.3 || >=26.13.1')
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-error'], 'workspace:^', 'HarnessError comes from the host')
})

test('tool failures carry a stable HarnessError code; cancellations and existing codes pass through', () => {
  const wrapped = toBrowserToolError(new TypeError('page closed'))
  assert.ok(wrapped instanceof HarnessError)
  assert.equal(wrapped.code, 'BROWSER_TOOL_FAILED')
  assert.equal(wrapped.message, 'page closed', 'the model sees the same message')
  assert.ok(wrapped.cause instanceof TypeError)
  assert.equal(toBrowserToolError('plain').message, 'plain')
  const coded = toBrowserToolError(Object.assign(new Error('old bridge'), { code: 'BROWSER_BRIDGE_VERSION_MISMATCH' }))
  assert.ok(coded instanceof HarnessError)
  assert.equal(coded.code, 'BROWSER_BRIDGE_VERSION_MISMATCH', 'an existing code is kept')

  const own = new BrowserToolError('waiting', 'BROWSER_TAKEOVER_PENDING')
  assert.equal(toBrowserToolError(own), own)
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
  assert.equal(toBrowserToolError(abort), abort)
  const controller = new AbortController(); controller.abort()
  const late = new Error('late')
  assert.equal(toBrowserToolError(late, controller.signal), late)
})

test('the surface is read from DSH_HOME only, never a machine-specific path', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-surface-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    assert.equal(readSurface(), 'panel', 'no settings yet')
    mkdirSync(join(home, 'dsh-builtin-browser-host'), { recursive: true })
    writeFileSync(join(home, 'dsh-builtin-browser-host', 'settings.json'), JSON.stringify({ browser: { surface: 'builtin' } }))
    assert.equal(readSurface(), 'builtin')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
  const walk = dir => readdirSync(dir).flatMap(name => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
  for (const file of walk(join(repo, 'src'))) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /['"`][A-Za-z]:[\\/]dsh-home/i, `${file} has no hardcoded DSH home`)
  }
})

test('the host patch accepts DSH 0.2.3-alpha.2 and refuses to write when its artefacts do not match', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-host-patch-023-'))
  try {
    const pkg = JSON.stringify({ name: '@deepseek-ai/dsh-client-ui-sidebar-right', version: '0.2.3-alpha.2' })
    writeFileSync(join(dir, 'package.json'), pkg)
    const script = join(repo, 'dsh-host-patch', 'apply.mjs')
    const run = command => {
      try {
        execFileSync(process.execPath, [script, command, dir], { encoding: 'utf8', stdio: 'pipe' })
        return { code: 0 }
      } catch (error) {
        return { code: error.status, result: JSON.parse(error.stdout) }
      }
    }
    // 0.2.3-alpha.2 now has a spec, so the version on its own is no longer a reason to refuse. What
    // must still hold is that a package whose artefacts are missing (here: no lib/client.js) is
    // rejected without writing anything — that is the safety property, and it is version-agnostic.
    for (const command of ['status', 'apply']) {
      const { code, result } = run(command)
      assert.equal(code, 1, `${command} exits non-zero while the artefacts are missing`)
      assert.notEqual(result.status, 'unsupported version', '0.2.3-alpha.2 has a spec now')
      assert.ok(result.reason, `${command} explains why it refused`)
    }
    assert.deepEqual(readdirSync(dir), ['package.json'], 'no backup, no patched file')
    assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), pkg)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the 0.2.3 spec resolves against the installed DSH artefacts when they are present', t => {
  const sidebar = join(repo, 'node_modules', '@deepseek-ai', 'dsh-client-ui-sidebar-right')
  const manifestPath = join(sidebar, 'package.json')
  const bundle = join(sidebar, 'lib', 'client.js')
  if (!existsSync(manifestPath) || !existsSync(bundle)) {
    t.skip('dsh-client-ui-sidebar-right is not installed with a built bundle')
    return
  }
  const installed = JSON.parse(readFileSync(manifestPath, 'utf8')).version
  if (installed !== '0.2.3-alpha.2') {
    t.skip(`installed sidebar is ${installed}; the 0.2.3 spec only claims 0.2.3-alpha.2`)
    return
  }
  const script = join(repo, 'dsh-host-patch', 'apply.mjs')
  const out = execFileSync(process.execPath, [script, 'status', sidebar], { encoding: 'utf8', stdio: 'pipe' })
  const result = JSON.parse(out)
  assert.equal(result.status, 'absent', 'ready to apply: version accepted and every anchor resolved')
})
