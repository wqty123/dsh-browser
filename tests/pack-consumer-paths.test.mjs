// The staged manifest must keep `files`, and the staged tree must contain every runtime path.
//
// This is the regression that shipped 1.0.3 without `browser-extension/`: `native-host/install.mjs`
// imports it, so every native-host registration died with ERR_MODULE_NOT_FOUND on a real install.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stagePublishManifest } from '../scripts/publish-manifest.mjs'
import { missingConsumerPaths, CONSUMER_PATHS } from '../scripts/pack.mjs'

test('the staged manifest keeps the files list that governs the tarball', () => {
  const manifest = {
    name: 'x', version: '1.0.0',
    exports: { './client': './src/client/index.ts' },
    publishConfig: { exports: { './client': './lib/client.js' } },
    peerDependencies: { '@deepseek-ai/cordis': 'workspace:^' },
    files: ['lib', 'browser-extension', 'native-host'],
    scripts: { build: 'x' },
  }
  const { manifest: staged } = stagePublishManifest(manifest)
  assert.deepEqual(staged.files, ['lib', 'browser-extension', 'native-host'], 'files decides what a consumer receives')
  assert.equal(staged.scripts, undefined)
})

test('a staged tree missing a runtime path is refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'pack-guard-'))
  try {
    for (const path of CONSUMER_PATHS) {
      const file = join(root, path)
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, '')
    }
    assert.deepEqual(missingConsumerPaths(root), [], 'a complete tree passes')
    rmSync(join(root, 'browser-extension', 'constants.mjs'))
    assert.deepEqual(missingConsumerPaths(root), ['browser-extension/constants.mjs'], 'the exact path is named')
  } finally { rmSync(root, { recursive: true, force: true }) }
})