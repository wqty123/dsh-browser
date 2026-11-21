export function rewriteCss(css: string, proxy: (url: string) => string | undefined): string {
  const scanner = {
    decode(value: string): string { return value.replace(/\\(?:([\da-f]{1,6})(?:\r\n|[ \t\r\n\f])?|(\r\n|[\r\n\f])|([\s\S]))/giu,
      (_match, hex: string | undefined, newline: string | undefined, literal: string) => {
        if (hex === undefined) return newline === undefined ? literal : ''
        const point = Number.parseInt(hex, 16)
        return point === 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff) ? '\ufffd' : String.fromCodePoint(point)
      }) },
    stringEnd(start: number): number {
      const quote = css[start]
      let end = start + 1
      while (end < css.length) {
        if (css[end] === '\\') { end += 2; continue }
        if (css[end++] === quote) return end
      }
      return end
    },
    replacement(raw: string): string | undefined { return proxy(this.decode(raw)) },
  }
  const functions: string[] = []
  let result = '', position = 0, importing = false
  while (position < css.length) {
    if (css.startsWith('/*', position)) {
      const close = css.indexOf('*/', position + 2)
      const end = close === -1 ? css.length : close + 2
      result += css.slice(position, end); position = end; continue
    }
    const character = css[position]!
    if (/\s/u.test(character)) { result += character; position++; continue }
    if (character === '"' || character === "'") {
      const end = scanner.stringEnd(position)
      const next = css[end - 1] === character && (importing || /^(?:-webkit-)?image-set$/iu.test(functions.at(-1) ?? ''))
        ? scanner.replacement(css.slice(position + 1, end - 1)) : undefined
      result += next === undefined ? css.slice(position, end) : `"${next}"`
      importing = false; position = end; continue
    }
    const identifier = /^[-\w]+/u.exec(css.slice(position))?.[0]
    if (character === '@' && /^@import\b/iu.test(css.slice(position))) {
      result += css.slice(position, position + 7); position += 7; importing = true; continue
    }
    if (identifier !== undefined) {
      const start = position
      position += identifier.length
      if (css[position] !== '(') { result += identifier; importing = false; continue }
      position++
      if (identifier.toLowerCase() !== 'url') {
        functions.push(identifier); result += css.slice(start, position); importing = false; continue
      }
      while (/\s/u.test(css[position] ?? '') && position < css.length) position++
      const quoted = css[position] === '"' || css[position] === "'"
      const valueStart = position
      if (quoted) position = scanner.stringEnd(position)
      else while (position < css.length && css[position] !== ')') position += css[position] === '\\' ? 2 : 1
      const valueEnd = position
      while (/\s/u.test(css[position] ?? '') && position < css.length) position++
      if (css[position] !== ')') { result += css.slice(start, position); importing = false; continue }
      const raw = quoted ? css.slice(valueStart + 1, valueEnd - 1) : css.slice(valueStart, valueEnd).trim()
      const next = scanner.replacement(raw)
      position++
      result += next === undefined ? css.slice(start, position) : `url("${next}")`
      importing = false; continue
    }
    if (character === ')') functions.pop()
    else if (character === '(') functions.push('')
    result += character; position++; importing = false
  }
  return result
}
