import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { packInvocation } from './fixtures/packed-package.mjs'

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
