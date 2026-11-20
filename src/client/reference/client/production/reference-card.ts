/**
 * Dock reference card: a pure, content-complete view model.
 *
 * The pills are rendered by `ReferenceDock.tsx` into `conversation.input.chips`
 * (inside the composer card). The model carries everything that surface shows:
 * source host/title, a verbatim excerpt, the content type, REAL image thumbnails
 * (base64 bytes + sha256 from the asset endpoint), full table structure
 * (header/data rows, merges, completeness, partial selection) and the captured
 * `parts` in their original order — images are NEVER hoisted to the front.
 *
 * @module dsh-browser-reference/production/reference-card
 */
import type { AssetBinding, AssetStore } from './asset-store.ts'
import type { SourceDescription } from './snapshot-adapter.ts'
import {
  contentTypeOf,
  projectTableText,
  sourceOf,
  type ContentType,
} from './snapshot-adapter.ts'
import type {
  DeliveryFailure,
  ExportFormat,
  FrozenSnapshot,
  TableSnapshot,
} from './protocol.ts'
import type { StoredReflection } from './draft-adapter.ts'

export interface CardImage {
  readonly partId: string
  readonly assetKey: string
  readonly representation: string
  readonly alt?: string
  readonly caption?: string
  /** Real bytes as base64, straight from the asset binding. */
  readonly data: string
  readonly mime: string
  readonly byteLength: number
  readonly sha256: string
  /** `data:<mime>;base64,<bytes>` built from real bytes (NOT a page URL). */
  readonly thumbnailSrc: string
  readonly bound: boolean
}

export interface CardInlineImage {
  readonly partId: string
  readonly assetKey: string
  readonly bound: boolean
  readonly thumbnailSrc?: string
}

export interface CardTableCell {
  readonly row: number
  readonly column: number
  readonly rowSpan: number
  readonly columnSpan: number
  readonly role: 'header' | 'data'
  readonly text: string
  readonly includedAs: 'selection' | 'header-context'
  readonly partialText: boolean
  readonly inlineImages: readonly CardInlineImage[]
}

export interface CardTable {
  readonly partId: string
  readonly rowCount: number
  readonly columnCount: number
  readonly cells: readonly CardTableCell[]
  readonly caption?: string
  readonly completeness: TableSnapshot['completeness']
  readonly normalizationVersion: string
  readonly headers: readonly string[]
  readonly selectedCell?: { readonly row: number; readonly column: number }
  /** Model-facing text projection (kept for the send path). */
  readonly text: string
}

export interface CardText {
  readonly partId: string
  readonly text: string
  readonly exact: string
  readonly prefix: string
  readonly suffix: string
}

export type CardPart =
  | { readonly kind: 'text'; readonly value: CardText }
  | { readonly kind: 'image'; readonly value: CardImage }
  | { readonly kind: 'table'; readonly value: CardTable }

export interface CardMenu {
  readonly exportFormats: readonly ExportFormat[]
  readonly canImport: boolean
  readonly exportSessionId: string
}

export interface CardViewModel {
  readonly referenceId: string
  readonly intentId: string
  /** 1-based position shown on the bar and in the detail (three-state §5.1). */
  readonly index: number
  readonly state: 'prepared' | 'draft-applied' | 'acknowledged'
  readonly source: SourceDescription
  readonly contentType: ContentType
  /** First captured text verbatim (full), or the page title when there is none. */
  readonly excerpt: string
  /** Ordered parts in capture order; mixed content keeps its original order. */
  readonly parts: readonly CardPart[]
  readonly failures: readonly DeliveryFailure[]
  /** The user's note; omitted entirely when there is none (§5.4). */
  readonly comment?: string
  readonly edit: { readonly referenceId: string; readonly comment: string }
  readonly menu: CardMenu
  readonly removeAction: { readonly intentId: string; readonly referenceId: string }
}

function cardImage(
  part: Extract<FrozenSnapshot['parts'][number], { type: 'image' }>,
  assets: AssetStore,
): CardImage {
  const binding: AssetBinding | undefined = assets.get(part.assetKey)
  const data = binding?.data ?? ''
  const mime = binding?.mime ?? 'application/octet-stream'
  return {
    partId: part.partId,
    assetKey: part.assetKey,
    representation: part.representation,
    ...(part.alt === undefined ? {} : { alt: part.alt }),
    ...(part.caption === undefined ? {} : { caption: part.caption }),
    data,
    mime,
    byteLength: binding?.bytes ?? 0,
    sha256: binding?.sha256 ?? part.assetKey,
    thumbnailSrc: data === '' ? '' : `data:${mime};base64,${data}`,
    bound: binding !== undefined,
  }
}

function cardTable(
  part: Extract<FrozenSnapshot['parts'][number], { type: 'table' }>,
  assets: AssetStore,
): CardTable {
  const cells: CardTableCell[] = part.table.cells.map(cell => ({
    row: cell.row,
    column: cell.column,
    rowSpan: cell.rowSpan,
    columnSpan: cell.columnSpan,
    role: cell.role,
    text: cell.text,
    includedAs: cell.includedAs,
    partialText: cell.partialText,
    inlineImages: (cell.inlineContent ?? [])
      .filter((run): run is Extract<typeof run, { type: 'image' }> => typeof run !== 'string' && run.type === 'image')
      .map(run => {
        const binding = assets.get(run.assetKey)
        return {
          partId: run.partId, assetKey: run.assetKey, bound: binding !== undefined,
          ...binding === undefined ? {} : { thumbnailSrc: `data:${binding.mime};base64,${binding.data}` },
        }
      }),
  }))
  return {
    partId: part.partId,
    rowCount: part.table.rowCount,
    columnCount: part.table.columnCount,
    cells,
    ...(part.table.caption === undefined ? {} : { caption: part.table.caption }),
    completeness: part.table.completeness,
    normalizationVersion: part.table.normalizationVersion,
    headers: part.anchor.headers,
    ...(part.anchor.cell === undefined ? {} : { selectedCell: part.anchor.cell }),
    text: projectTableText(part.table, part.table.caption ?? part.anchor.caption),
  }
}

/** Build one full card view model from a restorable reflection. */
export function buildCardViewModel(
  reflection: StoredReflection,
  assets: AssetStore,
  index = 1,
): CardViewModel {
  const snapshot = reflection.snapshot
  const parts: CardPart[] = snapshot.parts.map((part): CardPart => {
    switch (part.type) {
      case 'text':
        return { kind: 'text', value: {
          partId: part.partId,
          text: part.text,
          exact: part.anchor.exact,
          prefix: part.anchor.prefix,
          suffix: part.anchor.suffix,
        } }
      case 'image':
        return { kind: 'image', value: cardImage(part, assets) }
      case 'table':
        return { kind: 'table', value: cardTable(part, assets) }
      default: {
        const exhaustive: never = part
        throw new Error(`unhandled card part: ${JSON.stringify(exhaustive)}`)
      }
    }
  })
  const firstText = snapshot.parts.find((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
  return {
    referenceId: reflection.referenceId,
    intentId: reflection.intentId,
    index,
    state: reflection.deliveryState,
    source: sourceOf(snapshot),
    contentType: contentTypeOf(snapshot),
    excerpt: firstText === undefined ? snapshot.source.title : firstText.text,
    parts,
    failures: reflection.failures,
    ...reflection.comment === undefined ? {} : { comment: reflection.comment },
    edit: { referenceId: reflection.referenceId, comment: reflection.comment ?? '' },
    menu: {
      exportFormats: ['jsonl', 'markdown', 'zip', 'markdown-zip'],
      canImport: true,
      exportSessionId: reflection.snapshot.owner.sessionId ?? '',
    },
    removeAction: { intentId: reflection.intentId, referenceId: reflection.referenceId },
  }
}

/**
 * Interactions the hover card offers. Callbacks keep the presentation pure: the
 * assembly wires them to the runtime, and a card with no handler simply does not
 * expose the control.
 */
export interface CardActions {
  readonly onEditComment?: (referenceId: string, comment: string) => void
  readonly onRemove?: (referenceId: string) => void
  /** Scroll the sidebar browser back to this reference's原文 and highlight it. */
  readonly onReveal?: (referenceId: string) => void
}
