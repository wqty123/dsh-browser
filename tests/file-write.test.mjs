import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeFileNoReplace } from '../lib/browser-electron/file-write.js'

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'dsh-exclusive-write-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, file: join(root, 'result.bin') }
}

function patchBuiltin(t, name, replacement) {
  const patched = mock.method(fs, name, replacement)
  syncBuiltinESMExports()
  t.after(() => { patched.mock.restore(); syncBuiltinESMExports() })
}

test('a new file contains all bytes and leaves no temporary files', t => {
  const { root, file } = fixture(t)
  writeFileNoReplace(file, Buffer.from('complete bytes'))
  assert.equal(fs.readFileSync(file, 'utf8'), 'complete bytes')
  assert.deepEqual(fs.readdirSync(root), ['result.bin'])
})

for (const code of ['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'ENOSYS']) {
  test(`${code} hard-link failures use an exclusive copy fallback`, t => {
    const { root, file } = fixture(t)
    patchBuiltin(t, 'linkSync', () => { throw Object.assign(new Error('no hard links'), { code }) })
    const realCopy = fs.copyFileSync
    let calls = 0
    patchBuiltin(t, 'copyFileSync', (from, to, mode) => {
      calls++
      assert.equal(mode & fs.constants.COPYFILE_EXCL, fs.constants.COPYFILE_EXCL)
      return realCopy(from, to, mode)
    })
    writeFileNoReplace(file, Buffer.from('fallback bytes'))
    assert.equal(calls, 1)
    assert.equal(fs.readFileSync(file, 'utf8'), 'fallback bytes')
    assert.deepEqual(fs.readdirSync(root), ['result.bin'])
  })
}

test('an EEXIST commit failure never falls back or replaces the existing file', t => {
  const { root, file } = fixture(t)
  fs.writeFileSync(file, 'existing bytes')
  patchBuiltin(t, 'copyFileSync', () => { assert.fail('EEXIST must not use copy fallback') })
  assert.throws(() => writeFileNoReplace(file, Buffer.from('new bytes')), error => error.code === 'EEXIST')
  assert.equal(fs.readFileSync(file, 'utf8'), 'existing bytes')
  assert.deepEqual(fs.readdirSync(root), ['result.bin'])
})

test('fallback refuses a final file created after admission', t => {
  const { root, file } = fixture(t)
  patchBuiltin(t, 'linkSync', () => {
    fs.writeFileSync(file, 'racing writer')
    throw Object.assign(new Error('no hard links'), { code: 'ENOTSUP' })
  })
  assert.throws(() => writeFileNoReplace(file, Buffer.from('new bytes')), error => error.code === 'EEXIST')
  assert.equal(fs.readFileSync(file, 'utf8'), 'racing writer')
  assert.deepEqual(fs.readdirSync(root), ['result.bin'])
})

test('temporary cleanup failure cannot turn a successful commit into an error', t => {
  const { file } = fixture(t)
  patchBuiltin(t, 'unlinkSync', () => { throw Object.assign(new Error('temporary file locked'), { code: 'EPERM' }) })
  assert.doesNotThrow(() => writeFileNoReplace(file, Buffer.from('committed bytes')))
  assert.equal(fs.readFileSync(file, 'utf8'), 'committed bytes')
})

test('descriptor cleanup failure cannot turn a successful commit into an error', t => {
  const { file } = fixture(t)
  const realClose = fs.closeSync
  patchBuiltin(t, 'closeSync', descriptor => {
    realClose(descriptor)
    throw Object.assign(new Error('injected close failure'), { code: 'EIO' })
  })
  assert.doesNotThrow(() => writeFileNoReplace(file, Buffer.from('committed bytes')))
  assert.equal(fs.readFileSync(file, 'utf8'), 'committed bytes')
})

test('temporary cleanup failure preserves the original write/commit error', t => {
  const { file } = fixture(t)
  const primary = Object.assign(new Error('disk I/O failure'), { code: 'EIO' })
  patchBuiltin(t, 'linkSync', () => { throw primary })
  patchBuiltin(t, 'unlinkSync', () => { throw Object.assign(new Error('temporary file locked'), { code: 'EPERM' }) })
  assert.throws(() => writeFileNoReplace(file, Buffer.from('new bytes')), error => error === primary)
  assert.equal(fs.existsSync(file), false)
})

test('temporary cleanup failure preserves an error while writing the temporary file', t => {
  const { file } = fixture(t)
  const primary = Object.assign(new Error('disk write failure'), { code: 'EIO' })
  const realWrite = fs.writeFileSync
  patchBuiltin(t, 'writeFileSync', (target, ...rest) => {
    if (typeof target === 'number') throw primary
    return realWrite(target, ...rest)
  })
  patchBuiltin(t, 'unlinkSync', () => { throw Object.assign(new Error('temporary file locked'), { code: 'EPERM' }) })
  assert.throws(() => writeFileNoReplace(file, Buffer.from('new bytes')), error => error === primary)
  assert.equal(fs.existsSync(file), false)
})
