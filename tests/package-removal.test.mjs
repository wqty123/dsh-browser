import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { enableElectronPackageRemoval } from '../src/browser-electron/package-removal.ts'

test('the Electron-node host keeps noAsar for package-manager children after bundle disposal without changing parent fs', () => {
  const environment = { ELECTRON_RUN_AS_NODE: '1' }, before = process.noAsar
  enableElectronPackageRemoval(environment, '44.10.0')
  assert.equal(environment.ELECTRON_NO_ASAR, '1')
  assert.equal(process.noAsar, before)
  const child = { ...environment }
  assert.equal(child.ELECTRON_NO_ASAR, '1')
  for (const [env, electron] of [[{}, '44.10.0'], [{ ELECTRON_RUN_AS_NODE: '1' }, undefined]]) {
    const original = { ...env }
    enableElectronPackageRemoval(env, electron)
    assert.deepEqual(env, original)
  }
})

const electron = process.env.DSH_ELECTRON_BINARY
test('real Electron-node removes a nested default_app.asar as a plain file with ELECTRON_NO_ASAR', { skip: electron === undefined ? 'set DSH_ELECTRON_BINARY to run the real Electron-node filesystem regression' : false }, t => {
  const root = mkdtempSync(join(tmpdir(), 'electron-remove-asar-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const archive = join(root, 'node_modules/dsh-builtin-browser/node_modules/.pnpm/electron@44.10.0/node_modules/electron/dist/resources/default_app.asar')
  mkdirSync(dirname(archive), { recursive: true })
  copyFileSync(join(dirname(electron), 'resources/default_app.asar'), archive)
  const probe = `const fs=require('node:fs'); console.log(JSON.stringify({electron:process.versions.electron, raw:fs.statSync(${JSON.stringify(archive)}).isFile()})); fs.rmSync(${JSON.stringify(join(root, 'node_modules/dsh-builtin-browser'))},{recursive:true,force:true,maxRetries:3}); console.log('removed');`
  const environment = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  delete environment.ELECTRON_NO_ASAR
  const negative = spawnSync(electron, ['-e', probe], { env: environment, encoding: 'utf8', timeout: 3000 })
  console.log(`Electron-node ASAR negative control: status=${String(negative.status)} signal=${String(negative.signal)} error=${String(negative.error?.code)} output=${negative.stdout.trim()} stderr=${negative.stderr.trim()}`)
  mkdirSync(dirname(archive), { recursive: true })
  copyFileSync(join(dirname(electron), 'resources/default_app.asar'), archive)
  const output = execFileSync(electron, ['-e', probe], { env: { ...environment, ELECTRON_NO_ASAR: '1' }, encoding: 'utf8', timeout: 5000 })
  assert.match(output, /"raw":true/)
  assert.match(output, /removed/)
  assert.equal(existsSync(archive), false)
  console.log('Real Electron-node nested ASAR plain-file removal: PASS')
})
