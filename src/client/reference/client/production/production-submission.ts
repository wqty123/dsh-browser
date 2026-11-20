/**
 * Ordered submission projection into the HOST's real prompt content blocks.
 *
 * The host's `service.ts:302` currently builds
 *   `content = [...uploaded, ...(text === '' ? [] : [{ type: 'text', text }])]`
 * where `uploaded` are already-serialized `PromptContentPart`s from the host's
 * image/file attachment admission. We REUSE `createSubmissionProjector` (the
 * additive contract) to interleave the captured groups in capture order, then
 * map its `text`/`image`/`table` parts into the host's content vocabulary:
 *   - `text` / `table` -> `{ type: 'text', text }` (verbatim / structural text);
 *   - `image` -> `admitImage(assetKey)` -> a REAL `{ type: 'image', data }` or
 *     `{ type: 'file', receiptId }` from the host attachment service. NEVER a
 *     URL and NEVER alt text; an unbound image keeps its slot as a placeholder.
 *
 * Host attachments (`uploaded`) stay first and the plain composer text stays
 * last, matching `service.ts:302` ("附件在前文字在后"); group parts are inserted
 * between them in order.
 *
 * This module does NOT import or modify `service.ts`. `wireSubmissionContent`
 * is the injectable seam the host calls at line 302 (see deploy/README.md).
 *
 * @module dsh-browser-reference/production/production-submission
 */
import { renderReferenceMarkdownTable } from '../../../../reference-text.ts'
import { referenceOwnerKey } from '../../../../reference-owner.ts'
import type { OrderedReferenceGroup } from '../types.ts'
import { createSubmissionProjector, type TextPosition } from '../ordered-submission.ts'
import { composerText, sourceMarker, submissionQuote } from './source-marker.ts'
import type { AssetStore } from './asset-store.ts'

/** Mirror of `session-controller/src/types.ts:78` (no cross-package import). */
export type HostPromptContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mediaType: string; readonly data: string; readonly name?: string }
  | { readonly type: 'file'; readonly receiptId: string }

/**
 * Resolve one captured image asset into a host-admitted content block.
 * Returns undefined when the asset is not durably bound yet.
 */
export type AdmitImage = (assetKey: string, partId: string) => HostPromptContentPart | undefined

/**
 * Default admission backed by the durable asset store: inline real bytes, or a
 * file receipt when the host uploaded the asset. This is the "宿主已有的
 * 图片/文件附件准入与持久服务" output, not a page URL.
 */
export function createAdmitImage(assets: AssetStore): AdmitImage {
  return (assetKey, partId) => {
    const binding = assets.get(assetKey)
    if (binding === undefined) return undefined
    if (binding.receiptId !== undefined) {
      return { type: 'file', receiptId: binding.receiptId }
    }
    return {
      type: 'image',
      mediaType: binding.mime,
      data: binding.data,
      name: partId,
    }
  }
}

export interface WireSubmissionInput {
  /** Host-serialized attachments, kept verbatim at the front. */
  readonly uploaded: readonly HostPromptContentPart[]
  /** Plain composer text; kept last (matching service.ts:302). */
  readonly text: string
  /** Ordered captured groups for this session. */
  readonly groups: readonly OrderedReferenceGroup[]
  readonly admitImage: AdmitImage
  readonly textPosition?: TextPosition
  /**
   * The user's note per reference. It is submitted as its OWN labelled block so
   * the model never confuses the human's words with the quoted page text
   * (three-state §6).
   */
  readonly comments?: ReadonlyMap<string, string>
  /**
   * Emit one clickable `dsh-browser-ref:` source marker per group. Defaults to
   * TRUE so the real send path always produces a locatable source. Setting it
   * to false restores the exact pre-marker projection (byte-identical to the
   * old output), which is the comparison/rollback lever for A/B tests and for
   * diagnosing a bad link without changing what the model received.
   */
  readonly sourceLinks?: boolean
  /**
   * Optional page title per reference, used ONLY as the marker's visible text
   * (never inside the URI). When absent a stable `引用来源 N` label is used.
   * `toOrderedGroup` drops `source.title`, so production currently takes the
   * fallback; the callback is the seam a host can wire to surface real titles.
   */
  readonly sourceTitleFor?: (referenceId: string) => string | undefined
}

/** The prefix that keeps a note distinguishable from the quoted original. */
export const COMMENT_LABEL = '引用评论'
/** Stable visible label for one attached reference's source marker. */
export { SOURCE_LINK_LABEL } from './source-marker.ts'

/**
 * Build the `content` array for `Session.prompt`. With `groups === []` the
 * result is byte-identical to the host's current `[...uploaded, ...text]`.
 */
export function wireSubmissionContent(input: WireSubmissionInput): readonly HostPromptContentPart[] {
  const perGroup = createSubmissionProjector({ mode: 'ordered' })
  const text = composerText(input.text, new Set(input.groups.map(group => group.referenceId)))
  const quoteText = (text: string): string => input.sourceLinks === false ? text : submissionQuote(text)
  const projectedBlocks = (groups: readonly OrderedReferenceGroup[]): HostPromptContentPart[] =>
    perGroup.project({ text: '', uploaded: [], groups }).map(part => {
      const mapped = mapProjected(part, input.admitImage)
      return mapped.type === 'text' ? { type: 'text', text: quoteText(`${mapped.text}\n`) } : mapped
    })
  const placeUserText = (blocks: HostPromptContentPart[]): void => {
    if (text === '') return
    const block: HostPromptContentPart = { type: 'text', text }
    if (input.textPosition === 'leading') blocks.unshift(block)
    else blocks.push(block)
  }
  // Source markers are ONE extra independent text block appended AFTER every
  // projected group (and after every note), BEFORE the user's own question.
  // They never touch a projected block, so quoted text stays verbatim and keeps
  // its trailing newline (the fifth-round fix). With no groups nothing is added,
  // so `groups === []` stays byte-identical to service.ts:302.
  const appendSourceMarkers = (blocks: HostPromptContentPart[]): void => {
    if (input.sourceLinks === false || input.groups.length === 0) return
    const markers: string[] = []
    input.groups.forEach((group, index) => {
      try {
        markers.push(sourceMarker(group.referenceId, index, input.sourceTitleFor?.(group.referenceId)))
      } catch {
        // A referenceId that cannot be canonicalized must not break the whole
        // send: that single group simply has no marker (B20 partial visibility).
      }
    })
    if (markers.length === 0) return
    blocks.push({ type: 'text', text: `${markers.join('\n')}\n${submissionQuote('Browser reference presentation: the attached references are already displayed as interactive capsules. Do not repeat their markers, reference URIs, source URLs, or source/citation links in the reply. Answer using the quoted content; the capsules provide source navigation.')}` })
  }
  const noted = input.comments === undefined
    ? undefined
    : input.groups.filter(group => (input.comments?.get(group.referenceId) ?? '') !== '')
  if (noted !== undefined && noted.length > 0 && input.comments !== undefined) {
    // Project group by group so each note lands immediately before the content
    // it annotates, while the parts inside a group keep their captured order.
    const withNotes: HostPromptContentPart[] = []
    for (const group of input.groups) {
      const note = input.comments.get(group.referenceId)
      if (note !== undefined && note !== '') {
        // A plain label, not markdown: the user's own message text is rendered as text, so asterisks showed
        // up literally ("**引用评论**：123"). Brackets looked like page content; a bare label reads as a
        // label in every renderer.
        withNotes.push({ type: 'text', text: quoteText(`${COMMENT_LABEL}：${note}\n`) })
      }
      withNotes.push(...projectedBlocks([group]))
    }
    appendSourceMarkers(withNotes)
    placeUserText(withNotes)
    return [...input.uploaded, ...withNotes]
  }
  const blocks: HostPromptContentPart[] = projectedBlocks(input.groups)
  appendSourceMarkers(blocks)
  placeUserText(blocks)
  return [...input.uploaded, ...blocks]
}

/** Map one projected part into the host's content vocabulary. */
function mapProjected(
  part: ReturnType<ReturnType<typeof createSubmissionProjector>['project']>[number],
  admitImage: AdmitImage,
): HostPromptContentPart {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text }
    case 'table':
      return { type: 'text', text: part.table === undefined ? part.text : renderReferenceMarkdownTable(part.table) }
    case 'image': {
      const admitted = admitImage(part.assetKey, part.partId ?? part.assetKey)
      return admitted ?? { type: 'text', text: `[image unavailable: ${part.partId ?? part.assetKey}]` }
    }
    default: {
      const exhaustive: never = part
      throw new Error(`unhandled projected part: ${JSON.stringify(exhaustive)}`)
    }
  }
}

/**
 * Injection seam the host registers; binds a session id to its stored groups.
 * `requestId` is OPTIONAL everywhere, so implementations/tests that omit it
 * keep working through a FIFO fallback.
 */
export interface SubmissionSeam {
  /** Reconcile durable consumption before projecting a restored draft. */
  prepare?(sessionId: string): Promise<void>
  bind?(sessionId: string, requestId: string, hostRequestId: string): Promise<void>
  /** Replacement for the `content = [...uploaded, ...text]` line at service.ts:302. */
  buildContent(input: {
    readonly sessionId: string
    readonly uploaded: readonly HostPromptContentPart[]
    readonly text: string
    /** Stable per-send id; lets concurrent sends keep separate frozen sets. */
    readonly requestId?: string
  }): readonly HostPromptContentPart[]
  /**
   * Consume the exact set frozen by this send's `buildContent`.
   *
   * The host calls this only after `Session.prompt` ACCEPTED the content. A
   * projection alone must never clear the draft: a refused send would drop the
   * references the user still sees, and a footnote would no longer point at the
   * message it came with. References added while the send was in flight are not
   * part of the frozen set and stay in the draft.
   */
  commit(sessionId: string, requestId?: string): void | Promise<void>
  /**
   * Drop the frozen set without consuming anything (refused or thrown send).
   *
   * The draft keeps every reference, so the user can fix the problem and send
   * again with the same quotes.
   */
  rollback(sessionId: string, requestId?: string): void
}

export interface CreateSubmissionSeamOptions {
  readonly bind?: (sessionId: string, hostRequestId: string, intentIds: readonly string[]) => Promise<void>
  /** Resolve the ordered groups for one session (from the session draft store). */
  readonly groupsFor: (sessionId: string) => readonly OrderedReferenceGroup[]
  /** Resolve the durable asset store for one session. */
  readonly assetsFor: (sessionId: string) => AssetStore
  /** The draft's notes per reference, submitted as labelled blocks. */
  readonly commentsFor?: (sessionId: string) => ReadonlyMap<string, string>
  /**
   * Called with the exact reference ids a now-accepted send carried, so the
   * draft stops holding them while the sent message keeps their provenance.
   *
   * Without this the next message re-attaches the same quote: the card survived the
   * send, and a restart rebuilt it from its acknowledged delivery.
   */
  readonly submitted?: (sessionId: string, referenceIds: readonly string[]) => void | Promise<void>
  readonly textPosition?: TextPosition
  /** Passed through to `wireSubmissionContent`; omitted => source links ON. */
  readonly sourceLinks?: boolean
  /** Optional visible page title per reference for the source markers. */
  readonly sourceTitleFor?: (referenceId: string) => string | undefined
}

/** Build the seam the assembly registers into the host context. */
export function createSubmissionSeam(options: CreateSubmissionSeamOptions): SubmissionSeam {
  /** One frozen set per requestId — never a single overwritable per-session key. */
  const tokenized = new Map<string, readonly string[]>()
  /** Untagged sends (older hosts / tests) fall back to a per-session FIFO queue. */
  const untagged = new Map<string, string[][]>()

  const consume = (sessionId: string, requestId?: string): readonly string[] | undefined => {
    if (requestId !== undefined) {
      const ids = tokenized.get(requestId)
      tokenized.delete(requestId)
      if (ids !== undefined) return ids
    }
    const queue = untagged.get(sessionId)
    const ids = queue?.shift()
    if (queue !== undefined && queue.length === 0) untagged.delete(sessionId)
    return ids
  }

  return {
    async bind(sessionId, requestId, hostRequestId) {
      sessionId = referenceOwnerKey(sessionId)
      const ids = tokenized.get(requestId)
      if (ids !== undefined && ids.length > 0) await options.bind?.(sessionId, hostRequestId, ids)
    },
    buildContent({ sessionId: rawSessionId, uploaded, text, requestId }) {
      // The send path passes the shell's "session-<uuid>"; the draft store, the comments and the asset
      // bindings are all keyed on the bare id. Without this the chips were visible in the composer while
      // buildContent saw ZERO groups, so the message went out with the typed text alone and the model
      // answered "there is nothing attached".
      const sessionId = referenceOwnerKey(rawSessionId)
      const groups = options.groupsFor(sessionId)
      const content = wireSubmissionContent({
        uploaded,
        text,
        groups,
        admitImage: createAdmitImage(options.assetsFor(sessionId)),
        ...options.commentsFor === undefined ? {} : { comments: options.commentsFor(sessionId) },
        ...(options.textPosition === undefined ? {} : { textPosition: options.textPosition }),
        ...(options.sourceLinks === undefined ? {} : { sourceLinks: options.sourceLinks }),
        ...(options.sourceTitleFor === undefined ? {} : { sourceTitleFor: options.sourceTitleFor }),
      })
      const ids = groups.map(group => group.referenceId)
      // Pure read: remember what this projection used, decide nothing yet.
      if (requestId !== undefined) tokenized.set(requestId, ids)
      else {
        const queue = untagged.get(sessionId) ?? []
        queue.push(ids)
        untagged.set(sessionId, queue)
      }
      return content
    },
    commit(sessionId, requestId) {
      sessionId = referenceOwnerKey(sessionId)
      const referenceIds = consume(sessionId, requestId)
      if (referenceIds !== undefined && referenceIds.length > 0) {
        return options.submitted?.(sessionId, referenceIds)
      }
    },
    rollback(sessionId, requestId) {
      sessionId = referenceOwnerKey(sessionId)
      consume(sessionId, requestId)
    },
  }
}
