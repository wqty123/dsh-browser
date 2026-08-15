/**
 * Vocabulary for the browser capability seam (`ctx.browser`). One seam owns
 * provider registration, session lifecycle, cancellation, errors, and product
 * configuration; providers differ only in what backs a session (an Electron
 * `WebContentsView` in the desktop shell, a headless Chromium relay for
 * remote deployments, and so on).
 * @module dsh-browser/browser/types
 */
import { HarnessError } from '@deepseek-ai/dsh-llm';
/**
 * Typed browser error with a machine-routable, open-string `code` and chained
 * `cause`. Consumers must tolerate provider-specific codes. Shared codes cover
 * unavailable, missing, unusable, ambiguous, or duplicate providers, unknown
 * or closed sessions, cancellation, and provider failure; a provider adds its
 * own (e.g. `BROWSER_CDP_ATTACH_FAILED`).
 */
export class BrowserError extends HarnessError {
}
