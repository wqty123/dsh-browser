// A consumer must never receive `workspace:` peers or a TypeScript `./client` (issue #59's shape).
//
// Measured while simulating a from-zero tarball install into a DSH 0.2.3-alpha.2 desktop profile:
// the tarball built from the development manifest advertised `peerDependencies: workspace:^` for all
// six host peers. npm tolerates it only because pnpm rewrites `workspace:` when it packs for the
// registry; a hand-made tarball does not, and that is exactly the tarball this repo hands users.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stagePublishManifest, unresolvedPeerRanges, HOST_PEER_RANGE } from '../scripts/publish-manifest.mjs'

const devManifest = () => ({
  name: 'dsh-builtin-browser',
  version: '9.9.9',
  exports: { '.': './lib/index.js', './client': './src/client/index.ts' },
  publishConfig: { exports: { '.': './lib/index.js', './client': './lib/client.js' } },
  peerDependencies: { '@deepseek-ai/cordis': 'workspace:^', '@deepseek-ai/dsh-tools': 'workspace:^' },
  devDependencies: { typescript: '1' },
  scripts: { build: 'x' },
})

test('the staged manifest carries the publish-form exports, not the sources', () => {
  const { manifest } = stagePublishManifest(devManifest())
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.publishConfig, undefined)
  assert.equal(manifest.devDependencies, undefined)
  assert.equal(manifest.scripts, undefined)
})

test('every workspace peer becomes a real range', () => {
  const { manifest, rewrittenPeers } = stagePublishManifest(devManifest())
  assert.equal(rewrittenPeers, 2)
  for (const range of Object.values(manifest.peerDependencies)) assert.equal(range, HOST_PEER_RANGE)
  assert.deepEqual(unresolvedPeerRanges(manifest), [], 'nothing left for a consumer to choke on')
})

test('a manifest without publishConfig.exports is refused, because it is not built yet', () => {
  const manifest = devManifest()
  delete manifest.publishConfig
  assert.throws(() => stagePublishManifest(manifest), /publishConfig\.exports/u)
})
