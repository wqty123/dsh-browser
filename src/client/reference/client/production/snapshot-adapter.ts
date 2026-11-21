/**
 * Pure adapter from the plugin's FROZEN `BrowserReference` snapshot to the
 * additive package's `OrderedReferenceGroup` contract and to card/send content.
 *
 * Nothing here re-fetches the page: the snapshot already carries ordered parts,
 * long text verbatim, table cells (with merges / role / completeness / partial
 * selection) and image asset keys. Two projections are deliberately kept:
 *   - the lossy `OrderedReferenceGroup` (for `createSubmissionProjector`);
 *   - the full snapshot (for the dock card and reveal), retained alongside the
 *     group by the draft adapter so no cell or byte is lost on recovery.
 *
 * @module dsh-browser-reference/production/snapshot-adapter
 */
import type { BrowserReferencePart as ContractPart, OrderedReferenceGroup } from '../types.ts'
import type {
  BrowserReferencePart,
  FrozenSnapshot,
  TableSnapshot,
} from './protocol.ts'

/** A source description a card can render without re-reading the page. */
export interface SourceDescription {
  readonly host: string
  readonly title: string
  readonly pageUrl: string
  readonly capturedAt: string
  readonly frameUrl?: string
  readonly frameRoute?: 'main' | 'frame'
  readonly frameSelector?: string
}

/** Extract the host of a page URL without throwing on unusual schemes. */
export function sourceOf(snapshot: FrozenSnapshot): SourceDescription {
  const { source } = snapshot
  let host = source.pageUrl
  try {
    host = new URL(source.pageUrl).host || source.pageUrl
  } catch { /* an unparseable pageUrl keeps its literal value */ }
  return {
    host,
    title: source.title,
    pageUrl: source.pageUrl,
    capturedAt: source.capturedAt,
    ...(source.frameUrl === undefined ? {} : { frameUrl: source.frameUrl }),
    ...(source.frameRoute === undefined ? {} : { frameRoute: source.frameRoute }),
    ...(source.frameSelector === undefined ? {} : { frameSelector: source.frameSelector }),
  }
}

export type ContentType = 'text' | 'image' | 'table' | 'mixed'

/** `mixed` is derived from parts with more than one kind (never reordered). */
export function contentTypeOf(snapshot: FrozenSnapshot): ContentType {
  const first = snapshot.parts[0]?.type
  if (first === undefined) return 'text'
  return snapshot.parts.every(part => part.type === first) ? first : 'mixed'
}

/**
 * Deterministic, lossless-enough text projection of a table snapshot for the
 * model block. Every cell's `text` is included verbatim; merges, role,
 * completeness and partial-selection facts are annotated so a unit test (and a
 * reader) can see the structure that Markdown/TSV would otherwise flatten.
 */
export function projectTableText(table: TableSnapshot, caption?: string): string {
  const lines: string[] = []
  lines.push(`[table ${table.rowCount}x${table.columnCount} completeness=${table.completeness} norm=${table.normalizationVersion}]`)
  if (caption !== undefined && caption !== '') lines.push(`caption: ${caption}`)
  for (const cell of table.cells) {
    const span = `${cell.rowSpan}r x ${cell.columnSpan}c`
    const flags = [
      cell.role,
      cell.includedAs,
      cell.partialText ? 'partial-text' : 'full-text',
    ].join(',')
    const images = (cell.inlineContent ?? [])
      .filter((run): run is Extract<typeof run, { type: 'image' }> => run.type === 'image')
      .map(run => `${run.partId}@${run.assetKey}`)
      .join(',')
    lines.push(`[${cell.row},${cell.column}] (${span}; ${flags})${images === '' ? '' : ` images=[${images}]`}: ${cell.text}`)
  }
  return lines.join('\n')
}

/** One part of a frozen snapshot -> one contract part (capture order preserved). */
function projectPart(part: BrowserReferencePart, referenceId: string): ContractPart {
  switch (part.type) {
    case 'text':
      return {
        kind: 'text',
        partId: part.partId,
        referenceId,
        text: part.text,
        ...(part.content === undefined ? {} : { content: part.content }),
        label: part.anchor.exact,
      }
    case 'image':
      return {
        kind: 'image',
        partId: part.partId,
        referenceId,
        assetKey: part.assetKey,
        ...((part.alt ?? part.caption) === undefined ? {} : { text: [part.alt === undefined ? undefined : `Image: ${part.alt}`, part.caption].filter(value => value !== undefined).join('\n') }),
        ...(part.alt === undefined ? {} : { label: part.alt }),
        // No `mimeType`: the contract field is a real MIME type, and a frozen
        // snapshot does not carry one (bytes and their sidecar do). Claiming
        // `image` here would be a value no consumer could rely on.
      }
    case 'table':
      return {
        kind: 'table',
        partId: part.partId,
        referenceId,
        text: projectTableText(part.table, part.table.caption ?? part.anchor.caption),
        table: part.table,
      }
    default: {
      const exhaustive: never = part
      throw new Error(`unhandled snapshot part: ${JSON.stringify(exhaustive)}`)
    }
  }
}

/** Convert a frozen snapshot into the additive ordered group. */
export function toOrderedGroup(snapshot: FrozenSnapshot): OrderedReferenceGroup {
  return {
    referenceId: snapshot.referenceId,
    parts: snapshot.parts.map(part => projectPart(part, snapshot.referenceId)),
  }
}

/**
 * All image asset keys a reference needs, including inline images inside table
 * cells. Mirrors the plugin's `imageAssetKeys()` so the client ACK carries the
 * exact same set the server checks. Order-stable and deduplicated.
 */
export function requiredAssetKeys(snapshot: FrozenSnapshot): readonly string[] {
  const keys: string[] = []
  const visit = (part: BrowserReferencePart): void => {
    if (part.type === 'image') {
      keys.push(part.assetKey)
      return
    }
    if (part.type === 'table') {
      for (const cell of part.table.cells) {
        for (const run of cell.inlineContent ?? []) {
          if (run.type === 'image') keys.push(run.assetKey)
        }
      }
    }
  }
  for (const part of snapshot.parts) visit(part)
  return [...new Set(keys)]
}
