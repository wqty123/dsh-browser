import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createInstallerSandbox } from './helpers/installer-sandbox.mjs'
import { readBridgeStatus } from '../src/browser-electron/bridge-status.ts'

const installer = fileURLToPath(new URL('../desktop-bridge/install.mjs', import.meta.url))
const artifact = (name, kind) => readFileSync(new URL(`./fixtures/dsh-host-patch/${name}.${kind}.js`, import.meta.url), 'utf8')
function setup(t) {
  const sandbox = createInstallerSandbox()
  t.after(() => sandbox.close())
  const root = sandbox.temp('desktop-host-patch-')
  const app = join(root, 'resources', 'app')
  const sidebar = join(app, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-client-ui-sidebar-right')
  for (const [path, name, id] of [[app, '@deepseek-ai/dsh-desktop', 'main'], [sidebar, '@deepseek-ai/dsh-client-ui-sidebar-right', 'client']]) {
    mkdirSync(join(path, 'lib'), { recursive: true })
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version: '0.2.2-rc.3', main: id === 'main' ? 'lib/main.js' : 'lib/index.js' }))
    writeFileSync(join(path, 'lib', id + '.js'), artifact(id, 'before'))
  }
  const run = (...flags) => {
    const result = spawnSync(process.execPath, [installer, root, ...flags], { env: sandbox.env(), encoding: 'utf8', timeout: 20_000 })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    return result.stdout
  }
  return { app, sidebar, root, run }
}

test('settings installer applies both host targets, uses the profile extension, and restores both', t => {
  const { app, sidebar, root, run } = setup(t)
  assert.match(run(), /DSH host patch: .*"status":"applied"/)
  assert.equal(readFileSync(join(app, 'lib/main.js'), 'utf8'), artifact('main', 'after'))
  assert.equal(readFileSync(join(sidebar, 'lib/client.js'), 'utf8'), artifact('client', 'after'))
  assert.equal(existsSync(join(app, 'lib/main.js.before-bridge')), false)
  assert.equal(readBridgeStatus(root).state, 'installed')
  assert.match(run(), /"changed":false/)
  assert.match(run('--revert'), /"status":"absent"/)
  assert.equal(readFileSync(join(app, 'lib/main.js'), 'utf8'), artifact('main', 'before'))
  assert.equal(readFileSync(join(sidebar, 'lib/client.js'), 'utf8'), artifact('client', 'before'))
  assert.equal(readBridgeStatus(root).state, 'missing')
})

test('an existing legacy injection migrates transactionally to the extension, preserving pristine bytes', t => {
  const { app, sidebar, run } = setup(t)
  const manifest = join(app, 'package.json')
  const originalManifest = readFileSync(manifest, 'utf8')
  writeFileSync(manifest, originalManifest.replace('0.2.2-rc.3', '0.2.2-rc.2'))
  assert.match(run(), /unsupported version/)
  assert.match(readFileSync(join(app, 'lib/main.js'), 'utf8'), /dsh-builtin-browser: hand the plugin/)
  writeFileSync(manifest, originalManifest)
  assert.match(run(), /DSH Desktop main extension/)
  assert.equal(readFileSync(join(app, 'lib/main.js'), 'utf8'), artifact('main', 'after'))
  run('--revert')
  assert.equal(readFileSync(join(app, 'lib/main.js'), 'utf8'), artifact('main', 'before'))
  assert.equal(readFileSync(join(sidebar, 'lib/client.js'), 'utf8'), artifact('client', 'before'))
})

test('mismatched sidebar anchors do not block legacy bridge installation or modify sidebar bytes', t => {
  const { app, sidebar, run } = setup(t)
  writeFileSync(join(sidebar, 'lib/client.js'), 'unknown sidebar build')
  assert.match(run(), /"status":"anchors mismatch"/)
  assert.equal(readFileSync(join(sidebar, 'lib/client.js'), 'utf8'), 'unknown sidebar build')
  assert.match(readFileSync(join(app, 'lib/main.js'), 'utf8'), /dsh-builtin-browser: hand the plugin/)
  assert.equal(existsSync(join(app, 'lib/main.js.before-dsh-host-patch')), false)
  run('--revert')
  assert.equal(readFileSync(join(app, 'lib/main.js'), 'utf8'), artifact('main', 'before'))
})
