import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

test('pack includes the extension and dependency-free native host; extract-only installation works', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-extension-pack-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const staging = join(root, 'staging'), extracted = join(root, 'extracted')
  mkdirSync(staging); mkdirSync(extracted)
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(manifest.files.includes('browser-extension')); assert.ok(manifest.files.includes('native-host'))
  for (const name of ['browser-extension', 'native-host']) cpSync(new URL(`../${name}`, import.meta.url), join(staging, name), { recursive: true })
  writeFileSync(join(staging, 'package.json'), JSON.stringify({ ...manifest, scripts: {} }))
  for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies })) {
    if (!version.startsWith('workspace:')) continue
    const directory = join(staging, 'node_modules', name)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version: '0.1.1-rc.5' }))
  }
  const run = (command, args, cwd = root) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' } })
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stdout + result.stderr)
    return result.stdout
  }
  run('pnpm', ['pack', '--pack-destination', root], staging)
  run('tar', ['-xzf', `dsh-builtin-browser-${manifest.version}.tgz`, '-C', extracted])
  const pkg = join(extracted, 'package'), directory = join(root, 'native'), extensionId = 'a'.repeat(32)
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
