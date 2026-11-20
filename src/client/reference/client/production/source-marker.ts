import { encodeBrowserRefUri, parseBrowserRefUri } from '../scheme.ts'

export const SOURCE_LINK_LABEL = '引用来源'

export function sourceMarker(referenceId: string, index: number, title?: string): string {
  const displayTitle = (title ?? '').replace(/[\r\n\t]+/gu, ' ')
    .replace(/[\[\]()\\`<>*_]/gu, '').replace(/\s+/gu, ' ').trim().slice(0, 80).trim()
  const label = `${SOURCE_LINK_LABEL} ${index + 1}${displayTitle === '' ? '' : `：${displayTitle}`}`
  return `[${label}](${encodeBrowserRefUri({ referenceId })})`
}

export function readSourceMarker(text: string, from: number) {
  const marker = /\[([^\]\r\n]*)\]\((dsh-browser-ref:[^()\s]+)\)/gu
  marker.lastIndex = from
  for (let candidate = marker.exec(text); candidate !== null; candidate = marker.exec(text)) {
    const uri = candidate[2]!
    const reference = parseBrowserRefUri(uri)
    if (reference === undefined) continue
    return { start: candidate.index, end: candidate.index + candidate[0].length,
      uri, label: candidate[1] ?? uri, ...reference }
  }
  return undefined
}

/** Attached markers are editor tokens; submission projects their groups once. */
export function composerText(text: string, attachedIds: ReadonlySet<string>): string {
  let output = ''
  let from = 0
  for (let marker = readSourceMarker(text, from); marker !== undefined; marker = readSourceMarker(text, from)) {
    output += text.slice(from, marker.start)
    if (!attachedIds.has(marker.referenceId) || marker.partId !== undefined) output += text.slice(marker.start, marker.end)
    from = marker.end
  }
  return output + text.slice(from)
}
