import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../scripts/install-electron.mjs', import.meta.url))

/** Run the shipped wrapper against an isolated dependency without downloading Electron. */
function fixture(t, installer) {
  const root = mkdtempSync(join(tmpdir(), 'dsh electron install '))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const plugin = join(root, 'plugin with spaces')
  const scripts = join(plugin, 'scripts')
  mkdirSync(scripts, { recursive: true })
  const wrapper = join(scripts, 'install-electron.mjs')
  copyFileSync(source, wrapper)
  const pkg = join(root, 'external runtime', 'node_modules', 'electron')
  if (installer !== undefined) {
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'electron', version: '44.10.0', main: 'index.js' }))
    // Resolving the metadata is safe; requiring electron itself must never happen.
    writeFileSync(join(pkg, 'index.js'), 'throw new Error("electron API entry must not be loaded")\n')
    if (installer !== null) writeFileSync(join(pkg, 'install.js'), installer)
  }
  const marker = join(root, 'installer result.json')
  const env = { ...process.env, NODE_PATH: '', ELECTRON_RUN_AS_NODE: '0' }
  env.DSH_BROWSER_ELECTRON_PACKAGE = pkg
  delete env.ELECTRON_SKIP_BINARY_DOWNLOAD
  const run = extraEnv => spawnSync(process.execPath, [wrapper], {
    cwd: root, env: { ...env, DSH_INSTALL_TEST_MARKER: marker, ...extraEnv },
    encoding: 'utf8', timeout: 10_000,
  })
  return { root, pkg, marker, run }
}

test('missing external Electron package fails with a local recovery command', t => {
  const { run } = fixture(t)
  const result = run()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /ENOENT|electron package/i)
  assert.match(result.stderr, /dsh-browser-install-electron/)
  assert.doesNotMatch(result.stderr, /electron API entry must not be loaded/)
})

test('an explicit invalid DSH_BROWSER_ELECTRON_PACKAGE is rejected before resolving anything', t => {
  const { run, marker } = fixture(t, "require('node:fs').writeFileSync(process.env.DSH_INSTALL_TEST_MARKER, 'ran')")
  for (const directory of ['', 'relative/node_modules/electron']) {
    const result = run({ DSH_BROWSER_ELECTRON_PACKAGE: directory })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /absolute external electron package/)
    assert.equal(existsSync(marker), false)
  }
})

test('when DSH_BROWSER_ELECTRON_PACKAGE is unset, an already-staged managed package is used directly', t => {
  const { root, run, marker } = fixture(t, "require('node:fs').writeFileSync(process.env.DSH_INSTALL_TEST_MARKER, 'managed-ran')")
  const home = join(root, 'dsh-home')
  const managedPkg = join(home, 'dsh-builtin-browser-host', 'electron-runtime', 'node_modules', 'electron')
  mkdirSync(managedPkg, { recursive: true })
  writeFileSync(join(managedPkg, 'package.json'), JSON.stringify({ name: 'electron', version: '44.10.0' }))
  writeFileSync(join(managedPkg, 'install.js'), "require('node:fs').writeFileSync(process.env.DSH_INSTALL_TEST_MARKER, 'managed-ran')")
  const env = { ...process.env, NODE_PATH: '', ELECTRON_RUN_AS_NODE: '0', DSH_HOME: home, DSH_INSTALL_TEST_MARKER: marker }
  delete env.DSH_BROWSER_ELECTRON_PACKAGE
  delete env.ELECTRON_SKIP_BINARY_DOWNLOAD
  const wrapper = join(root, 'plugin with spaces', 'scripts', 'install-electron.mjs')
  const result = spawnSync(process.execPath, [wrapper], { cwd: root, env, encoding: 'utf8', timeout: 10_000 })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(marker, 'utf8'), 'managed-ran')
})

test('a different external package is rejected before executing its installer', t => {
  const { run, pkg, marker } = fixture(t, "require('node:fs').writeFileSync(process.env.DSH_INSTALL_TEST_MARKER, 'ran')")
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'not-electron' }))
  const result = run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /must be named electron/)
  assert.equal(existsSync(marker), false)
})

test('skip download is honored before resolving an absent dependency', t => {
  const { run, marker } = fixture(t)
  const result = run({ ELECTRON_SKIP_BINARY_DOWNLOAD: '1' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /ELECTRON_SKIP_BINARY_DOWNLOAD/)
  assert.equal(existsSync(marker), false)
})

test('the installed dependency is invoked with inherited configuration and paths containing spaces', t => {
  const installer = `
    const fs = require('node:fs')
    fs.writeFileSync(process.env.DSH_INSTALL_TEST_MARKER, JSON.stringify({
      runAsNode: process.env.ELECTRON_RUN_AS_NODE,
      mirror: process.env.ELECTRON_MIRROR,
      proxy: process.env.HTTPS_PROXY,
      file: __filename,
      stdin: fs.readFileSync(0, 'utf8'),
    }))
    console.log('upstream installer progress')
  `
  const { run, pkg, marker } = fixture(t, installer)
  const result = run({ ELECTRON_MIRROR: 'https://example.invalid/mirror/', HTTPS_PROXY: 'http://example.invalid:8080' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /44\.10\.0/)
  assert.match(result.stdout, /upstream installer progress/)
  assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), {
    runAsNode: '1', mirror: 'https://example.invalid/mirror/', proxy: 'http://example.invalid:8080',
    file: join(pkg, 'install.js'), stdin: '',
  })
})

test('upstream failure keeps its stderr and exit status and explains how to retry', t => {
  const { run } = fixture(t, "console.error('upstream checksum failed'); process.exit(23)\n")
  const result = run()
  assert.equal(result.status, 23)
  assert.match(result.stderr, /upstream checksum failed/)
  assert.match(result.stderr, /dsh-browser-install-electron/)
  assert.doesNotMatch(result.stdout, /runtime is ready/i)
})

test('missing upstream installer is a visible failure rather than a successful install', t => {
  const { run } = fixture(t, null)
  const result = run()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /install\.js/)
  assert.match(result.stderr, /dsh-browser-install-electron/)
})

test('skip download does not execute a present installer', t => {
  const { run, marker } = fixture(t, "require('node:fs').writeFileSync(process.env.DSH_INSTALL_TEST_MARKER, 'ran')\n")
  const result = run({ ELECTRON_SKIP_BINARY_DOWNLOAD: '1' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(marker), false)
})

test('an already prepared runtime can use the upstream no-download path again', t => {
  const installer = `
    const fs = require('node:fs')
    const marker = process.env.DSH_INSTALL_TEST_MARKER
    if (fs.existsSync(marker)) {
      console.log('upstream runtime already installed')
      process.exit(0)
    }
    fs.writeFileSync(marker, 'prepared once')
  `
  const { run, marker } = fixture(t, installer)
  assert.equal(run().status, 0)
  const result = run()
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /upstream runtime already installed/)
  assert.equal(readFileSync(marker, 'utf8'), 'prepared once')
})
