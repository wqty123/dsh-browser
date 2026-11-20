/** Assemble iframe navigation and presentation without platform branches in consumers. */
import type { BrowserPage, BrowserPageOptions } from './browser/BrowserPage.ts'
import { IframeImpl } from './browser/IframeImpl.ts'
import { IframePresentation } from './view/IframePresentation.ts'

/**
 * Assemble an idle iframe provider and its DOM presentation.
 * @param options - saved navigation and callbacks.
 * @returns the Web page's navigation and presentation objects.
 */
export function createIframePage(options: BrowserPageOptions): BrowserPage {
  const presentation = new IframePresentation({
    loaded: (revision, observedUrl) => { frame.handleLoaded(revision, observedUrl) },
    failed: (revision) => { frame.handleLoadFailed(revision) },
    remounted: () => { frame.reload() },
    // The proxied guest needs to know which conversation it is quoting into; this panel owns one.
    sessionId: () => (options as { readonly sessionId?: string }).sessionId ?? '',
  })
  const frame = new IframeImpl(options, presentation)
  return { frame, presentation }
}
