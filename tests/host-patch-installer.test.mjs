import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
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
    if (id === 'main') writeFileSync(join(path, 'lib/preload-app.cjs'), artifact('preload', 'before'))
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

test('an older legacy injection migrates from its pristine backup, restores exact injected bytes and reapplies', t => {
  const { app, sidebar, run } = setup(t)
  const manifest = join(app, 'package.json')
  const originalManifest = readFileSync(manifest, 'utf8')
  writeFileSync(manifest, originalManifest.replace('0.2.2-rc.3', '0.2.2-rc.2'))
  assert.match(run(), /unsupported version/)
  const main = join(app, 'lib/main.js')
  const legacy = readFileSync(main, 'utf8').replace('bridge.start({ reload: why === "file changed" });', 'bridge.start();')
  writeFileSync(main, legacy)
  assert.match(legacy, /dsh-builtin-browser: hand the plugin/)
  assert.equal(readFileSync(main + '.before-bridge', 'utf8'), artifact('main', 'before'))
  const client = join(sidebar, 'lib/client.js')
  const prefix = artifact('client', 'before').match(/\.([A-Za-z0-9_-]+)_session\{display:contents\}/)[1]
  const substitute = text => text.replaceAll(prefix + '_', 'acoR2W_')
  writeFileSync(client, substitute(artifact('client', 'before')))
  writeFileSync(manifest, originalManifest)
  assert.match(run(), /DSH Desktop main extension/)
  assert.equal(readFileSync(main, 'utf8'), artifact('main', 'after'))
  assert.equal(readFileSync(main + '.before-dsh-host-patch', 'utf8'), legacy)
  assert.equal(readFileSync(client, 'utf8'), substitute(artifact('client', 'after')))
  assert.match(run(), /"changed":false/)
  assert.match(run('--revert'), /restored the pre-install legacy bridge/)
  assert.equal(readFileSync(main, 'utf8'), legacy)
  assert.equal(readFileSync(client, 'utf8'), substitute(artifact('client', 'before')))
  assert.equal(existsSync(join(app, 'lib/plugin-browser-bridge.js')), true)
  assert.match(run(), /DSH Desktop main extension/)
  assert.equal(readFileSync(main, 'utf8'), artifact('main', 'after'))
  assert.equal(readFileSync(client, 'utf8'), substitute(artifact('client', 'after')))
})

for (const backup of ['missing', 'wrong', 'extra edit']) test(`${backup} legacy pristine backup refuses migration without blocking the bridge`, t => {
  const { app, sidebar, run } = setup(t)
  const manifest = join(app, 'package.json')
  const originalManifest = readFileSync(manifest, 'utf8')
  writeFileSync(manifest, originalManifest.replace('0.2.2-rc.3', '0.2.2-rc.2'))
  run()
  writeFileSync(manifest, originalManifest)
  const main = join(app, 'lib/main.js')
  if (backup === 'extra edit') writeFileSync(main, readFileSync(main, 'utf8') + '\n// unrelated edit\n')
  const legacy = readFileSync(main, 'utf8')
  if (backup === 'missing') unlinkSync(main + '.before-bridge')
  else if (backup === 'wrong') writeFileSync(main + '.before-bridge', 'another build')
  const output = run()
  assert.match(output, /"status":"anchors mismatch"/)
  assert.match(output, /bridge already installed/)
  assert.equal(readFileSync(main, 'utf8'), legacy)
  assert.equal(readFileSync(join(sidebar, 'lib/client.js'), 'utf8'), artifact('client', 'before'))
  assert.equal(existsSync(main + '.before-dsh-host-patch'), false)
  assert.equal(existsSync(join(sidebar, 'lib/client.js.before-dsh-host-patch')), false)
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
