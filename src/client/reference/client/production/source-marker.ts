import { encodeBrowserRefUri, parseBrowserRefUri } from '../scheme.ts'

export const SOURCE_LINK_LABEL = '引用来源'
const QUOTE_OPEN = '<dsh-browser-quote length="'
const QUOTE_CLOSE = '</dsh-browser-quote>'

export function submissionQuote(text: string): string {
  return `${QUOTE_OPEN}${text.length}">${text}${QUOTE_CLOSE}\n`
}

export function readSubmissionQuote(text: string, from: number) {
  const header = /<dsh-browser-quote length="(\d+)">/gu
  header.lastIndex = from
  for (let match = header.exec(text); match !== null; match = header.exec(text)) {
    const length = Number(match[1])
    if (!Number.isSafeInteger(length)) continue
    const close = header.lastIndex + length
    if (text.slice(close, close + QUOTE_CLOSE.length) !== QUOTE_CLOSE) continue
    let end = close + QUOTE_CLOSE.length
    if (text[end] === '\n') end += 1
    return { start: match.index, end, body: text.slice(header.lastIndex, close) }
  }
  return undefined
}

export function sourceMarker(referenceId: string, index: number, title?: string): string {
  const cleaned = (title ?? '').replace(/[\r\n\t]+/gu, ' ')
    .replace(/[\[\]()\\`<>*_]/gu, '').replace(/\s+/gu, ' ').trim()
  const displayTitle = Array.from(cleaned).slice(0, 80).join('').trim()
  const rawLabel = `${SOURCE_LINK_LABEL} ${index + 1}${displayTitle === '' ? '' : `：${displayTitle}`}`
  const label = typeof rawLabel.toWellFormed === 'function' ? rawLabel.toWellFormed() : rawLabel
  // The label travels readable: the host renders this attribute as the capsule's visible text and
  // does not decode it, so percent-encoding showed `%E5%BC%95…` instead of the source title. The
  // sanitizer above removed every character that could close the attribute (`"`, `<`, `>`, `\`,
  // newlines); spaces are allowed by the reader below. A literal `%` is the one sequence the reader
  // still decodes, so it is escaped here and restored on read.
  return `<dsh-browser-reference uri="${encodeBrowserRefUri({ referenceId })}" label="${label.replaceAll('%', '%25')}"/>`
}

export function readSourceMarker(text: string, from: number) {
  // `[^"\s]*` used to be enough while labels were percent-encoded; a readable label contains
  // spaces, so the body allows any non-quote character and percent-decodes only legacy labels.
  const marker = /<dsh-browser-reference uri="(dsh-browser-ref:[^"\s]+)" label="([^"]*)"\/>|\[([^\]\r\n]*)\]\((dsh-browser-ref:[^()\s]+)\)/gu
  marker.lastIndex = from
  for (let candidate = marker.exec(text); candidate !== null; candidate = marker.exec(text)) {
    const uri = (candidate[1] ?? candidate[4])!
    const reference = parseBrowserRefUri(uri)
    if (reference === undefined) continue
    let label = candidate[3] ?? uri
    if (candidate[2] !== undefined) {
      const raw = candidate[2]
      // Earlier builds wrote encodeURIComponent(label); decode only that shape so a title that
      // happens to contain a percent sign is not mangled.
      if (/%[0-9A-Fa-f]{2}/u.test(raw)) {
        try { label = decodeURIComponent(raw) } catch { continue }
      } else {
        label = raw
      }
    }
    return { start: candidate.index, end: candidate.index + candidate[0].length,
      uri, label, ...reference }
  }
  return undefined
}

const COMPOSER_OPEN = '<dsh-browser-quote>'
const COMPOSER_CLOSE = '</dsh-browser-quote>'
const QUOTE_PREFIX = /^ {0,3}>[ \t]?/u

/** The editor quote for one reference: its projected body framed by tags, then its source marker. */
export function composerQuote(body: string, marker: string): string {
  const normalized = body.replace(/\r\n?/gu, '\n').replace(/\n+$/u, '')
  return `${COMPOSER_OPEN}\n${normalized}\n${COMPOSER_CLOSE}\n${marker}`
}

/**
 * Find a composer quote in sent text. The host prefixes every quoted line with `> `, so the frame
 * lines, the body lines and the marker line are matched with or without that prefix.
 */
export function readComposerQuote(text: string, from: number) {
  const open = /(^|\n)( {0,3}>[ \t]?)?<dsh-browser-quote>\n/gu
  open.lastIndex = Math.max(0, from - 1)
  for (let match = open.exec(text); match !== null; match = open.exec(text)) {
    const start = match.index + match[1]!.length
    const bodyStart = open.lastIndex
    open.lastIndex = bodyStart - 1
    if (start < from) continue
    const close = /\n( {0,3}>[ \t]?)?<\/dsh-browser-quote>\n/gu
    close.lastIndex = bodyStart - 1
    const closed = close.exec(text)
    if (closed === null) return undefined
    const marker = readSourceMarker(text, close.lastIndex)
    if (marker === undefined || !/^( {0,3}>[ \t]?)?$/u.test(text.slice(close.lastIndex, marker.start))) continue
    const body = text.slice(bodyStart, closed.index).split('\n').map(line => line.replace(QUOTE_PREFIX, '')).join('\n')
    const markerLine = text.lastIndexOf('\n', marker.start - 1) + 1
    return { start, end: marker.end, markerLine, body, marker }
  }
  return undefined
}
