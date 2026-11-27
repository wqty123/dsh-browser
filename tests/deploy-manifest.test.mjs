// A directory install must ship the publish-form manifest, or the browser half never registers.
//
// The failure this guards against was real: the installed copy carried the development `exports`
// (`./client` → `./src/client/index.ts`), the host's client-module service served that TypeScript
// file, the browser could not execute it, and the host logged `loaded without registering
// "dsh-builtin-browser" via __ModuleLoader__.load`. npm applies `publishConfig`; a directory link
// does not.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { backupExisting } from '../tools/deploy-local.mjs'
import { assertClientEnvelope, resolveStagedExports, stageManifest } from '../tools/deploy-local.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

test('staging replaces the development exports with the publish ones', () => {
  const staged = stageManifest(manifest)
  assert.equal(staged.exports['./client'], './lib/client.js')
  assert.equal(staged.exports['./browser'], './lib/browser/runtime.js')
  assert.equal(staged.exports['./browser-electron'], './lib/browser-electron/entry.js')
  assert.equal(staged.exports['./tool-browser'], './lib/tool-browser/index.js')
  assert.equal(staged.exports['./startpage'], './lib/startpage.js')
  assert.equal(staged.exports['.'], './lib/index.js')
  // The committed manifest keeps the source exports for workspace development.
  assert.equal(manifest.exports['./client'], './src/client/index.ts')
  // Staging must not mutate the input.
  assert.equal(manifest.publishConfig.exports['./client'], './lib/client.js')
})

test('every staged export points at a file that exists in a built tree', t => {
  const target = mkdtempSync(join(tmpdir(), 'dsh-deploy-'))
  try {
    const staged = stageManifest(manifest)
    for (const specifier of Object.values(staged.exports)) {
      if (specifier === './package.json' || specifier === './cordis.patch.yml') continue
      mkdirSync(join(target, specifier, '..'), { recursive: true })
      writeFileSync(join(target, specifier), '// built\n')
    }
    writeFileSync(join(target, './cordis.patch.yml'), '---\n')
    writeFileSync(join(target, './package.json'), '{}\n')
    const resolved = resolveStagedExports(target, staged)
    assert.equal(Object.keys(resolved).length, Object.keys(staged.exports).length - 1)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('a missing built file is refused instead of deploying a half-installed tree', t => {
  const target = mkdtempSync(join(tmpdir(), 'dsh-deploy-'))
  try {
    const staged = stageManifest(manifest)
    assert.throws(() => resolveStagedExports(target, staged), /missing file/u)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('the client bundle is an envelope, never TypeScript source', t => {
  const target = mkdtempSync(join(tmpdir(), 'dsh-deploy-'))
  try {
    mkdirSync(join(target, 'lib'), { recursive: true })
    writeFileSync(join(target, 'lib/client.js'), 'import type { X } from "y"\n')
    assert.throws(() => assertClientEnvelope(target, { exports: { './client': './lib/client.js' } }), /TypeScript source/u)
    writeFileSync(join(target, 'lib/client.js'), 'window.__ModuleLoader__.load({ id: "dsh-builtin-browser", factory: () => ({}) })\n')
    assert.ok(assertClientEnvelope(target, { exports: { './client': './lib/client.js' } }) > 0)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})
test('replacing an install keeps the previous tree aside (issue #131)', () => {
  const root = mkdtempSync(join(tmpdir(), 'deploy-replace-'))
  const target = join(root, 'plugins', 'dsh-builtin-browser')
  mkdirSync(join(target, 'lib'), { recursive: true })
  writeFileSync(join(target, 'package.json'), '{"name":"dsh-builtin-browser","version":"0.5.8"}')
  const backup = backupExisting(target, new Date('2026-11-28T04:20:00Z'))
  assert.equal(existsSync(target), false, 'the old install is moved, not merged into')
  assert.equal(backup, `${target}.backup-2026-11-28T04-20-00`)
  assert.equal(JSON.parse(readFileSync(join(backup, 'package.json'), 'utf8')).version, '0.5.8')
  rmSync(root, { recursive: true, force: true })
})