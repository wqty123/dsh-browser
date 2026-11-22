/** Browser-source markers are parsed by the host text registry, preserving React-owned nodes. */
import type { UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { readSourceMarker, readSubmissionQuote } from './source-marker.ts'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    'browser-ref': { readonly uri: string; readonly label: string }
  }
}

function nearestMarkerForQuote(text: string, quoteStart: number, nextMarker: ReturnType<typeof readSourceMarker>) {
  let previous: ReturnType<typeof readSourceMarker>
  for (let cursor = 0; cursor < quoteStart;) {
    const found = readSourceMarker(text, cursor)
    if (found === undefined || found.start >= quoteStart) break
    previous = found
    cursor = found.end
  }
  return previous ?? nextMarker
}

/**
 * Build the canonical source marker rule. When `hasDetail` is supplied, a quote whose
 * archived reference was evicted keeps its readable body instead of collapsing to empty text.
 */
export function createBrowserSourceRule(
  hasDetail?: (referenceId: string) => boolean,
): UserTextRule<'browser-ref'> {
  return {
    id: 'browser-ref',
    order: -20,
    match(text, from) {
      const marker = readSourceMarker(text, from)
      const quote = readSubmissionQuote(text, from)
      if (quote !== undefined && (marker === undefined || quote.start < marker.start)) {
        let display = ''
        if (hasDetail !== undefined) {
          const associated = nearestMarkerForQuote(text, quote.start, marker)
          if (associated === undefined || !hasDetail(associated.referenceId)) {
            display = quote.body
          }
        }
        return { id: 'text', start: quote.start, end: quote.end,
          data: { text: text.slice(quote.start, quote.end), display } }
      }
      if (marker === undefined) return undefined
      const line = text.lastIndexOf('\n', marker.start - 1) + 1
      const start = line >= from && /^ {0,3}>[ \t]?$/u.test(text.slice(line, marker.start)) ? line : marker.start
      return {
        id: 'browser-ref', start, end: marker.end,
        data: { uri: marker.uri, label: marker.label },
      }
    },
  }
}

/** Match the next canonical source marker without changing the logged message. */
export const browserSourceRule: UserTextRule<'browser-ref'> = createBrowserSourceRule()
