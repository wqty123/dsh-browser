import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createInstallerSandbox } from './helpers/installer-sandbox.mjs'
import { runBridgeAction } from '../lib/browser-electron/bridge-install.js'

const installer = fileURLToPath(new URL('../desktop-bridge/install.mjs', import.meta.url))

for (const failures of [0, 2, 9]) test(`installer completion survives ${failures} rename locks or fails without a completion wait`, { timeout: 5000 }, async t => {
  const sandbox = createInstallerSandbox()
  t.after(() => sandbox.close())
  const root = sandbox.temp('desktop-')
  const app = join(root, 'resources', 'app')
  mkdirSync(join(app, 'lib'), { recursive: true })
  const main = join(app, 'lib', 'main.js')
  writeFileSync(main, 'const app = { whenReady: () => Promise.resolve() };\napp.whenReady().then(() => {});\nexport {};\n')
  writeFileSync(join(app, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-desktop', version: '0.2.1-rc.5', main: 'lib/main.js',
  }))
  const resultFile = join(root, 'result.json')
  const attemptsFile = join(sandbox.root, 'attempts.json')
  const preload = join(sandbox.root, 'completion-lock.mjs')
  writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const rename = fs.renameSync;
let attempts = 0;
fs.renameSync = (source, target) => {
  if (target === ${JSON.stringify(resultFile)}) {
    fs.writeFileSync(${JSON.stringify(attemptsFile)}, JSON.stringify(++attempts));
    if (attempts <= ${failures}) throw Object.assign(new Error('completion locked'), { code: 'EPERM' });
  }
  return rename(source, target);
};
syncBuiltinESMExports();
`)
  const child = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, installer, root], {
    env: sandbox.env({ DSH_BRIDGE_ACTION_RESULT_FILE: resultFile }), encoding: 'utf8', timeout: 20_000,
  })
  assert.equal(child.error, undefined)
  assert.match(readFileSync(main, 'utf8'), /dsh-builtin-browser: hand the plugin/, child.stdout + child.stderr)
  assert.equal(JSON.parse(readFileSync(attemptsFile, 'utf8')), Math.min(failures + 1, 9))
  if (failures < 9) {
    assert.equal(child.status, 0, child.stdout + child.stderr)
    assert.equal(JSON.parse(readFileSync(resultFile, 'utf8')).ok, true)
  } else {
    assert.equal(child.status, 1, child.stdout + child.stderr)
    assert.equal(existsSync(resultFile), false)
    assert.match(child.stderr, /could not record the bridge installer result: Error: completion locked/)
    let job
    t.after(() => {
      if (job) {
        const directory = dirname(job.DSH_BRIDGE_ACTION_RESULT_FILE)
        assert.match(basename(directory), /^dsh-bridge-action-/)
        rmSync(directory, { recursive: true, force: true })
      }
    })
    const outcome = await runBridgeAction('install', root, {
      installer: () => installer, node: () => process.execPath, trackResult: true,
      resultTimeoutMs: 180_000,
      run: async (_command, argv, environment) => {
        if (argv.includes('--preflight')) return { code: 0, output: '{"ok":true}' }
        job = environment
        return { code: child.status, output: child.stdout + child.stderr }
      },
    })
    assert.equal(outcome.code, 1)
    assert.equal(outcome.ok, false)
    assert.match(outcome.output, /completion locked/)
  }
})
