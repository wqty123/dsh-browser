/** Assemble iframe navigation and presentation without platform branches in consumers. */
import type { BrowserPage, BrowserPageOptions } from './browser/BrowserPage.ts'
import { IframeImpl } from './browser/IframeImpl.ts'
import { IframePresentation } from './view/IframePresentation.ts'
import { captureReferenceIntent } from './reference-intents.ts'

/**
 * Assemble an idle iframe provider and its DOM presentation.
 * @param options - saved navigation and callbacks.
 * @returns the Web page's navigation and presentation objects.
 */
export function createIframePage(options: BrowserPageOptions, sessionId?: string,
  capture: (intent: object, owner?: string) => Promise<void> = (intent, owner) => captureReferenceIntent(intent, owner ?? '')): BrowserPage {
  const presentation = new IframePresentation({
    loaded: (revision) => { frame.handleLoaded(revision) },
    observed: (revision, observedUrl) => { frame.handleObserved(revision, observedUrl) },
    reference: (intent: object) => capture(intent, sessionId),
    guestReady: (revision, pageId) => { frame.handleGuestReady(revision, pageId) },
    guestPending: () => { frame.handleGuestPending() },
    failed: (revision) => { frame.handleLoadFailed(revision) },
    remounted: () => { frame.reload() },
  }, sessionId)
  const frame = new IframeImpl(options, presentation)
  return { frame, presentation }
}
