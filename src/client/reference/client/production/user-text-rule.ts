/** Browser-source markers are parsed by the host text registry, preserving React-owned nodes. */
import type { UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { parseBrowserRefUri } from '../scheme.ts'

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
    const marker = /\[([^\]\r\n]*)\]\((dsh-browser-ref:[^()\s]+)\)/gu
    marker.lastIndex = from
    for (let candidate = marker.exec(text); candidate !== null; candidate = marker.exec(text)) {
      const uri = candidate[2]
      if (uri === undefined || parseBrowserRefUri(uri) === undefined) continue
      return {
        id: 'browser-ref', start: candidate.index, end: candidate.index + candidate[0].length,
        data: { uri, label: candidate[1] ?? uri },
      }
    }
    return undefined
  },
}
