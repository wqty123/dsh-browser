import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { packedPackage } from './fixtures/packed-package.mjs'

test('pack includes the extension and dependency-free native host; extract-only installation works', t => {
  const sourceManifest = new URL('../package.json', import.meta.url)
  const before = readFileSync(sourceManifest)
  const modified = statSync(sourceManifest, { bigint: true }).mtimeNs
  const { root, pkg, manifest, run } = packedPackage(t)
  assert.deepEqual(readFileSync(sourceManifest), before, 'pack must not rewrite the checkout manifest')
  assert.equal(statSync(sourceManifest, { bigint: true }).mtimeNs, modified, 'even transient manifest rewrites must stay in staging')
  assert.ok(manifest.files.includes('browser-extension')); assert.ok(manifest.files.includes('native-host'))
  const directory = join(root, 'native'), extensionId = 'a'.repeat(32)
  assert.equal(existsSync(join(pkg, 'node_modules')), false)
  const extension = JSON.parse(readFileSync(join(pkg, 'browser-extension/manifest.json'), 'utf8'))
  assert.deepEqual(extension.permissions, ['debugger', 'tabs', 'storage', 'nativeMessaging', 'alarms'])
  assert.equal(extension.host_permissions, undefined); assert.equal(extension.externally_connectable, undefined)
  const result = JSON.parse(run(process.execPath, [join(pkg, 'native-host/install.mjs'), '--browser', 'edge', '--extension-id', extensionId, '--directory', directory, '--no-register']))
  const host = JSON.parse(readFileSync(result.manifestPath, 'utf8'))
  assert.deepEqual(host.allowed_origins, [`chrome-extension://${extensionId}/`])
  assert.equal(existsSync(host.path), true); assert.equal(result.token.length, 32)
  const config = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'))
  assert.equal(config.token, undefined); assert.equal(config.pairDigest.length, 64)
  if (process.platform !== 'win32') {
    assert.equal(statSync(directory).mode & 0o777, 0o700)
    assert.equal(statSync(join(directory, 'config.json')).mode & 0o777, 0o600)
    const denied = spawnSync(host.path, [`chrome-extension://${'b'.repeat(32)}/`], { encoding: 'utf8' })
    assert.equal(denied.status, 1); assert.equal(denied.stdout, '')
  }
  const revoked = JSON.parse(run(process.execPath, [join(pkg, 'native-host/install.mjs'), '--browser', 'edge', '--extension-id', extensionId, '--directory', directory, '--revoke', '--no-register']))
  assert.equal(revoked.revoked, true)
  const final = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'))
  assert.equal(final.installId, undefined); assert.equal(final.pairDigest, undefined); assert.notEqual(final.secret, config.secret)
})
