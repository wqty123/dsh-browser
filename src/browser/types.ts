/**
 * Vocabulary for the browser capability seam (`ctx.browser`). One seam owns
 * provider registration, session lifecycle, cancellation, errors, and product
 * configuration; providers differ only in what backs a session (an Electron
 * `WebContentsView` in the desktop shell, a headless Chromium relay for
 * remote deployments, and so on).
 * @module dsh-browser/browser/types
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/**
 * Stable identity of one browser session, resolved by the Host through a
 * Typert `LookupMap` to the live session object (the same mechanism
 * `Agent → agentId` uses). The id is opaque to the wire; only the provider
 * and its host binding can interpret it.
 */
export type BrowserSessionId = string

/**
 * What one browser-capable backend is asked to do. Navigation is the minimal
 * operation every provider shares; the seam deliberately keeps the request
 * minimal so a provider swap never changes how the model asks.
 */
export interface BrowserNavigateRequest {
  /**
   * The URL to open. Admission (HTTP(S) only) is provider-owned; the seam
   * itself does not police credentials or private/localhost targets — a
   * shared real browser legitimately reaches local dev servers.
   */
  readonly url: string
}

/**
 * Click at viewport coordinates. Coordinates are viewport-relative pixels in
 * the session's own coordinate space — the same space the human interacts
 * with, so a real view and a relay agree without scaling.
 */
export interface BrowserClickRequest {
  /** Viewport-relative x in CSS pixels. */
  readonly x: number
  /** Viewport-relative y in CSS pixels. */
  readonly y: number
}

/** Type text into the focused element. */
export interface BrowserTypeRequest {
  /** The text to insert. */
  readonly text: string
}

/** Scroll the page: by pixel deltas, to an element, or to top/bottom. */
export interface BrowserScrollRequest {
  /** Horizontal delta in CSS pixels. */
  readonly deltaX?: number
  /** Vertical delta in CSS pixels. */
  readonly deltaY?: number
  /** Scroll the given selector's element into view (top document; same-origin iframes reachable via execute). */
  readonly selector?: string
  /** Scroll to the top of the page. */
  readonly toTop?: boolean
  /** Scroll to the bottom of the page. */
  readonly toBottom?: boolean
}

/** Press one named key (Enter, Tab, arrows, …). */
export interface BrowserKeyRequest {
  /** Key name from the supported set (see the browser_key tool). */
  readonly key: string
}

/**
 * How to find one element for a targeted interaction (form controls, clicks,
 * typing). `text` matches an element's own visible text — exact first, then
 * contains, deepest element preferred (so a button inside a card wins over
 * the card itself).
 */
export interface BrowserElementTarget {
  /** Locator kind. */
  readonly by: 'css' | 'text' | 'xpath'
  /** The CSS selector / visible text / XPath expression. */
  readonly value: string
  /** 0-based index of the match to use. Default 0. */
  readonly index?: number
}

/** Set the value of one input/textarea/select/contenteditable. */
export interface BrowserSetValueRequest {
  /** The element to set (css/text/xpath). */
  readonly target: BrowserElementTarget
  /** The value to set (string, number, or boolean). */
  readonly value: string | number | boolean
  /** Element-lookup budget in ms. Default 5000. */
  readonly timeoutMs?: number
}

/** Result of a single setValue. */
export interface BrowserSetValueResult {
  /** How the value was applied: input | textarea | select | contenteditable. */
  readonly method: string
  /** The value as applied. */
  readonly value: string
}

/** Check/uncheck one checkbox or radio. */
export interface BrowserCheckRequest {
  /** The element to toggle (css/text/xpath). */
  readonly target: BrowserElementTarget
  /** Desired state. Default true (check). */
  readonly checked?: boolean
  /** Element-lookup budget in ms. Default 5000. */
  readonly timeoutMs?: number
}

/** Select one option of a `<select>`, by value, visible text, or index. */
export interface BrowserSelectRequest {
  /** The `<select>` element (css/text/xpath). */
  readonly target: BrowserElementTarget
  /** Match the option by its value attribute. */
  readonly optionValue?: string
  /** Match the option by its visible text. */
  readonly optionText?: string
  /** Match the option by its 0-based index. */
  readonly optionIndex?: number
  /** Element-lookup budget in ms. Default 5000. */
  readonly timeoutMs?: number
}

/** Result of a single select. */
export interface BrowserSelectResult {
  /** The selected option's value attribute. */
  readonly value: string
  /** The selected option's visible text. */
  readonly text: string
}

/** Clear one input/textarea/contenteditable (or uncheck a checkbox/radio). */
export interface BrowserClearRequest {
  /** The element to clear (css/text/xpath). */
  readonly target: BrowserElementTarget
  /** Element-lookup budget in ms. Default 5000. */
  readonly timeoutMs?: number
}

/** Read one element's current value (for verification). */
export interface BrowserGetValueRequest {
  /** The element to read (css/text/xpath). */
  readonly target: BrowserElementTarget
  /** Element-lookup budget in ms. Default 5000. */
  readonly timeoutMs?: number
}

/** Result of a getValue. */
export interface BrowserGetValueResult {
  /** The element's value; null when the element has none (e.g. a checkbox). */
  readonly value: string | null
  /** For checkbox/radio: the checked state. */
  readonly checked?: boolean
  /** For `<select>`: the selected option's visible text. */
  readonly selectedText?: string
}

/** One field of a scrape: a name plus a selector (optionally `selector@attr`). */
export interface BrowserScrapeField {
  /** Output key. */
  readonly name: string
  /**
   * CSS selector relative to each item; append `@attr` to take an attribute
   * instead of text (`a@href` returns an absolute URL for links).
   */
  readonly selector: string
}

/** Extract structured data from repeated DOM items (static, CSP-safe). */
export interface BrowserScrapeRequest {
  /** Required: CSS selector of each result container (e.g. `div.card`). */
  readonly item: string
  /** Field map: name -> selector[@attr]. */
  readonly fields: readonly BrowserScrapeField[]
  /** Wait budget for the item selector to appear. Default 5000. */
  readonly timeoutMs?: number
}

/** Structured extraction result. */
export interface BrowserScrapeResult {
  /** Number of items extracted. */
  readonly count: number
  /** One object per item; missing fields are null. */
  readonly items: readonly Record<string, string | null>[]
}

/** One field of a batch form fill. Match by selector, or by name/label/placeholder. */
export interface BrowserFillField {
  /** CSS selector; when present, candidates are scoped to it. */
  readonly selector?: string
  /** Match by the field's `name` attribute. */
  readonly name?: string
  /** Match by associated `<label>` text or `aria-label`. */
  readonly label?: string
  /** Match by `placeholder` text. */
  readonly placeholder?: string
  /** Field kind; defaults to text. */
  readonly kind?: 'text' | 'textarea' | 'checkbox' | 'radio' | 'select'
  /** Value to set: string, number, or boolean (checkbox/radio). For a
   *  multi-select or radio group, the option value (or visible text). */
  readonly value: string | number | boolean
}

/** Batch form fill: set several fields, optionally submitting the form. */
export interface BrowserFillRequest {
  /** The fields to fill, in order. */
  readonly fields: readonly BrowserFillField[]
  /** Submit the containing form after filling. Default false. */
  readonly submit?: boolean
  /** Per-field evaluation budget in ms. Default 30000. */
  readonly timeoutMs?: number
}

/** One field's outcome in a batch fill. */
export interface BrowserFillFieldResult {
  readonly ok: boolean
  /** The field description matched (selector/name/label/placeholder). */
  readonly target: string
  /** How the value was applied: input | textarea | select | checkbox | radio | contenteditable. */
  readonly method?: string
  /** Error text when the field could not be filled. */
  readonly error?: string
}

/** Outcome of a batch form fill. */
export interface BrowserFillResult {
  /** Per-field outcomes, in request order. */
  readonly fields: readonly BrowserFillFieldResult[]
  /** Whether the containing form was submitted. */
  readonly submitted: boolean
}

/** Wait request: poll until the page is ready (and optional URL/selector). */
export interface BrowserWaitRequest {
  /** Maximum wait in ms. Default 30000. */
  readonly timeoutMs?: number
  /**
   * Optional URL the top document must show (exact or prefix match). Pass the
   * URL you navigated to — this distinguishes the NEW document from the old
   * one still on screen while navigation is in flight.
   */
  readonly url?: string
  /** Optional CSS selector that must exist (top document or same-origin frames). */
  readonly selector?: string
  /** Wait for the page load (readyState complete). Default true. */
  readonly loaded?: boolean
}

/** Outcome of a wait: whether the condition was met before the budget ran out. */
export interface BrowserWaitResult {
  readonly ready: boolean
  /** Why the wait ended: 'condition met' or a short explanation of the miss. */
  readonly reason: string
}

/**
 * A screenshot of the current page state. `dataUrl` is a base64 data URL the
 * tool layer renders directly; the live view itself never crosses the wire
 * (the human watches the real view in the desktop shape).
 */
export interface BrowserScreenshotResult {
  /** Base64 data URL of the capture (PNG or JPEG per the request). */
  readonly dataUrl: string
  /** File path the capture was also saved to, when the request asked for it. */
  readonly path?: string
}

/** Screenshot capture options. */
export interface BrowserScreenshotRequest {
  /** Capture the full scrollable page instead of the viewport. Default false. */
  readonly fullPage?: boolean
  /** Absolute file path to also save the image to (for vision-tool reads). */
  readonly savePath?: string
  /**
   * Image format. Default 'png'. JPEG is only available on the self-hosted
   * native capture path; the desktop-shell CDP fallback always returns PNG
   * (CDP JPEG hangs on Electron 43 — a documented platform defect).
   */
  readonly format?: 'png' | 'jpeg'
  /** JPEG quality 1-100 (default 80); ignored for PNG. */
  readonly quality?: number
  /** Downscale to fit within this width (aspect preserved). */
  readonly maxWidth?: number
  /** Downscale to fit within this height (aspect preserved). */
  readonly maxHeight?: number
}

/** Download options: fetch a URL into a local file, keeping the session's cookies. */
export interface BrowserDownloadRequest {
  /** The URL to download. */
  readonly url: string
  /** Absolute path of the file to write. */
  readonly savePath: string
}

/** A serializable cookie, exported from or imported into the browser session. */
export interface ExportedCookie {
  /** Cookie URL (scheme + domain + path), as accepted by cookies.set. */
  readonly url: string
  readonly name: string
  readonly value: string
  readonly domain?: string
  readonly path?: string
  readonly secure?: boolean
  readonly httpOnly?: boolean
  readonly expirationDate?: number
}

/**
 * Execute arbitrary JavaScript in the session's page context. This is the
 * primary interaction path — DOM-referenced, not screen-coordinate-based:
 * focus/input/click go through the page's own JS (native setters for
 * framework-controlled inputs), matching how a human-driven agent operates.
 */
export interface BrowserExecuteRequest {
  /** The JavaScript expression to evaluate in the page context. */
  readonly script: string
  /** Optional arguments injected into the script scope as `arguments[0..n]`. */
  readonly args?: readonly unknown[]
  /** Evaluation budget in ms; a wedged page rejects with a timeout. Default 30000. */
  readonly timeoutMs?: number
}

/**
 * Result of an execute. Mirrors CDP `Runtime.evaluate` semantics: either a
 * value (by value, not by reference) or the exception thrown.
 */
export type BrowserExecuteResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly exception: string }

/**
 * One interactive element in a snapshot, with a stable reference number the
 * tool layer (and the model) can cite to target the element.
 */
export interface BrowserSnapshotElement {
  /** 1-based reference number, stable for the lifetime of one snapshot. */
  readonly ref: number
  /** Element kind: 'input' | 'button' | 'link' | 'textarea' | 'select' | 'checkbox' | 'other'. */
  readonly kind: string
  /** Text content or placeholder/label, truncated for the snapshot. */
  readonly label: string
  /** Best-effort CSS selector; may be empty when none is derivable. */
  readonly selector: string
  /** Viewport-relative center, for coordinate fallbacks. */
  readonly x: number
  readonly y: number
  /**
   * True when the element lives inside an (same-origin) iframe: coordinates
   * are still top-document, but DOM selectors are frame-scoped — reach the
   * element via `iframe.contentDocument` in browser_execute.
   */
  readonly frame?: boolean
}

/**
 * AI-friendly page snapshot: a compact, numbered inventory of interactive
 * elements plus page facts. Not raw HTML — the model dialogues with this.
 */
export interface BrowserSnapshotResult {
  /** Final page URL. */
  readonly url: string
  /** Page title, if any. */
  readonly title?: string
  /** Numbered interactive elements. */
  readonly elements: readonly BrowserSnapshotElement[]
  /** True when the snapshot was truncated (element cap reached). */
  readonly truncated: boolean
  /** Human-verification challenge blocking the page, when one is detected. */
  readonly challenge?: BrowserChallenge
}

/**
 * One node of the accessibility tree, with a stable reference number the
 * model can cite. Roles/names prefer Chrome's `computedRole`/`computedName`
 * with tag/attribute inference as fallback; coordinates are top-document
 * viewport-relative so the node can also be driven by click/type.
 */
export interface BrowserA11yNode {
  /** 1-based reference number, stable for the lifetime of one a11y call. */
  readonly ref: number
  /** ARIA role: button | link | textbox | checkbox | radio | combobox | … */
  readonly role: string
  /** Accessible name (aria-label, label text, placeholder, own text, …). */
  readonly name: string
  /** Current value of input-like nodes (null when not applicable). */
  readonly value: string | null
  /** ARIA/DOM states: enabled/disabled/checked/unchecked/expanded/… */
  readonly states: readonly string[]
  /** DOM depth (within its document), for reconstructing the tree. */
  readonly depth: number
  /** Element tag name (lowercase). */
  readonly tag: string
  /** Viewport-relative center, for coordinate fallbacks. */
  readonly x: number
  readonly y: number
  /** True when the node lives inside a same-origin iframe. */
  readonly frame?: boolean
}

/** A11y tree request: what to include and how many nodes to return. */
export interface BrowserA11yRequest {
  /** Include hidden elements (display:none, hidden, aria-hidden). Default false. */
  readonly includeHidden?: boolean
  /** Maximum nodes returned. Default 500; clamped to 10-5000. */
  readonly maxNodes?: number
}

/** The page's accessibility tree, flattened into a numbered node list. */
export interface BrowserA11yResult {
  /** Final page URL. */
  readonly url: string
  /** Page title, if any. */
  readonly title?: string
  /** Number of nodes returned. */
  readonly count: number
  /** Flattened a11y nodes (depth restores the tree). */
  readonly nodes: readonly BrowserA11yNode[]
  /** True when the result was truncated (maxNodes reached). */
  readonly truncated: boolean
}

/**
 * A detected human-verification (bot-detection / CAPTCHA) challenge blocking
 * the page. Detection is best-effort and marker-based; a clean result is not a
 * guarantee that no challenge exists.
 */
export interface BrowserChallenge {
  /** Whether a challenge currently blocks the page. */
  readonly blocked: boolean
  /** Machine-readable kind: cloudflare | hcaptcha | recaptcha | turnstile | generic. */
  readonly kind?: string
  /** Short human-readable description, e.g. 'Cloudflare "Just a moment" interstitial'. */
  readonly reason?: string
}

/**
 * Content fetch formats. `html` is the raw DOM; `markdown` is a structured
 * reading view; `txt` is plain text (smallest); `json` is structured data.
 */
export type BrowserContentFormat = 'html' | 'markdown' | 'txt' | 'json'

/** Content fetch request: format, optional selector scoping, and caps. */
export interface BrowserContentRequest {
  /** Desired format. */
  readonly format: BrowserContentFormat
  /** Optional CSS selector limiting the fetch to one region (e.g. `#main`). */
  readonly selector?: string
  /** Maximum characters of the returned content. */
  readonly maxChars?: number
  /** Evaluation timeout in ms; the fetch aborts after this. Default 30000. */
  readonly timeoutMs?: number
}

/** A fetched page content in the requested format. */
export interface BrowserContentResult {
  /** The content in the requested format, capped at `maxChars`. */
  readonly content: string
  /** True when the content was truncated. */
  readonly truncated: boolean
}

/**
 * A tab inside a browser session. Tabs share the session's profile/cookies
 * and are switchable without losing state.
 */
export interface BrowserTab {
  /** Stable tab id within the session. */
  readonly id: string
  /** Current URL, or empty for a blank tab. */
  readonly url: string
  /** Page title, if any. */
  readonly title?: string
  /** Whether this tab is the active one. */
  readonly active: boolean
}

/** Request to open a URL: into the active tab or a new tab. */
export interface BrowserOpenRequest {
  /** The URL to open. */
  readonly url: string
  /** Open in a new tab (parallel). Default false (reuse the active tab). */
  readonly newTab?: boolean
}

/**
 * A browser-capable backend. Registered with `ctx.browser.registerBrowserProvider`.
 * `id` is a stable string, unique across the seam.
 */
export interface BrowserProvider {
  readonly id: string
  /** Cheap local usability check; must not make network calls. */
  available(): boolean
  /**
   * Open a new session. The provider mints the session id and prepares its
   * backing surface (a view, a headless page, and so on). Sessions are isolated from
   * each other; a session must not be visible to any other session's caller.
   * @param label - optional human-readable label (e.g. the calling DSH task
   * id) the provider may surface on the visible surface (window title) so a
   * human can tell which task's page is currently shown.
   */
  open(label?: string): Promise<BrowserSessionId>
  /** Open a URL, optionally in a new tab. Honor `signal` for cancellation. */
  openUrl(session: BrowserSessionId, request: BrowserOpenRequest, signal?: AbortSignal): Promise<void>
  /** List the session's tabs. */
  listTabs(session: BrowserSessionId): Promise<readonly BrowserTab[]>
  /** Switch to a tab by id. Unknown id -> `BROWSER_TAB_UNKNOWN`. */
  switchTab(session: BrowserSessionId, tabId: string): Promise<void>
  /** Close one tab. Closing the active tab activates the next. */
  closeTab(session: BrowserSessionId, tabId: string): Promise<void>
  /** Close every tab and reset the session's state. */
  reset(session: BrowserSessionId): Promise<void>
  /** Navigate the active tab. Honor `signal` for cancellation. */
  navigate(session: BrowserSessionId, request: BrowserNavigateRequest, signal?: AbortSignal): Promise<void>
  /** Execute JS in the active tab's page context. */
  execute(session: BrowserSessionId, request: BrowserExecuteRequest, signal?: AbortSignal): Promise<BrowserExecuteResult>
  /** Wait until the page is ready (and optional URL/selector match). Honor `signal` for cancellation. */
  waitFor(session: BrowserSessionId, request: BrowserWaitRequest, signal?: AbortSignal): Promise<BrowserWaitResult>
  /** Produce an AI-friendly snapshot of the active tab. */
  snapshot(session: BrowserSessionId, signal?: AbortSignal): Promise<BrowserSnapshotResult>
  /** Read the active tab's accessibility tree (semantic, interactive nodes). */
  a11y(session: BrowserSessionId, request: BrowserA11yRequest, signal?: AbortSignal): Promise<BrowserA11yResult>
  /** Reload the active tab. Honor `signal` for cancellation. */
  reload(session: BrowserSessionId, signal?: AbortSignal): Promise<void>
  /** Check whether a human-verification challenge is blocking the active tab. */
  detectChallenge(session: BrowserSessionId, signal?: AbortSignal): Promise<BrowserChallenge>
  /** Fetch page content in a requested format. */
  content(session: BrowserSessionId, request: BrowserContentRequest, signal?: AbortSignal): Promise<BrowserContentResult>
  /**
   * Click at viewport coordinates, or at a located element's center when the
   * request carries a `target`. Honor `signal` for cancellation.
   */
  click(session: BrowserSessionId, request: BrowserClickRequest | { readonly target: BrowserElementTarget }, signal?: AbortSignal): Promise<void>
  /**
   * Type into the focused element, or focus a located element first when the
   * request carries a `target`. Honor `signal` for cancellation.
   */
  type(session: BrowserSessionId, request: BrowserTypeRequest | { readonly target: BrowserElementTarget }, signal?: AbortSignal): Promise<void>
  /** Set one element's value (native setter + input/change events). */
  setValue(session: BrowserSessionId, request: BrowserSetValueRequest, signal?: AbortSignal): Promise<BrowserSetValueResult>
  /** Check or uncheck one checkbox/radio. */
  check(session: BrowserSessionId, request: BrowserCheckRequest, signal?: AbortSignal): Promise<{ readonly checked: boolean }>
  /** Select one option of a `<select>`. */
  selectOption(session: BrowserSessionId, request: BrowserSelectRequest, signal?: AbortSignal): Promise<BrowserSelectResult>
  /** Clear one input/textarea/contenteditable (or uncheck). */
  clearField(session: BrowserSessionId, request: BrowserClearRequest, signal?: AbortSignal): Promise<{ readonly cleared: boolean }>
  /** Read one element's current value (for verification). */
  getValue(session: BrowserSessionId, request: BrowserGetValueRequest, signal?: AbortSignal): Promise<BrowserGetValueResult>
  /** Extract structured data from repeated DOM items (static CSS, CSP-safe). */
  scrape(session: BrowserSessionId, request: BrowserScrapeRequest, signal?: AbortSignal): Promise<BrowserScrapeResult>
  /** Scroll the active tab. Honor `signal` for cancellation. */
  scroll(session: BrowserSessionId, request: BrowserScrollRequest, signal?: AbortSignal): Promise<void>
  /** Go back in the active tab's history. Honor `signal` for cancellation. */
  back(session: BrowserSessionId, signal?: AbortSignal): Promise<void>
  /** Go forward in the active tab's history. Honor `signal` for cancellation. */
  forward(session: BrowserSessionId, signal?: AbortSignal): Promise<void>
  /** Press one named key (Enter/Tab/arrows/…). Honor `signal` for cancellation. */
  key(session: BrowserSessionId, request: BrowserKeyRequest, signal?: AbortSignal): Promise<void>
  /** Fill a form's fields in one batch. Honor `signal` for cancellation. */
  fillForm(session: BrowserSessionId, request: BrowserFillRequest, signal?: AbortSignal): Promise<BrowserFillResult>
  /** Capture the current page. Honor `signal` for cancellation. */
  screenshot(session: BrowserSessionId, request?: BrowserScreenshotRequest, signal?: AbortSignal): Promise<BrowserScreenshotResult>
  /** Download a URL to a local file. Honor `signal` for cancellation. */
  download(session: BrowserSessionId, request: BrowserDownloadRequest, signal?: AbortSignal): Promise<{ readonly path: string }>
  /** Export the session's cookies (login state). */
  flushAuth(session: BrowserSessionId): Promise<readonly ExportedCookie[]>
  /** Import cookies into the session (restore login state). */
  restoreAuth(session: BrowserSessionId, cookies: readonly ExportedCookie[]): Promise<number>
  /** Return the session's chronological operation log. */
  history(session: BrowserSessionId): Promise<readonly BrowserHistoryEntry[]>
  /** Replay one recorded operation by sequence number. */
  replay(session: BrowserSessionId, seq: number): Promise<void>
  /** Close the session and destroy its backing surface. Idempotent. */
  close(session: BrowserSessionId): Promise<void>
}

/** One recorded browser operation, in chronological order (seq 1, 2, 3…). */
export interface BrowserHistoryEntry {
  /** Monotonic sequence number within the session. */
  readonly seq: number
  /** The operation name. Replayable: navigate | execute | click | type.
   *  Also recorded (non-replayable): fill | download | flushAuth | restoreAuth. */
  readonly action: string
  /** The operation's arguments. */
  readonly params: Record<string, unknown>
  /** Whether the operation succeeded. */
  readonly ok: boolean
  /** Truncated result text, when the operation returned one. */
  readonly result?: string
  /** Error text, when the operation failed. */
  readonly error?: string
  /** Epoch millis of the operation. */
  readonly at: number
}

/**
 * Typed browser error with a machine-routable, open-string `code` and chained
 * `cause`. Consumers must tolerate provider-specific codes. Shared codes cover
 * unavailable, missing, unusable, ambiguous, or duplicate providers, unknown
 * or closed sessions, cancellation, and provider failure; a provider adds its
 * own (e.g. `BROWSER_CDP_ATTACH_FAILED`).
 */
export class BrowserError extends HarnessError {}

