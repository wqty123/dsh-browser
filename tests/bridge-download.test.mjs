import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

const directory = mkdtempSync(join(tmpdir(), 'sidebar-download-'))
globalThis.__downloadElectron = { app: { whenReady: async () => {}, on() {} }, webContents: { getAllWebContents: () => [] } }
let source = readFileSync(new URL('../desktop-bridge/plugin-browser-bridge.js', import.meta.url), 'utf8')
source = source.replace(/import \{([^}]+)\} from ['"]electron['"]/, 'const {$1} = globalThis.__downloadElectron')
source = source.replace(/^start\(\)$/m, '').replace(/^main\(\)$/m, '')
source += '\nexport { downloadGuest };\n'
writeFileSync(join(directory, 'bridge.mjs'), source)
const { downloadGuest } = await import(pathToFileURL(join(directory, 'bridge.mjs')))
after(() => {
  delete globalThis.__downloadElectron
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
  rmSync(directory, { recursive: true, force: true })
})
const guest = response => ({ session: { fetch: async () => response() } })
const parts = () => readdirSync(directory).filter(name => name.endsWith('.part'))

test('download streams bytes through the guest session with cookies enabled', async () => {
  const calls = []
  const page = { session: { async fetch(url, options) { calls.push({ url, options }); return new Response('authenticated bytes') } } }
  const target = join(directory, 'valid.txt')
  await downloadGuest(page, 'https://example.com/file', target)
  assert.equal(readFileSync(target, 'utf8'), 'authenticated bytes')
  assert.equal(calls[0].options.credentials, 'include')
  assert.ok(calls[0].options.signal instanceof AbortSignal)
  assert.deepEqual(parts(), [])
})

test('an existing destination survives and temporary download files are cleaned', async () => {
  const target = join(directory, 'existing.txt')
  writeFileSync(target, 'original')
  await assert.rejects(downloadGuest(guest(() => new Response('replacement')), 'https://example.com/file', target), /EEXIST/)
  assert.equal(readFileSync(target, 'utf8'), 'original')
  assert.deepEqual(parts(), [])
})

test('interrupted responses leave no destination or partial file', async () => {
  const target = join(directory, 'broken.txt')
  const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('partial')) }, pull(c) { c.error(new Error('connection lost')) } })
  await assert.rejects(downloadGuest(guest(() => new Response(body)), 'https://example.com/file', target), /connection lost/)
  assert.equal(existsSync(target), false)
  assert.deepEqual(parts(), [])
})

test('HTTP failures and declared oversized downloads never create a destination', async () => {
  const target = join(directory, 'blocked.txt')
  await assert.rejects(downloadGuest(guest(() => new Response('', { status: 403 })), 'https://example.com/file', target), /403/)
  await assert.rejects(downloadGuest(guest(() => new Response('', { headers: { 'content-length': String(256 * 1024 * 1024 + 1) } })), 'https://example.com/file', target), /too large/)
  assert.equal(existsSync(target), false)
})

test('invalid URL schemes and relative paths are refused before network access', async () => {
  const noNetwork = { session: { fetch() { assert.fail('invalid download must not fetch') } } }
  await assert.rejects(downloadGuest(noNetwork, 'file:///private', join(directory, 'private')), /HTTP/)
  await assert.rejects(downloadGuest(noNetwork, 'https://example.com/file', 'relative.txt'), /absolute/)
})
