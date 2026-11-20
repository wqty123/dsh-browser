import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, readlinkSync, rmSync, renameSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { withProfileCheckpoint as checkpoint } from '../src/browser-electron/profile-checkpoint.ts'
import { runProfileCommand } from '../src/browser-electron/profile-command.ts'
import { cleanProfileResidue, inspectProfileResidue } from '../src/browser-electron/profile-residue.ts'
import { runReinstallTransaction } from '../lib/browser-electron/automatic-maintenance.js'
import { runMaintenanceLifecycle } from '../src/browser-electron/maintenance-lifecycle.ts'
import { writeAsar } from './fake-asar.mjs'
import { copyFile, readdir, symlink } from 'node:fs/promises'

const withProfileCheckpoint = (home, job, operation, options = {}) => checkpoint(home, job, operation, { reconcile: async () => {}, ...options })
const offlineMetaError = String.raw`✗ Lockfile failed supply-chain policy check … [ERR_PNPM_NO_OFFLINE_META] Failed to resolve @browserbasehq/sdk in package mirror C:\Users\FB\AppData\Local\pnpm-cache\v12\metadata-full\…\@browserbasehq\sdk.jsonl`

function pruneOrphan(profile) {
  const destination = join(profile, 'node_modules/.ignored/@scope/orphan')
  mkdirSync(dirname(destination), { recursive: true })
  renameSync(join(profile, 'node_modules/@scope/orphan'), destination)
}

function tree(path) {
  if (lstatSync(path).isSymbolicLink()) return { link: readlinkSync(path) }
  if (!lstatSync(path).isDirectory()) return readFileSync(path).toString('base64')
  return Object.fromEntries(readdirSync(path).sort().map(name => [name, tree(join(path, name))]))
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'profile-checkpoint-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'home'), profile = join(home, 'profiles/desktop'), job = join(root, 'job')
  const plugin = join(profile, 'node_modules/dsh-builtin-browser')
  const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) }
  mkdirSync(job)
  put(join(profile, 'package.json'), '{\r\n "dependencies": {"dsh-builtin-browser":"file:../../archive.tgz"}\r\n}\r\n')
  put(join(profile, 'pnpm-lock.yaml'), '# untouched bytes\r\nlockfileVersion: \'9.0\'\r\n')
  put(join(plugin, 'package.json'), JSON.stringify({ name: 'dsh-builtin-browser', version: '0.7.42', main: 'index.js', dsh: { desktop: { main: './desktop-bridge/main.mjs' } } }))
  put(join(plugin, 'index.js'), 'module.exports = { alive: true }')
  put(join(plugin, 'desktop-bridge/plugin-browser-bridge.js'), 'original bridge')
  put(join(plugin, 'node_modules/nested/keep'), 'nested module')
  put(join(profile, 'node_modules/dsh-builtin-browser_tmp_52300_4/stale'), 'old pnpm temporary directory')
  put(join(profile, 'node_modules/@scope/orphan/package.json'), '{"name":"@scope/orphan","version":"1.0.0"}')
  put(join(root, 'linked/package.json'), '{"name":"linked","version":"1.0.0"}')
  symlinkSync(join(root, 'linked'), join(profile, 'node_modules/linked'), process.platform === 'win32' ? 'junction' : 'dir')
  return { root, home, profile, plugin, job }
}

for (const failed of ['remove', 'revert', 'apply', 'add']) test(`${failed} failure restores exact manifest, lockfile, partial package, orphan and stale pnpm directory before recovery`, async t => {
  const f = fixture(t), before = tree(f.profile), events = []
  let absent = false, hostAbsent = false
  const answer = (step, patch) => ({ ok: step !== failed, code: step === failed ? 1 : 0, output: step, ...(patch ? { hostPatch: { status: 'applied' } } : {}) })
  const result = await runMaintenanceLifecycle('reinstall', {
    requestQuit: async () => {}, waitUntilClosed: async () => {}, publish: async () => {},
    maintain: () => withProfileCheckpoint(f.home, f.job, () => runReinstallTransaction({
      absent: async () => absent,
      remove: async () => {
        for (const name of readdirSync(f.plugin)) if (name !== 'node_modules') rmSync(join(f.plugin, name), { recursive: true, force: true })
        writeFileSync(join(f.profile, 'package.json'), '{}')
        writeFileSync(join(f.profile, 'pnpm-lock.yaml'), 'changed')
        pruneOrphan(f.profile)
        absent = true
        return answer('remove')
      },
      hostAbsent: () => hostAbsent,
      revert: async () => { hostAbsent = true; return answer('revert') },
      apply: async () => { hostAbsent = false; return answer('apply', true) },
      add: async () => answer('add'),
    })),
    restart: async () => { assert.deepEqual(tree(f.profile), before); assert.equal(createRequire(join(f.profile, 'package.json'))('dsh-builtin-browser').alive, true); events.push('restored-before-restart'); return 42 },
    verify: async () => {},
  })
  assert.equal(result.phase, 'failed')
  assert.match(result.error, new RegExp(`REINSTALL_${failed.toUpperCase()}_FAILED`))
  assert.match(result.error, /REINSTALL_PROFILE_RESTORED/)
  assert.deepEqual(events, ['restored-before-restart'])
  assert.deepEqual(tree(f.profile), before)
})

test('success keeps the new plugin but rejects and rolls back any unrelated package movement', async t => {
  const f = fixture(t)
  assert.equal(await withProfileCheckpoint(f.home, f.job, async () => { writeFileSync(join(f.plugin, 'index.js'), 'module.exports = { alive: true, updated: true }'); return 'updated' }), 'updated')
  assert.match(readFileSync(join(f.plugin, 'index.js'), 'utf8'), /updated/)
  const job = join(f.root, 'second-job'); mkdirSync(job)
  const before = tree(f.profile)
  await assert.rejects(withProfileCheckpoint(f.home, job, async () => {
    pruneOrphan(f.profile)
  }), /REINSTALL_UNRELATED_PACKAGES_CHANGED.*REINSTALL_PROFILE_RESTORED/)
  assert.deepEqual(tree(f.profile), before)
})

test('an unavailable pre-job plugin is refused before any operation or checkpoint writes', async t => {
  const f = fixture(t)
  rmSync(join(f.plugin, 'package.json'))
  const before = tree(f.profile)
  await assert.rejects(withProfileCheckpoint(f.home, f.job, async () => assert.fail('must not mutate')), /ENOENT/)
  assert.deepEqual(tree(f.profile), before)
  assert.deepEqual(readdirSync(f.job), [])
})

test('offline metadata failure in remove restores the plugin and exact manifests without pnpm before restarting', async t => {
  const f = fixture(t), modules = join(f.profile, 'node_modules/.modules.yaml')
  writeFileSync(modules, 'original pnpm metadata\r\n')
  const before = tree(f.profile)
  let restarted = false
  const result = await runMaintenanceLifecycle('reinstall', {
    requestQuit: async () => {}, waitUntilClosed: async () => {}, publish: async () => {},
    maintain: () => withProfileCheckpoint(f.home, f.job, async () => {
      writeFileSync(join(f.profile, 'package.json'), '{}')
      writeFileSync(join(f.profile, 'pnpm-lock.yaml'), 'changed lockfile')
      writeFileSync(modules, 'changed metadata')
      rmSync(f.plugin, { recursive: true })
      mkdirSync(join(f.plugin, 'node_modules'), { recursive: true })
      throw new Error(`REINSTALL_REMOVE_FAILED: ${offlineMetaError}`)
    }, { reconcile: async () => assert.fail('direct restoration must not require pnpm') }),
    restart: async () => {
      assert.deepEqual(tree(f.profile), before)
      assert.equal(createRequire(join(f.profile, 'package.json'))('dsh-builtin-browser').alive, true)
      restarted = true
      return 42
    }, verify: async () => {},
  })
  assert.equal(result.restarted, true)
  assert.equal(restarted, true)
  assert.equal(result.phase, 'failed')
  assert.ok(result.error.includes(offlineMetaError))
  assert.match(result.error, /REINSTALL_PROFILE_RESTORED/)
})

test('offline metadata failure in reconcile still restores exact manifests and plugin and restarts, retaining the warning and checkpoint', async t => {
  const f = fixture(t)
  const modules = join(f.profile, 'node_modules/.modules.yaml')
  writeFileSync(modules, 'original pnpm metadata\r\n')
  const before = tree(f.profile)
  let restarted = false, reconciled = false
  const result = await runMaintenanceLifecycle('reinstall', {
    requestQuit: async () => {}, waitUntilClosed: async () => {}, publish: async () => {},
    maintain: () => withProfileCheckpoint(f.home, f.job, async () => {
      rmSync(join(f.profile, 'node_modules/@scope/orphan'), { recursive: true })
      rmSync(f.plugin, { recursive: true })
      throw new Error(`REINSTALL_REMOVE_FAILED: ${offlineMetaError}`)
    }, { reconcile: async () => {
      reconciled = true
      assert.equal(createRequire(join(f.profile, 'package.json'))('dsh-builtin-browser').alive, true)
      writeFileSync(join(f.profile, 'package.json'), '{}')
      writeFileSync(join(f.profile, 'pnpm-lock.yaml'), 'pnpm changed lockfile')
      writeFileSync(modules, 'pnpm changed metadata')
      rmSync(f.plugin, { recursive: true })
      throw new Error(`REINSTALL_RECONCILE_FAILED: Packages: -20\n${offlineMetaError}`)
    } }),
    restart: async () => {
      for (const path of ['package.json', 'pnpm-lock.yaml']) assert.deepEqual(tree(f.profile)[path], before[path])
      assert.deepEqual(tree(f.plugin), before.node_modules['dsh-builtin-browser'])
      assert.equal(readFileSync(modules, 'utf8'), 'original pnpm metadata\r\n')
      assert.ok(existsSync(createRequire(join(f.profile, 'package.json')).resolve('dsh-builtin-browser')))
      restarted = true
      return 42
    }, verify: async () => {},
  })
  assert.equal(result.restarted, true)
  assert.equal(restarted, true)
  assert.equal(reconciled, true)
  assert.equal(result.phase, 'failed')
  assert.match(result.error, /REINSTALL_RECONCILE_FAILED/)
  assert.ok(result.error.includes(offlineMetaError))
  assert.match(result.error, /REINSTALL_PROFILE_RESTORED/)
  assert.match(result.error, /REINSTALL_ROLLBACK_FAILED/)
  assert.equal(existsSync(join(f.job, 'profile-before/files/node_modules/dsh-builtin-browser/package.json')), true)
})

test('package runner preserves warnings without failing and reports spawn errors', async () => {
  assert.deepEqual(await runProfileCommand(process.execPath, ['-e', 'console.error("warning only")'], process.env), { code: 0, output: 'warning only' })
  assert.match((await runProfileCommand(join(tmpdir(), 'nonexistent-maintenance-command'), [], process.env)).output, /REINSTALL_COMMAND_START_FAILED/)
})

for (const linkedPlugin of [false, true]) test(`checkpoint creates no symlinks; Windows-style junction restore works with ${linkedPlugin ? 'linked' : 'copied'} plugin`, async t => {
  const f = fixture(t)
  if (linkedPlugin) {
    const checkout = join(f.root, 'checkout')
    renameSync(f.plugin, checkout)
    symlinkSync(checkout, f.plugin, process.platform === 'win32' ? 'junction' : 'dir')
    writeFileSync(join(f.profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-builtin-browser': 'link:' + checkout } }))
  }
  const before = tree(f.profile), calls = []
  const windowsSymlink = async (target, path, type) => {
    calls.push(type)
    if (type !== 'junction') throw Object.assign(new Error('symlinks require administrator privileges'), { code: 'EPERM' })
    return symlink(target, path, type)
  }
  await assert.rejects(withProfileCheckpoint(f.home, f.job, async () => {
    assert.deepEqual(calls, [])
    const checkpoint = join(f.job, 'profile-before')
    const walk = path => {
      assert.equal(lstatSync(path).isSymbolicLink(), false)
      if (lstatSync(path).isDirectory()) for (const name of readdirSync(path)) walk(join(path, name))
    }
    walk(checkpoint)
    const metadata = JSON.parse(readFileSync(join(checkpoint, 'metadata.json'), 'utf8'))
    assert.ok(metadata.modules.some(entry => entry.kind === 'link' && entry.path.endsWith('linked') && entry.type === 'directory'))
    const foreign = join('node_modules', '@scope', 'orphan', 'package.json')
    assert.equal(existsSync(join(checkpoint, 'files', foreign)), false)
    if (!linkedPlugin) assert.notEqual(lstatSync(join(checkpoint, 'files/node_modules/dsh-builtin-browser/package.json')).ino, lstatSync(join(f.plugin, 'package.json')).ino)
    rmSync(f.plugin, { recursive: true, force: true })
    rmSync(join(f.profile, 'node_modules/linked'))
    pruneOrphan(f.profile)
    writeFileSync(join(f.profile, 'package.json'), '{}')
    throw new Error('forced remove failure')
  }, { symlink: windowsSymlink }), /REINSTALL_PROFILE_RESTORED/)
  assert.ok(calls.length >= 1)
  assert.ok(calls.every(type => type === 'junction'))
  assert.deepEqual(tree(f.profile), before)
})

test('partial checkpoint failure removes its checkpoint without changing the profile or running maintenance', async t => {
  const f = fixture(t), before = tree(f.profile)
  let copies = 0
  await assert.rejects(withProfileCheckpoint(f.home, f.job, async () => assert.fail('must not mutate'), {
    copyFile: async (...args) => {
      if (++copies === 2) throw Object.assign(new Error('checkpoint write denied'), { code: 'EPERM' })
      return copyFile(...args)
    },
    symlink: async () => assert.fail('checkpoint must not create a symlink'),
  }), /REINSTALL_CHECKPOINT_FAILED.*profile unchanged.*checkpoint write denied/)
  assert.equal(copies, 2)
  assert.deepEqual(tree(f.profile), before)
  assert.deepEqual(readdirSync(f.job), [])
})

test('file symlink restore denial reports incomplete recovery, retaining the checkpoint and restarting Desktop', async t => {
  const f = fixture(t), target = join(f.root, 'file.txt')
  writeFileSync(target, 'outside file stays intact')
  try { symlinkSync(target, join(f.plugin, 'file-link'), 'file') } catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error
    t.skip('creating the file-link fixture requires Windows symlink privileges')
    return
  }
  const result = await runMaintenanceLifecycle('reinstall', {
    requestQuit: async () => {}, waitUntilClosed: async () => {}, publish: async () => {},
    maintain: () => withProfileCheckpoint(f.home, f.job, async () => { rmSync(join(f.plugin, 'file-link')); throw new Error('forced remove failure') }, {
      symlink: async (target, path, type) => {
        if (type !== 'junction') throw Object.assign(new Error('file symlink denied'), { code: 'EPERM' })
        return symlink(target, path, type)
      },
    }),
    restart: async () => 42, verify: async () => {},
  })
  assert.equal(result.restarted, true)
  assert.match(result.error, /REINSTALL_ROLLBACK_FAILED.*REINSTALL_LINK_RESTORE_FAILED: file link.*file symlink denied/)
  assert.ok(existsSync(join(f.job, 'profile-before/metadata.json')))
  assert.equal(readFileSync(target, 'utf8'), 'outside file stays intact')
})

test('preflight detects copied development residue without writes, cleanup precedes remove, and failure restores even the nested ASAR', async t => {
  const f = fixture(t), nested = join(f.plugin, 'node_modules')
  const names = ['typescript', 'electron', '@types/node', '@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/cordis', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery']
  for (const name of names) {
    const link = join(nested, ...name.split('/'))
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(join(f.root, 'missing', name), link, process.platform === 'win32' ? 'junction' : 'dir')
  }
  const archive = join(nested, '.pnpm/electron@44.10.0/node_modules/electron/dist/resources/default_app.asar')
  writeAsar(archive, { 'index.js': 'copied development runtime' })
  const before = tree(f.profile)
  const residue = await inspectProfileResidue(f.home)
  assert.ok(residue.includes('electron')); assert.ok(residue.includes('.pnpm')); assert.ok(residue.includes('typescript'))
  assert.deepEqual(tree(f.profile), before)
  await assert.rejects(withProfileCheckpoint(f.home, f.job, async () => {
    assert.match(await cleanProfileResidue(f.home), /pre-existing undeclared nested dependency residue/)
    assert.equal(existsSync(nested), false)
    assert.ok(existsSync(join(f.plugin, 'index.js')))
    throw new Error('REINSTALL_REMOVE_FAILED: simulated pnpm failure after residue cleanup')
  }), /REINSTALL_PROFILE_RESTORED/)
  assert.deepEqual(tree(f.profile), before)
  assert.equal(existsSync(join(f.root, 'missing')), false)
})

test('declared nested runtime dependencies and external linked development checkouts are not cleaned', async t => {
  const f = fixture(t)
  const manifest = join(f.plugin, 'package.json'), pkg = JSON.parse(readFileSync(manifest, 'utf8'))
  pkg.dependencies = { nested: '*' }; writeFileSync(manifest, JSON.stringify(pkg))
  assert.deepEqual(await inspectProfileResidue(f.home), [])
  assert.equal(await cleanProfileResidue(f.home), '')
  const external = join(f.root, 'checkout')
  renameSync(f.plugin, external)
  symlinkSync(external, f.plugin, process.platform === 'win32' ? 'junction' : 'dir')
  mkdirSync(join(external, 'node_modules/electron'))
  assert.deepEqual(await inspectProfileResidue(f.home), [])
  assert.equal(await cleanProfileResidue(f.home), '')
  assert.equal(existsSync(join(external, 'node_modules/electron')), true)
})

for (const path of ['.pnpm/foreign@1.0.0/node_modules/foreign/index.js', '.bin/foreign']) test(`rollback reconciles ${path} instead of snapshotting unrelated content`, async t => {
  const f = fixture(t), foreign = join(f.profile, 'node_modules', path)
  mkdirSync(dirname(foreign), { recursive: true }); writeFileSync(foreign, 'keep this unrelated package')
  const before = tree(f.profile)
  let reconciled = false
  await assert.rejects(withProfileCheckpoint(f.home, f.job, async () => { rmSync(join(f.profile, 'node_modules', path.split('/')[0]), { recursive: true }); throw new Error('remove failed') }, {
    reconcile: async () => { reconciled = true; mkdirSync(dirname(foreign), { recursive: true }); writeFileSync(foreign, 'keep this unrelated package') },
  }), /REINSTALL_PROFILE_RESTORED/)
  assert.equal(reconciled, true)
  assert.deepEqual(tree(f.profile), before)
})

for (const code of ['EXDEV', 'UNKNOWN']) test(`checkpoint never hardlinks or traverses unrelated cross-volume junctions (${code})`, async t => {
  const f = fixture(t), external = join(f.root, 'other-volume'), dependency = join(f.profile, 'node_modules/@deepseek-ai/dsh-llm')
  mkdirSync(join(external, 'node_modules/zod'), { recursive: true })
  writeFileSync(join(external, 'node_modules/zod/compile.d.cts'), 'external types')
  mkdirSync(dirname(dependency), { recursive: true })
  symlinkSync(external, dependency, 'junction')
  const before = tree(f.profile)
  await assert.rejects(withProfileCheckpoint(f.home, f.job, async () => {
    const saved = join(f.job, 'profile-before/files')
    assert.deepEqual(readdirSync(saved).sort(), ['node_modules', 'package.json', 'pnpm-lock.yaml'])
    assert.deepEqual(readdirSync(join(saved, 'node_modules')), ['dsh-builtin-browser'])
    rmSync(f.plugin, { recursive: true })
    rmSync(dependency)
    throw new Error('forced remove failure')
  }, {
    link: async () => { throw Object.assign(new Error('cross-volume hardlink'), { code }) },
    readdir: async (path, ...args) => {
      if (String(path).startsWith(dependency) || String(path).startsWith(external)) throw Object.assign(new Error('cross-volume traversal'), { code })
      return readdir(path, ...args)
    },
    copyFile: async (source, destination) => {
      if (String(source).startsWith(dependency) || String(source).startsWith(external)) throw Object.assign(new Error('cross-volume file copy'), { code })
      return copyFile(source, destination)
    },
    symlink: async (target, path, type) => {
      assert.equal(type, 'junction')
      return symlink(target, path, type)
    },
  }), /REINSTALL_PROFILE_RESTORED/)
  assert.deepEqual(tree(f.profile), before)
  assert.equal(readFileSync(join(external, 'node_modules/zod/compile.d.cts'), 'utf8'), 'external types')
})

test('direct restoration recovers orphans from .ignored and exact profile files without reconciliation', async t => {
  const f = fixture(t), modules = join(f.profile, 'node_modules/.modules.yaml')
  writeFileSync(modules, 'original metadata\r\n')
  const before = tree(f.profile)
  await assert.rejects(withProfileCheckpoint(f.home, f.job, async () => {
    writeFileSync(join(f.profile, 'package.json'), '{}')
    writeFileSync(modules, 'changed')
    pruneOrphan(f.profile)
    throw new Error('remove failed')
  }, { reconcile: async () => assert.fail('orphan recovery must not require pnpm') }), /REINSTALL_PROFILE_RESTORED/)
  assert.deepEqual(tree(f.profile), before)
})

test('package runner kills descendants on timeout before allowing rollback', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t), marker = join(f.root, 'escaped-child')
  const script = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'escaped'), 2000)`)}], {stdio:'ignore'}); console.log('child launched'); setTimeout(() => {}, 5000)`
  const result = await runProfileCommand(process.execPath, ['-e', script], process.env, 1000)
  assert.equal(result.code, 1)
  assert.match(result.output, /REINSTALL_COMMAND_TIMEOUT/)
  assert.match(result.output, /child launched/)
  await new Promise(resolve => setTimeout(resolve, 1200))
  assert.equal(existsSync(marker), false)
})
