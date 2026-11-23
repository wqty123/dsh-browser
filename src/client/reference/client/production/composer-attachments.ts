import type { ComposerImage } from './production-submission.ts'

/** The part of the host conversation service that turns files into composer attachments. */
interface DraftAttachmentService {
  createDrafts(sessionId: string, files: readonly File[], uploadImages: boolean): readonly { readonly id: string }[]
  releaseDraftAttachments?(attachments: readonly { readonly id: string }[]): void
}

interface AttachmentContext {
  get(name: string): unknown
}

interface AttachmentActions {
  addAttachments?(ids: readonly string[]): boolean
}

/**
 * Put captured images into the composer attachments through the host's own drop path
 * (`conversation.createDrafts` + `inputActions.addAttachments`), so the send serializes them
 * ahead of the text exactly like a pasted image.
 */
export function attachImages(
  ctx: AttachmentContext,
  sessionId: string,
  images: readonly ComposerImage[],
  actions: AttachmentActions,
): boolean {
  const conversation = ctx.get('conversation') as Partial<DraftAttachmentService> | undefined
  if (typeof conversation?.createDrafts !== 'function' || typeof actions.addAttachments !== 'function') return false
  const files = images.map(({ partId, binding }) => {
    const bytes = Uint8Array.from(atob(binding.data), char => char.charCodeAt(0))
    const extension = binding.mime.split('/')[1]?.replace(/[^a-z0-9]/giu, '') || 'bin'
    return new File([bytes], `${partId}.${extension}`, { type: binding.mime })
  })
  const binding = (ctx.get('sessions') as { binding?(id: string): { session?: { getSnapshot?(): { subagent?: unknown } } } | undefined } | undefined)
    ?.binding?.(sessionId)
  const uploadImages = (binding?.session?.getSnapshot?.().subagent ?? null) === null
  const drafts = conversation.createDrafts(sessionId, files, uploadImages)
  if (actions.addAttachments(drafts.map(draft => draft.id))) return true
  conversation.releaseDraftAttachments?.(drafts)
  return false
}
