/**
 * What one captured reference puts into the composer.
 *
 * The stock conversation send path is `[...serializeAttachments(), { type: 'text', text }]`: the model
 * sees the composer text and the composer attachments, nothing else. So a reference reaches the model
 * only through those two places — its text, tables and image placeholders become the quote inserted
 * into the editor, and its images become composer attachments.
 */
import { renderReferenceMarkdownTable } from '../../../../reference-text.ts'
import type { OrderedReferenceGroup } from '../types.ts'
import { createSubmissionProjector } from '../ordered-submission.ts'
import { composerQuote, sourceMarker } from './source-marker.ts'
import type { AssetBinding, AssetStore } from './asset-store.ts'

/** Stable visible label for one attached reference's source marker. */
export { SOURCE_LINK_LABEL } from './source-marker.ts'

export const REFERENCE_PRESENTATION = 'Browser reference presentation: this quote is already displayed as an interactive capsule. Do not repeat its marker, reference URI, source URL, or source/citation links in the reply. Answer using the quoted content; the capsule provides source navigation.'

/** One captured image that travels as a composer attachment. */
export interface ComposerImage {
  readonly partId: string
  readonly binding: AssetBinding
}

export interface ComposerReference {
  /** The quote text inserted into the editor; the host sends it verbatim (line-quoted). */
  readonly text: string
  /** Images bound in the durable asset store, in capture order. */
  readonly images: readonly ComposerImage[]
}

export interface ComposerReferenceInput {
  /** Zero-based position among this draft's references (the marker's visible number). */
  readonly index: number
  readonly title?: string
  readonly assets: AssetStore
}

/** Project one reference group into the composer quote and its image attachments. */
export function composerReference(group: OrderedReferenceGroup, input: ComposerReferenceInput): ComposerReference {
  const lines: string[] = []
  const images: ComposerImage[] = []
  for (const part of createSubmissionProjector({ mode: 'ordered' }).project({ text: '', uploaded: [], groups: [group] })) {
    switch (part.type) {
      case 'text':
        lines.push(part.text)
        break
      case 'table':
        lines.push(part.table === undefined ? part.text : renderReferenceMarkdownTable(part.table))
        break
      case 'image': {
        const partId = part.partId ?? part.assetKey
        const binding = input.assets.get(part.assetKey)
        if (binding === undefined) lines.push(`[image unavailable: ${partId}]`)
        else {
          images.push({ partId, binding })
          lines.push(`[image ${images.length}: ${partId}, attached to this message]`)
        }
        break
      }
      default: {
        const exhaustive: never = part
        throw new Error(`unhandled projected part: ${JSON.stringify(exhaustive)}`)
      }
    }
  }
  lines.push(REFERENCE_PRESENTATION)
  return { text: composerQuote(lines.join('\n'), sourceMarker(group.referenceId, input.index, input.title)), images }
}
