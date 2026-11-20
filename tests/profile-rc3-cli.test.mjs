import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync, readdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installedProfileExtension, repairProfileExtension } from '../src/browser-electron/profile-extension.ts'
import { runProfileCommand } from '../src/browser-electron/profile-command.ts'

const source = process.env.DSH_RC3_SOURCE

function assertNoNestedDependencies(profile) {
  const nested = join(profile, 'node_modules/dsh-builtin-browser/node_modules')
  // pnpm creates .bin shims for katex; no package or virtual store belongs here.
  assert.deepEqual(existsSync(nested) ? readdirSync(nested).filter(name => name !== '.bin') : [], [])
}

test('real rc.3 Desktop CLI removes and re-adds a file dependency offline without changing link/file siblings or an orphan', { skip: source === undefined ? 'set DSH_RC3_SOURCE to a dependency-prepared dsh-v0.2.2-rc.3 checkout' : false }, async t => {
  const owned = ['apps/desktop-host/src/cli.ts', 'apps/cli/src/bin.ts', 'apps/cli/src/args.ts', 'apps/cli/src/plugin.ts', 'packages/boot/plugin-manager/src/operations.ts']
  execFileSync('git', ['diff', '--exit-code', 'dsh-v0.2.2-rc.3', '--', ...owned], { cwd: source })
  const root = mkdtempSync(join(tmpdir(), 'real-rc3-profile-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'home'), profile = join(home, 'profiles/desktop'), app = join(root, 'desktop'), coverage = join(root, 'coverage')
  const pnpm = join(source, 'apps/desktop/node_modules/pnpm/bin/pnpm.mjs')
  const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
  const environment = { ...process.env, TSX_TSCONFIG_PATH: join(source, 'tsconfig.base.json'), DSH_HOME: home,
    PNPM_CONFIG_OFFLINE: 'true', PNPM_CONFIG_IGNORE_SCRIPTS: 'true', PNPM_CONFIG_AUTO_INSTALL_PEERS: 'false', NODE_V8_COVERAGE: coverage }
  mkdirSync(profile, { recursive: true })
  for (const name of ['dsh-builtin-browser', 'other-file', 'other-link']) {
    const directory = join(root, name, 'package')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version: '0.7.42', main: './index.js' }))
    writeFileSync(join(directory, 'index.js'), 'module.exports = { alive: true }')
    execFileSync('tar', ['-czf', join(root, name + '.tgz'), '-C', join(root, name), 'package'])
  }
  const archive = process.env.DSH_PLUGIN_ARCHIVE
  const dependency = 'file:' + (archive ?? join(root, 'dsh-builtin-browser.tgz'))
  const siblings = { 'other-file': 'file:' + join(root, 'other-file.tgz'), 'other-link': 'link:' + join(root, 'other-link/package') }
  if (archive !== undefined) {
    const manifest = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }))
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) assert.equal(manifest[section]?.electron, undefined)
    assert.equal(manifest.bundledDependencies, undefined)
    assert.equal(execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).split('\n').some(name => name.includes('/node_modules/')), false)
    for (const name of Object.keys(manifest.dependencies)) {
      siblings[name] = 'link:' + new URL('../node_modules/' + name, import.meta.url).pathname
    }
    const peers = { cordis: 'vendor/cordis', schemastery: 'vendor/schemastery', 'dsh-llm': 'packages/llm/llm', 'dsh-system-prompt': 'packages/core/system-prompt', 'dsh-tools': 'packages/core/tools' }
    for (const [name, path] of Object.entries(peers)) siblings['@deepseek-ai/' + name] = 'link:' + join(source, path)
  }
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'desktop', private: true, dependencies: { 'dsh-builtin-browser': dependency, ...siblings } }))
  writeFileSync(join(profile, '.npmrc'), `registry=${archive === undefined ? 'http://127.0.0.1:9' : 'https://registry.npmjs.org'}\nfetch-retries=0\nfetch-timeout=500\n`)
  const setup = spawnSync(process.execPath, [pnpm, 'install', '--offline', '--ignore-scripts'], { cwd: profile, env: environment, encoding: 'utf8', timeout: 20_000 })
  assert.equal(setup.status, 0, setup.stdout + setup.stderr)
  assertNoNestedDependencies(profile)
  if (process.env.DSH_ELECTRON_BINARY !== undefined) {
    const residue = join(profile, 'node_modules/dsh-builtin-browser/node_modules/.pnpm/electron@44.10.0/node_modules/electron/dist/resources/default_app.asar')
    mkdirSync(dirname(residue), { recursive: true })
    copyFileSync(join(dirname(process.env.DSH_ELECTRON_BINARY), 'resources/default_app.asar'), residue)
  }
  const orphan = join(profile, 'node_modules/orphan/package.json')
  mkdirSync(dirname(orphan), { recursive: true }); writeFileSync(orphan, '{"name":"orphan","version":"1.0.0"}\r\n')
  const before = readFileSync(orphan)
  const runtimePnpm = join(app, 'resources/runtime/primary-runtime/dependencies/pnpm')
  mkdirSync(dirname(runtimePnpm), { recursive: true })
  symlinkSync(dirname(dirname(pnpm)), runtimePnpm, process.platform === 'win32' ? 'junction' : 'dir')
  const cli = join(app, 'resources/app/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')
  mkdirSync(dirname(cli), { recursive: true })
  writeFileSync(join(app, 'resources/app/package.json'), '{"type":"module"}')
  writeFileSync(cli, `export { runDesktopCli } from ${JSON.stringify(pathToFileURL(join(source, 'apps/desktop-host/src/cli.ts')).href)}`)
  const run = async (_command, args, env) => await runProfileCommand(process.env.DSH_ELECTRON_BINARY ?? process.execPath, ['--import', loader, ...args], { ...env, ...environment }, 20_000)
  const removed = await repairProfileExtension('uninstall', app, home, run)
  assert.equal(removed.ok, true, removed.output)
  assert.deepEqual(JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')).dependencies, siblings)
  assert.equal(existsSync(join(profile, 'node_modules/dsh-builtin-browser')), false)
  assert.throws(() => createRequire(join(profile, 'package.json')).resolve('dsh-builtin-browser'))
  assert.deepEqual(readFileSync(orphan), before)
  const added = await repairProfileExtension('install', app, home, run, dependency)
  assert.equal(added.ok, true, added.output)
  assert.deepEqual(JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')).dependencies, { 'dsh-builtin-browser': dependency, ...siblings })
  const require = createRequire(join(profile, 'package.json'))
  for (const name of ['other-file', 'other-link']) assert.equal(require(name).alive, true)
  const resolved = execFileSync(process.execPath, ['-e', `console.log(require('node:module').createRequire(${JSON.stringify(join(profile, 'package.json'))}).resolve('dsh-builtin-browser'))`], { encoding: 'utf8', stdio: 'pipe' }).trim()
  assert.ok(existsSync(resolved))
  if (archive !== undefined) await installedProfileExtension(home)
  assertNoNestedDependencies(profile)
  assert.deepEqual(readFileSync(orphan), before)
  assert.equal(existsSync(join(profile, 'node_modules/.ignored')), false)
  const loaded = readdirSync(coverage).flatMap(name => JSON.parse(readFileSync(join(coverage, name), 'utf8')).result.map(entry => entry.url))
  for (const path of owned) assert.ok(loaded.includes(pathToFileURL(join(source, path)).href), `real rc.3 module did not execute: ${path}`)
  console.log('Real rc.3 CLI + bundled pnpm: offline remove/add, actual module execution, dependency disappearance/return and unrelated packages: PASS')
})
