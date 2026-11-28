// The capsule label is rendered from the marker attribute verbatim by the host.
//
// It used to be written with `encodeURIComponent`, which the host does not decode: a Chinese source
// title reached the browser as `%E5%BC%95%E7%94%A8…` and the capsule showed that. The label now
// travels readable, with only `%` escaped so the reader can still tell a literal percent from an
// encoded legacy label.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { composerQuote, readSourceMarker, sourceMarker } from '../src/client/reference/client/production/source-marker.ts'

const ID = '1143bb42-6075-4c00-be8e-f60673507290'

test('a marker carries a readable label, not percent-encoded bytes', () => {
  const marker = sourceMarker(ID, 0, '开放合作推动航天事业造福全人类 百度搜索')
  assert.ok(marker.includes('label="引用来源 1：开放合作推动航天事业造福全人类 百度搜索"'), marker)
  assert.doesNotMatch(marker, /%[0-9A-Fa-f]{2}/u)
  const read = readSourceMarker(marker, 0)
  assert.equal(read?.label, '引用来源 1：开放合作推动航天事业造福全人类 百度搜索')
  assert.equal(read?.referenceId, ID)
})

test('a title keeps its formatting characters out and its percent sign in', () => {
  const marker = sourceMarker(ID, 2, '100% 折扣 [促销] *限时*')
  const read = readSourceMarker(marker, 0)
  assert.ok(read !== undefined)
  assert.ok(read.label.includes('100% 折扣'), read.label)
  assert.ok(!read.label.includes('['), 'brackets are stripped so the markdown form cannot break')
})

test('labels written by earlier builds still decode', () => {
  const legacy = `<dsh-browser-reference uri="dsh-browser-ref:${ID}" label="${encodeURIComponent('引用来源 1：旧标题')}"/>`
  assert.equal(readSourceMarker(legacy, 0)?.label, '引用来源 1：旧标题')
})

test('a composer quote round-trips through its frame', () => {
  const text = composerQuote('第一行\n第二行', sourceMarker(ID, 0, '标题'))
  assert.match(text, /^<dsh-browser-quote>\n/u)
  assert.match(text, /<\/dsh-browser-quote>\n<dsh-browser-reference /u)
  assert.equal(readSourceMarker(text, 0)?.referenceId, ID)
})
