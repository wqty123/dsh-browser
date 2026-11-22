import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { carrierHarness } from './carrier-harness.mjs'

test('loading the plugin in an Electron-node host leaves ELECTRON_NO_ASAR out of the host environment', t => {
  const saved = { run: process.env.ELECTRON_RUN_AS_NODE, noAsar: process.env.ELECTRON_NO_ASAR }
  const version = Object.getOwnPropertyDescriptor(process.versions, 'electron')
  t.after(() => {
    for (const [name, value] of [['ELECTRON_RUN_AS_NODE', saved.run], ['ELECTRON_NO_ASAR', saved.noAsar]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value
    }
    if (version === undefined) delete process.versions.electron; else Object.defineProperty(process.versions, 'electron', version)
  })
  process.env.ELECTRON_RUN_AS_NODE = '1'
  delete process.env.ELECTRON_NO_ASAR
  Object.defineProperty(process.versions, 'electron', { value: '44.10.0', configurable: true, enumerable: true })
  carrierHarness(t)
  // Every child the host starts afterwards inherits process.env; with ELECTRON_NO_ASAR an ASAR-packed
  // host's own helpers (DSH Tauri's Windows Job runner) cannot load their entry and exit 1 (issue #71).
  assert.equal(process.env.ELECTRON_NO_ASAR, undefined)
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
