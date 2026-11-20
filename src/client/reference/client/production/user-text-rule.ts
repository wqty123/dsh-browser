/** Browser-source markers are parsed by the host text registry, preserving React-owned nodes. */
import type { UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { readSourceMarker, readSubmissionQuote } from './source-marker.ts'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    'browser-ref': { readonly uri: string; readonly label: string }
  }
}

/** Match the next canonical source marker without changing the logged message. */
export const browserSourceRule: UserTextRule<'browser-ref'> = {
  id: 'browser-ref',
  order: 20,
  match(text, from) {
    const marker = readSourceMarker(text, from)
    const quote = readSubmissionQuote(text, from)
    if (quote !== undefined && (marker === undefined || quote.start < marker.start)) {
      return { id: 'text', start: quote.start, end: quote.end,
        data: { text: text.slice(quote.start, quote.end), display: '' } }
    }
    return marker === undefined ? undefined : {
      id: 'browser-ref', start: marker.start, end: marker.end,
      data: { uri: marker.uri, label: marker.label },
    }
  },
}
