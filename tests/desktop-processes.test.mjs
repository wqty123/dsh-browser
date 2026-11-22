import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import { isDesktopExecutable } from '../desktop-bridge/desktop-processes.mjs'

test('bundle process matching respects real paths and bundle boundaries', { skip: process.platform === 'win32' }, t => {
  const base = mkdtempSync(join(tmpdir(), 'desktop-processes-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const root = join(base, 'Desktop.app'), exe = join(root, 'main'), helper = join(root, 'helper'), outside = join(base, 'other')
  mkdirSync(root)
  for (const path of [exe, helper, outside]) writeFileSync(path, '')
  symlinkSync(outside, join(root, 'escape'))
  symlinkSync(root, join(base, 'alias.app'))
  assert.equal(isDesktopExecutable(exe, exe), true)
  assert.equal(isDesktopExecutable(helper, exe), false)
  assert.equal(isDesktopExecutable(helper, exe, root), true)
  assert.equal(isDesktopExecutable(join(base, 'alias.app/helper'), exe, root), true)
  for (const path of ['', undefined, 'helper', outside, root, root + '-other/helper', join(root, 'escape')]) {
    assert.equal(isDesktopExecutable(path, exe, root), false)
  }
})

test('maintenance includes helpers only in exit barriers and forces C locale for ps', async () => {
  const source = readFileSync(new URL('../src/browser-electron/automatic-maintenance.ts', import.meta.url), 'utf8')
  const start = source.indexOf('async function posixDesktopProcesses('), end = source.indexOf('// The Desktop also ships', start)
  const root = resolve('Desktop.app'), exe = join(root, 'main'), helper = join(root, 'helper')
  let fail = false
  const calls = []
  const inspect = runInNewContext(stripTypeScriptTypes(source.slice(start, end)) + '; posixDesktopProcesses', {
    process: { env: { LC_ALL: 'fr_FR.UTF-8' } }, isDesktopExecutable, isAbsolute,
    desktopPaths: () => ({ executable: exe }), desktopLayout: () => ({ name: 'macos-bundle' }),
    NODE_MODE: /--expose-internals/,
    execute: async (command, args, timeout, env) => {
      calls.push({ command, timeout, env })
      return { code: fail ? 1 : 0, stdout: args.at(-1).includes('lstart')
        ? ` 10 Fri Nov 20 04:10:00 2026 ${helper}\n`
        : ` 10 ${helper}\n` }
    },
  })
  assert.equal((await inspect(root)).length, 0)
  assert.deepEqual(Array.from(await inspect(root, true), row => row.pid), [10])
  for (const call of calls) {
    assert.equal(call.command, 'ps')
    assert.equal(call.timeout, 15_000)
    assert.equal(call.env.LC_ALL, 'C')
    assert.equal(call.env.LANG, 'C')
  }
  fail = true
  await assert.rejects(inspect(root, true), /cannot inspect/)
})
