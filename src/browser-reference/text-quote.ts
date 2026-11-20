/**
 * Text quote selectors: how a captured selection is found again after the page
 * has been reopened. Matching follows the W3C Text Quote Selector shape
 * (`exact` + `prefix` + `suffix`), with a whitespace-collapsed fallback for
 * pages whose rendered text differs only in spacing.
 *
 * Offsets are raw UTF-16 indices into the page text that was scanned, so a
 * caller can turn a match back into a DOM range without re-normalising.
 * @module dsh-browser/browser-reference/text-quote
 */
import type { TextQuoteAnchor } from './types.ts'

/** Half-open [start, end) range in the scanned text. */
export interface TextRange {
  readonly start: number
  readonly end: number
}

/** How a locate attempt ended. Ambiguity is a result, not an exception. */
export type LocateStatus = 'found' | 'ambiguous' | 'missing'

/** One locate attempt. `range` is present only when the status is `found`. */
export interface LocateResult {
  readonly status: LocateStatus
  readonly range?: TextRange
  readonly matches: readonly TextRange[]
  /** True when the literal text missed and the whitespace-collapsed form matched. */
  readonly collapsed: boolean
}

/** Context sizes, in UTF-16 code units, kept on each side of the selection. */
export interface AnchorContext {
  readonly before?: number
  readonly after?: number
}

const DEFAULT_CONTEXT = 32

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** Move an index off a surrogate boundary so slicing never splits a character. */
function safeBoundary(text: string, index: number, direction: 'before' | 'after'): number {
  if (index <= 0 || index >= text.length) return index
  const code = text.charCodeAt(index)
  const lowSurrogate = code >= 0xdc00 && code <= 0xdfff
  if (!lowSurrogate) return index
  return direction === 'before' ? index - 1 : Math.min(text.length, index + 1)
}

/**
 * Build the anchor for one selection.
 *
 * @param pageText - the text the selection was taken from.
 * @param start - selection start, UTF-16 index.
 * @param end - selection end, UTF-16 index.
 * @param context - how much surrounding text to keep (default 32 each side).
 * @returns the anchor, with context clipped at the text boundaries.
 * @throws TypeError when the range is not a non-empty subrange of `pageText`.
 */
export function buildTextAnchor(pageText: string, start: number, end: number, context: AnchorContext = {}): TextQuoteAnchor {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > pageText.length || start >= end) {
    throw new TypeError('a text anchor needs a non-empty integer range inside the page text')
  }
  const before = clamp(context.before ?? DEFAULT_CONTEXT, 0, 4096)
  const after = clamp(context.after ?? DEFAULT_CONTEXT, 0, 4096)
  const prefixStart = safeBoundary(pageText, Math.max(0, start - before), 'before')
  const suffixEnd = safeBoundary(pageText, Math.min(pageText.length, end + after), 'before')
  return {
    exact: pageText.slice(start, end),
    prefix: pageText.slice(prefixStart, start),
    suffix: pageText.slice(end, suffixEnd),
  }
}

interface Collapsed {
  readonly normalized: string
  /** Original start index of each normalized code unit. */
  readonly starts: readonly number[]
  /** Original end index (exclusive) of each normalized code unit. */
  readonly ends: readonly number[]
}

/**
 * Collapse whitespace runs into one space while remembering where each output
 * code unit came from. Surrogate pairs stay intact: iteration is by code point,
 * bookkeeping is by UTF-16 index.
 */
function collapse(text: string): Collapsed {
  let normalized = ''
  const starts: number[] = []
  const ends: number[] = []
  let index = 0
  let lastWasSpace = false
  for (const character of text) {
    const width = character.length
    if (/\s/u.test(character)) {
      if (!lastWasSpace) {
        normalized += ' '
        starts.push(index)
        ends.push(index + width)
        lastWasSpace = true
      }
    } else {
      normalized += character
      starts.push(index)
      ends.push(index + width)
      lastWasSpace = false
    }
    index += width
  }
  return { normalized, starts, ends }
}

function occurrences(haystack: string, needle: string): TextRange[] {
  const found: TextRange[] = []
  if (needle === '') return found
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    found.push({ start: at, end: at + needle.length })
    at = haystack.indexOf(needle, at + 1)
  }
  return found
}

function commonSuffixLength(left: string, right: string): number {
  let count = 0
  while (count < left.length && count < right.length && left.charCodeAt(left.length - 1 - count) === right.charCodeAt(right.length - 1 - count)) count += 1
  return count
}

function commonPrefixLength(left: string, right: string): number {
  let count = 0
  while (count < left.length && count < right.length && left.charCodeAt(count) === right.charCodeAt(count)) count += 1
  return count
}

interface Candidate {
  readonly range: TextRange
  readonly score: number
}

function bestOf(candidates: readonly Candidate[]): LocateResult['status'] {
  if (candidates.length === 0) return 'missing'
  let best = -1
  for (const candidate of candidates) best = Math.max(best, candidate.score)
  return candidates.filter(candidate => candidate.score === best).length > 1 ? 'ambiguous' : 'found'
}

/**
 * Find one anchor in a page's text.
 *
 * A literal hit is preferred; only when the literal text is absent does the
 * search retry with whitespace collapsed on both sides. Among hits, the one
 * whose surrounding text agrees most with `prefix`/`suffix` wins; a tie is
 * reported as `ambiguous` instead of guessing.
 *
 * @param pageText - the text to search, as captured from the page.
 * @param anchor - the stored selector.
 * @returns the locate result; never throws for malformed anchors.
 */
export function findTextQuote(pageText: string, anchor: TextQuoteAnchor): LocateResult {
  if (typeof pageText !== 'string' || anchor.exact === '') {
    return { status: 'missing', matches: [], collapsed: false }
  }

  const literal = occurrences(pageText, anchor.exact)
  if (literal.length > 0) {
    const candidates = literal.map(range => ({
      range,
      score: commonSuffixLength(pageText.slice(0, range.start), anchor.prefix)
        + commonPrefixLength(pageText.slice(range.end), anchor.suffix),
    }))
    const status = bestOf(candidates)
    const matches = dedupe(candidates.map(candidate => candidate.range))
    if (status === 'found') {
      const winner = candidates.find(candidate => candidate.score === Math.max(...candidates.map(c => c.score)))
      return { status, range: winner?.range, matches, collapsed: false }
    }
    return { status, matches, collapsed: false }
  }

  const page = collapse(pageText)
  const needle = collapse(anchor.exact)
  const trimmed = needle.normalized.trim()
  const collapsed = occurrences(page.normalized, trimmed)
  if (collapsed.length === 0) return { status: 'missing', matches: [], collapsed: true }

  const raw = collapsed.map(range => {
    const rawStart = page.starts[range.start]
    const rawEnd = page.ends[range.end - 1]
    return { start: rawStart, end: rawEnd }
  })
  const candidates = collapsed.map(range => ({
    range,
    score: commonSuffixLength(page.normalized.slice(0, range.start), collapse(anchor.prefix).normalized)
      + commonPrefixLength(page.normalized.slice(range.end), collapse(anchor.suffix).normalized),
  }))
  const status = bestOf(candidates)
  if (status === 'found') {
    const best = Math.max(...candidates.map(candidate => candidate.score))
    const winner = raw[candidates.findIndex(candidate => candidate.score === best)]
    return { status, range: winner, matches: dedupe(raw), collapsed: true }
  }
  return { status, matches: dedupe(raw), collapsed: true }
}

function dedupe(ranges: readonly TextRange[]): TextRange[] {
  const seen = new Set<string>()
  const out: TextRange[] = []
  for (const range of ranges) {
    const key = `${range.start}:${range.end}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(range)
  }
  return out
}
