/**
 * Turn the development manifest into the one a consumer receives (tarball or npm).
 *
 * WHY THIS EXISTS
 * The workspace manifest is written for pnpm inside the monorepo: `exports` points at TypeScript
 * sources, and every host peer is declared as `workspace:^`. npm applies `publishConfig` when it
 * publishes, and pnpm rewrites `workspace:` when it packs — but a hand-made tarball (which is how
 * this plugin is handed to users: `pnpm add file:<tarball>.tgz`) keeps both, so the installed
 * package advertises an unresolvable `workspace:^` peer range and a `./client` that is a `.ts` file.
 * That is the shape that produced "the panel stays on its skeleton" for directory installs.
 *
 * This module produces the consumer manifest explicitly, so both distribution routes agree.
 */

/** The oldest DSH this plugin is verified against (single source for the peer range). */
export const HOST_PEER_RANGE = '>=0.2.2-rc.3 <0.3.0'

/**
 * Rewrite one manifest for consumers.
 * @param manifest - the development manifest (parsed package.json).
 * @param options - the host peer range to write.
 * @returns a new manifest: publish-form exports, real peer ranges, no dev-only fields.
 */
export function stagePublishManifest(manifest, options = {}) {
  const peerRange = options.peerRange ?? HOST_PEER_RANGE
  const publishExports = manifest.publishConfig?.exports
  if (publishExports === undefined) throw new Error('package.json has no publishConfig.exports; run the build first')
  const peers = { ...(manifest.peerDependencies ?? {}) }
  let rewritten = 0
  for (const [name, range] of Object.entries(peers)) {
    if (typeof range === 'string' && range.startsWith('workspace:')) {
      peers[name] = peerRange
      rewritten += 1
    }
  }
  const staged = {
    ...manifest,
    exports: publishExports,
    ...(Object.keys(peers).length === 0 ? {} : { peerDependencies: peers }),
  }
  delete staged.publishConfig
  delete staged.devDependencies
  delete staged.scripts
  delete staged.files
  return { manifest: staged, rewrittenPeers: rewritten }
}

/**
 * Report every peer range that a consumer could not resolve.
 * @param manifest - any manifest.
 * @returns the offending entries, empty when the manifest is consumer-safe.
 */
export function unresolvedPeerRanges(manifest) {
  return Object.entries(manifest.peerDependencies ?? {})
    .filter(([, range]) => typeof range === 'string' && (range.startsWith('workspace:') || range.trim() === ''))
    .map(([name]) => name)
}
