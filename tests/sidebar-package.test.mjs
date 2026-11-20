import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { browserHostLogPath, dshHome } from '../lib/browser-electron/paths.js'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')

test('supported package exports cannot launch standalone Electron', () => {
  const manifest = JSON.parse(read('../package.json'))
  assert.equal(manifest.exports['./host-main'], undefined)
  assert.equal(manifest.publishConfig.exports['./host-main'], undefined)
  for (const path of ['../src/index.ts', '../src/browser-electron/entry.ts']) {
    assert.doesNotMatch(read(path), /export[^\n]*\b(?:RemoteElectronViewHost|defaultHostMainPath)\b/)
  }
  assert.doesNotMatch(read('../scripts/fix-exports.mjs'), /['"]\.\/host-main['"]\s*:/)
  assert.doesNotMatch(read('../src/browser-electron/host-main.ts'), /app\.(?:on|once)\(['"]activate['"]/)
})

test('export guard accepts sidebar exports and refuses either standalone subpath', t => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-sidebar-package-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  mkdirSync(join(directory, 'scripts'))
  copyFileSync(new URL('../scripts/verify-exports.mjs', import.meta.url), join(directory, 'scripts', 'verify-exports.mjs'))
  const manifest = JSON.parse(read('../package.json'))
  for (const target of [undefined, 'exports', 'publishConfig']) {
    const changed = structuredClone(manifest)
    if (target === 'exports') changed.exports['./host-main'] = './src/browser-electron/host-main.ts'
    if (target === 'publishConfig') changed.publishConfig.exports['./host-main'] = './lib/browser-electron/host-main.js'
    writeFileSync(join(directory, 'package.json'), JSON.stringify(changed))
    const result = spawnSync(process.execPath, [join(directory, 'scripts', 'verify-exports.mjs')], { encoding: 'utf8' })
    assert.equal(result.error, undefined)
    assert.equal(result.status, target === undefined ? 0 : 1, result.stdout + result.stderr)
    if (target !== undefined) assert.match(result.stderr, /standalone host-main must not be exported/)
  }
})

test('diagnostics share the resolved DSH home with settings, including empty or absent overrides', () => {
  const previous = process.env.DSH_HOME
  try {
    for (const override of [undefined, '', join(tmpdir(), 'dsh-custom-home')]) {
      if (override === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = override
      const expected = override || join(homedir(), '.dsh')
      assert.equal(dshHome(), expected)
      assert.equal(browserHostLogPath(), join(expected, 'logs', 'dsh-builtin-browser-host.log'))
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})
