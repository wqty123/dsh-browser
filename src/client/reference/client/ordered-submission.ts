/**
 * Order-preserving projection of ordered reference groups into prompt content
 * (§4, B18), plus a byte-identical compatibility default (§4 "current fact").
 *
 * The host composer currently emits `[...uploaded, ...(text === '' ? [] : [text])]`
 * (ui-conversation/src/client/service.ts:302). `projectCompatibilityContent`
 * reproduces that exact shape, so with the new feature disabled nothing changes.
 * `projectOrderedContent` interleaves text/image/table parts in capture order.
 * Both are pure functions; the host selects one through an injected projector
 * interface. This module does NOT import or modify the host `service.ts`.
 */
import type {
  OrderedReferenceGroup,
  BrowserReferencePart,
  PromptContentPart,
} from './types.ts'

export interface SubmissionInput {
  readonly text: string
  /** Existing serialized attachments (the host's `serializeAttachments()`). */
  readonly uploaded: readonly PromptContentPart[]
  /** Ordered web-reference groups; empty when the feature is not enabled. */
  readonly groups: readonly OrderedReferenceGroup[]
}

/** Where the plain composer text goes relative to the ordered parts. */
export type TextPosition = 'leading' | 'trailing'

export interface OrderedProjectionOptions {
  readonly textPosition?: TextPosition
}

function projectPart(part: BrowserReferencePart): PromptContentPart {
  switch (part.kind) {
    case 'text':
      return { type: 'text', text: part.text ?? '' }
    case 'image':
      // A failed image keeps its slot instead of being silently dropped (B20).
      return part.assetKey === undefined
        ? { type: 'text', text: `[image unavailable: ${part.partId}]` }
        : { type: 'image', assetKey: part.assetKey, partId: part.partId, referenceId: part.referenceId }
    case 'table':
      return { type: 'table', text: part.text ?? '', partId: part.partId, referenceId: part.referenceId }
    default: {
      const exhaustive: never = part.kind
      throw new Error(`unhandled browser reference part kind: ${String(exhaustive)}`)
    }
  }
}

function plainTextBlock(text: string): readonly PromptContentPart[] {
  return text === '' ? [] : [{ type: 'text', text }]
}

/** Project ordered groups (and existing attachments) into a stable, ordered array. */
export function projectOrderedContent(
  input: SubmissionInput,
  options: OrderedProjectionOptions = {},
): readonly PromptContentPart[] {
  const parts: PromptContentPart[] = [...input.uploaded]
  const text = plainTextBlock(input.text)
  if (options.textPosition === 'leading') parts.push(...text)
  for (const group of input.groups) {
    for (const part of group.parts) parts.push(projectPart(part))
  }
  if (options.textPosition !== 'leading') parts.push(...text)
  return parts
}

/**
 * Default compatibility mode: exact reproduction of the current composer shape.
 * Ordered groups are ignored here; with the feature disabled `groups` is empty,
 * so this is byte-identical to the existing `[...uploaded, ...text]` behavior.
 */
export function projectCompatibilityContent(input: SubmissionInput): readonly PromptContentPart[] {
  return [...input.uploaded, ...plainTextBlock(input.text)]
}

export type SubmissionMode = 'compatibility' | 'ordered'

/** Injected projector: the host owns the switch, not change any source file. */
export interface SubmissionProjector {
  readonly mode: SubmissionMode
  project(input: SubmissionInput): readonly PromptContentPart[]
}

export interface SubmissionProjectorOptions {
  readonly mode?: SubmissionMode
  readonly textPosition?: TextPosition
}

/** Build the projector the host will inject into its submission path. */
export function createSubmissionProjector(options: SubmissionProjectorOptions = {}): SubmissionProjector {
  const mode: SubmissionMode = options.mode ?? 'compatibility'
  const textPosition = options.textPosition
  const orderedOptions: OrderedProjectionOptions = textPosition === undefined ? {} : { textPosition }
  return {
    mode,
    project: input => mode === 'ordered'
      ? projectOrderedContent(input, orderedOptions)
      : projectCompatibilityContent(input),
  }
}
