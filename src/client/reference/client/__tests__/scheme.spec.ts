import { describe, expect, it } from 'vitest'
import {
  BROWSER_REF_SCHEME,
  MAX_BROWSER_REF_ID_LENGTH,
  MAX_BROWSER_REF_URI_LENGTH,
  BrowserRefUriError,
  encodeBrowserRefUri,
  decodeBrowserRefUri,
  parseBrowserRefUri,
  isBrowserRefUri,
} from '../scheme.ts'

describe('encodeBrowserRefUri', () => {
  it('encodes ids as URI components and round-trips losslessly', () => {
    const uri = encodeBrowserRefUri({ referenceId: 'ref/a #1', partId: 'part 2?x=1' })
    expect(uri.startsWith(BROWSER_REF_SCHEME)).toBe(true)
    expect(uri).not.toContain('ref/a')
    expect(decodeBrowserRefUri(uri)).toEqual({ referenceId: 'ref/a #1', partId: 'part 2?x=1' })
  })

  it('omits the part segment when partId is absent', () => {
    const uri = encodeBrowserRefUri({ referenceId: 'abc' })
    expect(uri).toBe(`${BROWSER_REF_SCHEME}abc`)
    expect(decodeBrowserRefUri(uri)).toEqual({ referenceId: 'abc' })
  })

  it('rejects empty, over-long and control-bearing ids', () => {
    expect(() => encodeBrowserRefUri({ referenceId: '' })).toThrow(BrowserRefUriError)
    expect(() => encodeBrowserRefUri({ referenceId: 'x'.repeat(MAX_BROWSER_REF_ID_LENGTH + 1) })).toThrow(BrowserRefUriError)
    expect(() => encodeBrowserRefUri({ referenceId: 'a\n' })).toThrow(BrowserRefUriError)
    expect(() => encodeBrowserRefUri({ referenceId: 'ok', partId: '' })).toThrow(BrowserRefUriError)
  })

  it('rejects an encoded URI beyond the total length limit', () => {
    // Each CJK char expands to a 9-char %XX escape: 128 of them exceed 512.
    const long = '汉'.repeat(MAX_BROWSER_REF_ID_LENGTH)
    expect(() => encodeBrowserRefUri({ referenceId: long })).toThrow(/too long/)
  })
})

describe('decodeBrowserRefUri', () => {
  it('rejects invalid and non-canonical inputs', () => {
    const invalid: unknown[] = [
      undefined, null, 42, {}, '',
      'https://example.com',
      'dsh-session:abc',
      BROWSER_REF_SCHEME,
      `${BROWSER_REF_SCHEME}a/b/c`,
      `${BROWSER_REF_SCHEME}a b`,
      `${BROWSER_REF_SCHEME}%E0%A4%A`,
      `${BROWSER_REF_SCHEME}a/`,
      'd'.repeat(MAX_BROWSER_REF_URI_LENGTH + 1),
    ]
    for (const value of invalid) {
      expect(() => decodeBrowserRefUri(value)).toThrow(BrowserRefUriError)
    }
  })

  it('accepts a canonical percent-encoded slash inside an id', () => {
    const uri = encodeBrowserRefUri({ referenceId: 'a/b' })
    expect(uri).toBe(`${BROWSER_REF_SCHEME}a%2Fb`)
    expect(decodeBrowserRefUri(uri)).toEqual({ referenceId: 'a/b' })
  })

  it('parseBrowserRefUri is the non-throwing variant', () => {
    expect(parseBrowserRefUri('https://x')).toBeUndefined()
    expect(parseBrowserRefUri(encodeBrowserRefUri({ referenceId: 'r' }))).toEqual({ referenceId: 'r' })
  })
})

describe('isBrowserRefUri', () => {
  it('is false for ordinary URLs and other plugin schemes', () => {
    expect(isBrowserRefUri('https://example.com/a')).toBe(false)
    expect(isBrowserRefUri('http://example.com')).toBe(false)
    expect(isBrowserRefUri('dsh-session:abc')).toBe(false)
    expect(isBrowserRefUri(encodeBrowserRefUri({ referenceId: 'r', partId: 'p' }))).toBe(true)
  })
})
