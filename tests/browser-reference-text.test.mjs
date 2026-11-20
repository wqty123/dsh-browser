/**
 * Text quote selectors: anchor construction, literal matching, whitespace
 * fallback, and the ambiguity rule. The cases mirror the real page shapes the
 * design lists as acceptance (CJK, emoji, combining marks, cross-line text).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTextAnchor, findTextQuote } from '../lib/browser-reference/text-quote.js'

test('anchor keeps the selection and the requested context', () => {
  const page = 'alpha beta gamma delta'
  const anchor = buildTextAnchor(page, 6, 10, { before: 4, after: 6 })
  assert.equal(anchor.exact, 'beta')
  assert.equal(anchor.prefix, 'pha ')
  assert.equal(anchor.suffix, ' gamma')
})

test('anchor context is clipped at the text boundaries', () => {
  const page = 'abcdef'
  const anchor = buildTextAnchor(page, 0, 3, { before: 32, after: 32 })
  assert.equal(anchor.prefix, '')
  assert.equal(anchor.suffix, 'def')
})

test('anchor refuses an empty or out-of-range selection', () => {
  assert.throws(() => buildTextAnchor('abc', 1, 1), /non-empty integer range/)
  assert.throws(() => buildTextAnchor('abc', 0, 4), /non-empty integer range/)
  assert.throws(() => buildTextAnchor('abc', -1, 2), /non-empty integer range/)
})

test('anchor does not split a surrogate pair in its context', () => {
  const page = 'a😀b'
  const anchor = buildTextAnchor(page, 3, 4, { before: 1, after: 1 })
  assert.equal(anchor.exact, 'b')
  assert.equal(anchor.prefix, '😀')
})

test('a unique selection is found at its exact offsets', () => {
  const page = 'The quick brown fox jumps'
  const anchor = buildTextAnchor(page, 4, 9, { before: 4, after: 4 })
  const result = findTextQuote(page, anchor)
  assert.equal(result.status, 'found')
  assert.deepEqual(result.range, { start: 4, end: 9 })
  assert.equal(result.collapsed, false)
})

test('repeated text without context is ambiguous, not guessed', () => {
  const page = 'x foo y foo z'
  const anchor = { exact: 'foo', prefix: '', suffix: '' }
  const result = findTextQuote(page, anchor)
  assert.equal(result.status, 'ambiguous')
  assert.equal(result.range, undefined)
  assert.equal(result.matches.length, 2)
})

test('prefix and suffix disambiguate the repeated text', () => {
  const page = 'x foo y foo z'
  const anchor = { exact: 'foo', prefix: 'y ', suffix: ' z' }
  const result = findTextQuote(page, anchor)
  assert.equal(result.status, 'found')
  assert.deepEqual(result.range, { start: 8, end: 11 })
})

test('a selection spanning CJK text keeps UTF-16 offsets', () => {
  const page = '前言：这是需要引用的中文段落。后记'
  const start = page.indexOf('需要引用的中文段落')
  const anchor = buildTextAnchor(page, start, start + '需要引用的中文段落'.length)
  const result = findTextQuote(page, anchor)
  assert.equal(result.status, 'found')
  assert.equal(page.slice(result.range.start, result.range.end), '需要引用的中文段落')
})

test('emoji inside the selection does not shift the match', () => {
  const page = '开头😀中间🎯结尾'
  const start = page.indexOf('😀中间')
  const anchor = buildTextAnchor(page, start, start + '😀中间'.length)
  const result = findTextQuote(page, anchor)
  assert.equal(result.status, 'found')
  assert.equal(page.slice(result.range.start, result.range.end), '😀中间')
})

test('combining marks are matched as one sequence', () => {
  const page = 'cafe\u0301 au lait'
  const anchor = { exact: 'cafe\u0301', prefix: '', suffix: ' au' }
  const result = findTextQuote(page, anchor)
  assert.equal(result.status, 'found')
  assert.deepEqual(result.range, { start: 0, end: 5 })
})

test('a cross-line selection falls back to whitespace-collapsed matching', () => {
  const page = 'first line\n\n   second   line\tthird'
  const anchor = { exact: 'second line third', prefix: 'first line', suffix: '' }
  const result = findTextQuote(page, anchor)
  assert.equal(result.status, 'found')
  assert.equal(result.collapsed, true)
  assert.equal(page.slice(result.range.start, result.range.end).replace(/\s+/g, ' ').trim(), 'second line third')
})

test('a stale anchor is missing rather than match somewhere else', () => {
  const result = findTextQuote('the page has changed entirely', { exact: 'old quote', prefix: '', suffix: '' })
  assert.equal(result.status, 'missing')
  assert.deepEqual(result.matches, [])
})

test('an empty anchor is missing', () => {
  assert.equal(findTextQuote('anything', { exact: '', prefix: '', suffix: '' }).status, 'missing')
})
