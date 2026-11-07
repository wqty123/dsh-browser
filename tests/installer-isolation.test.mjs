import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInstallerSandbox, INSTALLER_TEST_MARKER } from './helpers/installer-sandbox.mjs'

const installer = fileURLToPath(new URL('../desktop-bridge/install.mjs', import.meta.url))
function makeInstall(sandbox) {
  const target = sandbox.temp('desktop-')
  mkdirSync(join(target, 'resources', 'app', 'lib'), { recursive: true })
  writeFileSync(join(target, 'resources', 'app', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-desktop', main: 'lib/main.js' }))
  writeFileSync(join(target, 'resources', 'app', 'lib', 'main.js'), 'const app = {};\nexport {};\n')
  return target
}
function contents(target) {
  const output = {}
  const walk = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name)
      if (entry.isDirectory()) walk(full)
      else output[full] = readFileSync(full, 'hex')
    }
  }
  walk(target)
  return output
}
function run(target, env, flags = []) {
  return spawnSync(process.execPath, [installer, target, ...flags], { env, encoding: 'utf8', windowsHide: true, timeout: 10_000 })
}
function refused(result) {
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /test isolation refused/)
}

test('installer tests require an explicit marked root even for preflight', () => {
  const sandbox = createInstallerSandbox()
  try {
    const target = makeInstall(sandbox), before = contents(target)
    const environment = sandbox.env(); delete environment.DSH_BRIDGE_TEST_ROOT
    refused(run(target, environment, ['--preflight']))
    assert.deepEqual(contents(target), before)
  } finally { sandbox.close() }
})

test('a valid Desktop outside the selected test root is refused before mutation', () => {
  const sandbox = createInstallerSandbox(), other = createInstallerSandbox()
  try {
    const target = makeInstall(other), before = contents(target)
    refused(run(target, sandbox.env()))
    assert.deepEqual(contents(target), before)
  } finally { sandbox.close(); other.close() }
})

test('the sandbox root itself is never an install target', () => {
  const sandbox = createInstallerSandbox()
  try {
    refused(run(sandbox.root, sandbox.env()))
    assert.ok(existsSync(join(sandbox.root, INSTALLER_TEST_MARKER)))
  } finally { sandbox.close() }
})

test('an invalid marker cannot authorize installer tests', () => {
  const sandbox = createInstallerSandbox(), unmarked = createInstallerSandbox()
  try {
    const target = makeInstall(unmarked), marker = join(unmarked.root, INSTALLER_TEST_MARKER)
    const valid = readFileSync(marker)
    try {
      writeFileSync(marker, 'not-an-installer-sandbox')
      refused(run(target, { ...sandbox.env(), DSH_BRIDGE_TEST_ROOT: unmarked.root }))
    } finally { writeFileSync(marker, valid) }
  } finally { sandbox.close(); unmarked.close() }
})

test('a linked install target cannot escape the marked test root', t => {
  const sandbox = createInstallerSandbox(), other = createInstallerSandbox()
  const alias = join(sandbox.root, 'linked-desktop')
  try {
    const target = makeInstall(other), before = contents(target)
    try { symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir') }
    catch (error) { t.skip(`this environment cannot create a directory link: ${error.code}`); return }
    refused(run(alias, sandbox.env()))
    assert.deepEqual(contents(target), before)
  } finally {
    if (existsSync(alias)) unlinkSync(alias)
    sandbox.close(); other.close()
  }
})

test('installer result and log paths cannot leave the test boundary', () => {
  const sandbox = createInstallerSandbox(), other = createInstallerSandbox()
  try {
    const target = makeInstall(sandbox), before = contents(target)
    for (const name of ['DSH_BRIDGE_ACTION_RESULT_FILE', 'DSH_BRIDGE_ACTION_LOG_FILE']) {
      const outside = join(other.root, name + '.json')
      refused(run(target, { ...sandbox.env(), [name]: outside }))
      assert.equal(existsSync(outside), false)
      assert.deepEqual(contents(target), before)
    }
  } finally { sandbox.close(); other.close() }
})

test('sandbox environments keep the user home and Desktop path out of child tests', () => {
  const sandbox = createInstallerSandbox()
  try {
    const environment = sandbox.env({ DSH_BROWSER_TEST: '0', DSH_BRIDGE_TEST_ROOT: 'C:/unexpected', DSH_HOME: 'C:/unexpected' })
    assert.equal(environment.DSH_BROWSER_TEST, '1')
    assert.equal(environment.DSH_BRIDGE_TEST_ROOT, sandbox.root)
    assert.equal(environment.DSH_HOME, join(sandbox.root, 'home'))
    assert.equal(environment.TEMP, sandbox.root)
    assert.equal(environment.TMP, sandbox.root)
    assert.equal(environment.TMPDIR, sandbox.root)
  } finally { sandbox.close() }
})
