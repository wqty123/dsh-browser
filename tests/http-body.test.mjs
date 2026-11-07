import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { readJsonBody, readTextBody } from '../lib/browser-electron/http-body.js'

const streamOf = chunks => Readable.from(chunks.map(chunk => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))

test('a multi-byte UTF-8 character split across chunks survives decoding', async () => {
  const full = Buffer.from(JSON.stringify({ text: '中文✓' }), 'utf8')
  const value = await readJsonBody(streamOf([full.subarray(0, 12), full.subarray(12)]))
  assert.equal(value.text, '中文✓')
})

test('an empty body parses as an empty object', async () => {
  assert.deepEqual(await readJsonBody(streamOf([])), {})
})

test('an oversized body is rejected and the stream destroyed', async () => {
  const request = streamOf([Buffer.alloc(4097, 97)])
  await assert.rejects(() => readTextBody(request, 4096), /exceeds 4096 bytes/)
  assert.equal(request.destroyed, true)
})

test('the default cap still accepts a normal settings patch', async () => {
  const value = await readJsonBody(streamOf([JSON.stringify({ browser: { channel: 'auto' } })]))
  assert.equal(value.browser.channel, 'auto')
})
