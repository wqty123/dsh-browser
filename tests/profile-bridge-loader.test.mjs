import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createInstallerSandbox } from './helpers/installer-sandbox.mjs'

function setup(t) {
  const sandbox = createInstallerSandbox()
  t.after(() => sandbox.close())
  const root = sandbox.temp('profile-loader-'), home = join(root, 'home')
  const profile = join(home, 'profiles', 'desktop'), directory = join(root, 'installed-package')
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  mkdirSync(join(directory, 'desktop-bridge'), { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: 'module' }))
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-builtin-browser': 'file:installed-package' } }))
  const loader = join(root, 'host-loader.mjs')
  copyFileSync(new URL('../desktop-bridge/profile-loader.mjs', import.meta.url), loader)
  const target = join(directory, 'desktop-bridge', 'plugin-browser-bridge.js')
  const run = () => spawnSync(process.execPath, ['--input-type=module', '--eval', `
    try { const loader = await import(${JSON.stringify(pathToFileURL(loader).href)}); console.log(JSON.stringify(loader.start())) }
    catch (error) { console.error(error.name, error.code); process.exitCode = 1 }
  `], { env: { ...sandbox.env(), DSH_HOME: home }, encoding: 'utf8', timeout: 10_000 })
  return { root, profile, directory, target, run }
}

test('the unchanged host loader serves a profile package update on the next Desktop process', t => {
  const { profile, directory, target, run } = setup(t)
  symlinkSync(directory, join(profile, 'node_modules', 'dsh-builtin-browser'), 'dir')
  for (const protocol of [4, 5]) {
    writeFileSync(target, `export const start = () => ({ protocol: ${protocol} }); export const stop = () => {};`)
    const result = run()
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), { protocol })
  }
})

for (const state of ['missing package', 'missing entry', 'escaping entry']) test(`loader fails closed with a named error: ${state}`, t => {
  const { root, profile, directory, target, run } = setup(t)
  if (state !== 'missing package') symlinkSync(directory, join(profile, 'node_modules', 'dsh-builtin-browser'), 'dir')
  if (state === 'escaping entry') {
    const outside = join(root, 'outside.mjs')
    writeFileSync(outside, 'throw new Error("escaped bridge executed")')
    symlinkSync(outside, target)
  }
  const result = run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /DSH_BRIDGE_PACKAGE_UNAVAILABLE DSH_BRIDGE_PACKAGE_UNAVAILABLE/)
  assert.doesNotMatch(result.stderr, /escaped bridge executed/)
})
