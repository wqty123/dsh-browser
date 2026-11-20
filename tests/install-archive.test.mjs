import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, basename, join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'

const source = fs.readFileSync(new URL('../desktop-bridge/install.mjs', import.meta.url), 'utf8')
const begin = source.indexOf('function readAsarHeader(file)')
const end = source.indexOf('\n/**\n * Make the Desktop CLI launcher', begin)

function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'dsh-archive-handles-'))
  const handles = new Set()
  const archiveFs = { ...fs,
    openSync(...args) { const fd = fs.openSync(...args); handles.add(fd); return fd },
    closeSync(fd) { fs.closeSync(fd); handles.delete(fd) },
  }
  const api = runInNewContext(source.slice(begin, end) + '; ({readAsarHeader,extractAsar})', {
    archiveFs, Buffer, join, dirname, mkdirSync: fs.mkdirSync, existsSync: fs.existsSync,
    copyFileSync: fs.copyFileSync, writeFileSync: fs.writeFileSync, statSync: fs.statSync,
  })
  return { root, handles, ...api, close() {
    for (const fd of handles) fs.closeSync(fd)
    assert.equal(dirname(resolve(root)).toLowerCase(), resolve(tmpdir()).toLowerCase())
    assert.ok(basename(root).startsWith('dsh-archive-handles-'))
    fs.rmSync(root, { recursive: true, force: true })
  } }
}

function archive(file, json = JSON.stringify({ files: { 'content.txt': { size: 4, offset: '0' } } })) {
  const text = Buffer.from(json), header = Buffer.alloc(Math.ceil((text.length + 8) / 4) * 4)
  header.writeUInt32LE(header.length - 4); header.writeUInt32LE(text.length, 4); text.copy(header, 8)
  const outer = Buffer.alloc(8); outer.writeUInt32LE(4); outer.writeUInt32LE(header.length, 4)
  fs.writeFileSync(file, Buffer.concat([outer, header, Buffer.from('data')]))
}

test('archive extraction releases its handle before the archive is moved', () => {
  const check = fixture()
  try {
    const file = join(check.root, 'app.asar'), output = join(check.root, 'app')
    archive(file)
    check.extractAsar(file, output)
    assert.equal(fs.readFileSync(join(output, 'content.txt'), 'utf8'), 'data')
    assert.equal(check.handles.size, 0)
    fs.renameSync(file, file + '.before-bridge')
  } finally { check.close() }
})

test('an invalid archive header releases its handle on rejection', () => {
  const check = fixture()
  try {
    const file = join(check.root, 'app.asar'); archive(file, '{invalid-json')
    assert.throws(() => check.readAsarHeader(file))
    assert.equal(check.handles.size, 0)
  } finally { check.close() }
})

test('an extraction write failure releases its handle', () => {
  const check = fixture()
  try {
    const file = join(check.root, 'app.asar'), output = join(check.root, 'blocked')
    archive(file); fs.writeFileSync(output, 'existing-file')
    assert.throws(() => check.extractAsar(file, output))
    assert.equal(check.handles.size, 0)
  } finally { check.close() }
})
