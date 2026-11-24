import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { extractPackedPackage, packInvocation, stagePackage } from './fixtures/packed-package.mjs'

test('pack lifecycle writes are isolated from the checkout and other pack runs', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pack-isolation-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'checkout')
  for (const directory of ['node_modules', '.git', 'lib', 'dist', 'src', 'scripts', 'assets']) mkdirSync(join(source, directory), { recursive: true })
  const manifest = JSON.stringify({ name: 'fixture', publishConfig: { exports: { '.': './lib/index.js', './client': './dist/client.cjs' } } })
  writeFileSync(join(source, 'package.json'), manifest)
  for (const directory of ['node_modules', '.git', 'lib', 'dist', 'src', 'scripts', 'assets']) writeFileSync(join(source, directory, 'sentinel'), directory)
  mkdirSync(join(source, 'node_modules', 'tool'))
  const first = stagePackage(source, join(root, 'first'))
  const second = stagePackage(source, join(root, 'second'))
  assert.equal(realpathSync(join(first, 'node_modules', 'tool')), realpathSync(join(source, 'node_modules', 'tool')))
  for (const directory of ['.git', 'lib', 'dist']) assert.equal(existsSync(join(first, directory)), false)
  for (const directory of ['src', 'scripts', 'assets']) {
    assert.equal(readFileSync(join(first, directory, 'sentinel'), 'utf8'), directory)
    writeFileSync(join(first, directory, 'sentinel'), 'changed')
    assert.equal(readFileSync(join(source, directory, 'sentinel'), 'utf8'), directory)
    assert.equal(readFileSync(join(second, directory, 'sentinel'), 'utf8'), directory)
  }
  writeFileSync(join(first, 'package.json'), '{"publishConfig":{"exports":{"./client":{"import":"./dist/client.mjs"}}}}')
  mkdirSync(join(first, 'dist'))
  writeFileSync(join(first, 'dist', 'client.mjs'), 'intermediate build output')
  assert.equal(readFileSync(join(source, 'package.json'), 'utf8'), manifest)
  assert.equal(readFileSync(join(second, 'package.json'), 'utf8'), manifest)
  assert.equal(readFileSync(join(source, 'dist', 'sentinel'), 'utf8'), 'dist')
  assert.equal(existsSync(join(second, 'dist')), false)
})

test('pack staging resolves pnpm relative package links on every OS', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pack-links-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'workspace', 'packages', 'web', 'plugin')
  const store = join(root, 'workspace', 'node_modules', '.pnpm')
  const install = (name, file) => {
    const real = join(store, `${name.replace('/', '+')}@1.0.0`, 'node_modules', name)
    mkdirSync(join(real, 'bin'), { recursive: true })
    writeFileSync(join(real, 'bin', file), name)
    const link = join(source, 'node_modules', name)
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(relative(dirname(link), real), link, 'dir')
  }
  mkdirSync(join(source, 'src'), { recursive: true })
  writeFileSync(join(source, 'package.json'), '{"name":"plugin"}')
  try { install('typescript', 'tsc') } catch (error) {
    if (error.code === 'EPERM') return t.skip('relative symlinks need symlink privilege here')
    throw error
  }
  install('@scope/tool', 'run')
  writeFileSync(join(source, 'node_modules', '.modules.yaml'), '')
  const staging = stagePackage(source, join(root, 'staging'))
  assert.equal(readFileSync(join(staging, 'node_modules', 'typescript', 'bin', 'tsc'), 'utf8'), 'typescript')
  assert.equal(readFileSync(join(staging, 'node_modules', '@scope', 'tool', 'bin', 'run'), 'utf8'), '@scope/tool')
})

test('pack staging refuses a missing source instead of building against the checkout', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pack-missing-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.throws(() => stagePackage(join(root, 'missing'), join(root, 'staging')), { code: 'ENOENT' })
  assert.equal(existsSync(join(root, 'staging')), false)
})

function cliFixture(t, name = 'pnpm', version = '11.7.0') {
  const root = mkdtempSync(join(tmpdir(), 'dsh pnpm entry '))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name, version }))
  for (const extension of ['js', 'cjs']) writeFileSync(join(root, 'bin', `pnpm.${extension}`), '')
  return root
}

test('pack uses Node and a matching pnpm JS entry without a shell on either OS', t => {
  const root = cliFixture(t)
  for (const platform of ['linux', 'darwin', 'win32']) {
    for (const extension of ['js', 'cjs']) {
      const entry = join(root, 'bin', `pnpm.${extension}`)
      assert.deepEqual(packInvocation('pnpm@11.7.0', 'output with spaces', { platform, npmExecpath: entry }), {
        command: process.execPath,
        args: [entry, 'pack', '--pm-on-fail=ignore', '--pack-destination', 'output with spaces'],
        shell: false,
      })
    }
  }
})

test('empty, missing, shim, wrong-manager and wrong-version entries fall back to pinned Corepack', t => {
  const root = cliFixture(t, 'pnpm', '12.18.0')
  const other = cliFixture(t, 'npm')
  for (const npmExecpath of ['', join(root, 'missing.js'), join(root, 'pnpm.cmd'), join(root, 'bin', 'pnpm.cjs'), join(other, 'bin', 'pnpm.js')]) {
    assert.deepEqual(packInvocation('pnpm@11.7.0', 'unused', { platform: 'win32', npmExecpath }), {
      command: 'corepack pnpm@11.7.0 pack --pm-on-fail=ignore --pack-destination "%DSH_TEST_PACK_DEST%"',
      args: [], shell: true,
    })
    for (const platform of ['linux', 'darwin']) {
      assert.deepEqual(packInvocation('pnpm@11.7.0', 'output with spaces', { platform, npmExecpath }), {
        command: 'corepack',
        args: ['pnpm@11.7.0', 'pack', '--pm-on-fail=ignore', '--pack-destination', 'output with spaces'],
        shell: false,
      })
    }
  }
})

test('pack rejects missing, unpinned or shell-injected package manager specifications', () => {
  for (const value of [undefined, '', 'pnpm', 'pnpm@latest', 'npm@11.7.0', 'pnpm@11.7.0 & echo unsafe']) {
    assert.throws(() => packInvocation(value, 'output'), /packageManager must pin a pnpm version/)
  }
})

test('shared extraction uses archive-directory cwd and relative tar paths, including Windows drives', () => {
  for (const directory of ['/tmp/archive with spaces', String.raw`C:\Users\test user\archive`, String.raw`D:\archive`]) {
    const calls = []
    extractPackedPackage((...args) => calls.push(args), directory, 'dsh-builtin-browser-0.7.42.tgz')
    assert.deepEqual(calls, [['tar', ['-xzf', 'dsh-builtin-browser-0.7.42.tgz', '-C', 'extracted'], directory]])
  }
})

test('shared extraction rejects empty or non-filename archive arguments before invoking tar', () => {
  for (const archive of [undefined, '', '/tmp/archive.tgz', String.raw`C:\temp\archive.tgz`, 'C:archive.tgz', 'sub/archive.tgz', String.raw`sub\archive.tgz`]) {
    assert.throws(() => extractPackedPackage(() => assert.fail('tar must not run'), 'directory', archive), /archive must be a relative filename/)
  }
})
