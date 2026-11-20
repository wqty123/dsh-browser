/**
 * Dependency-free base64 <-> bytes helpers.
 *
 * The package targets both a browser realm (DOM lib) and the Node-based unit
 * lane, and compiles with `types: []` (no @types/node). `btoa`/`atob` are
 * therefore NOT used: this codec works on plain `Uint8Array` everywhere and is
 * what the asset endpoint's `data` field and the image thumbnail consume.
 *
 * @module dsh-browser-reference/production/bytes
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Decode a standard base64 string into bytes. Throws on invalid input. */
export function decodeBase64(input: string): Uint8Array {
  const clean = input.replace(/[\s]/gu, '')
  if (clean.length % 4 !== 0) throw new Error('invalid base64 length')
  const withoutPadding = clean.replace(/=+$/u, '')
  const lookup = new Map<string, number>()
  for (let i = 0; i < ALPHABET.length; i += 1) lookup.set(ALPHABET[i]!, i)
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const char of withoutPadding) {
    const value = lookup.get(char)
    if (value === undefined) throw new Error(`invalid base64 character: ${char}`)
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
      buffer &= (1 << bits) - 1
    }
  }
  return new Uint8Array(bytes)
}
