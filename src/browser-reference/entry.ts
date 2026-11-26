/**
 * Human page entries and same-origin frame identity (design §3.1, §10.3,
 * §11.3; B02/B40/B46/B48/B32).
 *
 * Two different adapters must never own the same page's entry: only ONE
 * overlay is installed per document, and an already-installed overlay is a
 * no-op. The overlay is a *low-trust* entry: it reports an intent with
 * `entry: 'page-overlay'` and never claims `activeTab`, screenshot or any
 * other capability. `isTrusted` is recorded for diagnostics, never used as an
 * authorisation credential.
 *
 * Frame identity is decided by the host from the selector it was asked to
 * inspect; the page cannot invent a `frameRoute` that the service will trust.
 * @module dsh-browser/browser-reference/entry
 */

import { HIGHLIGHT_HOST_ID, OVERLAY_HOST_ID } from './visible.ts'
import { captureEntrySource } from './page-script.ts'
import { MAX_REFERENCE_TEXT } from '../reference-text.ts'
export { MAX_REFERENCE_TEXT } from '../reference-text.ts'

/**
 * The bound the service and the page bar share. The bar trims an over-long
 * paste before it crosses the intent channel; the service re-applies the same
 * bound because a page is low-trust.
 */
export const MAX_REFERENCE_COMMENT = 2000
export const REFERENCE_INTENT_CHANNEL = 'dsh-browser-ref:intent'
export const MAX_FRAME_SELECTOR = 200
export const MAX_FRAME_EVENTS = 24
export const MAX_FRAME_TEXT = MAX_REFERENCE_TEXT

/** One row of the single merged context menu. */
/** Which element a right-click action explicitly names. */
export type ReferenceTargetKind = 'text' | 'image' | 'table'

export interface ReferenceMenuItem {
  readonly id: string
  readonly label: string
  readonly kind: 'reference' | 'role' | 'separator'
  readonly role?: 'copy' | 'cut' | 'paste' | 'selectAll'
  /** Explicit target of this action; absent on the ordinary edit roles. */
  readonly target?: ReferenceTargetKind
}

/** What the browser's real context-menu event reported about the clicked node. */
export interface ReferenceMenuContext {
  readonly hasSelection?: boolean
  readonly mediaType?: string
}

/**
 * The browser's ordinary edit items are kept, with the reference actions added
 * by the SAME owner. One menu, one popup: two adapters each opening their own
 * menu was the failure mode the design calls out (§3.1:59).
 *
 * A right-click on an image or a selection inside a table gets its OWN action,
 * so "quote this image" never depends on the selection still covering the node
 * (§3.2/§3.3). Copy/cut/paste/select-all roles always stay in this one menu.
 */
export function referenceMenuTemplate(context: ReferenceMenuContext = {}): readonly ReferenceMenuItem[] {
  const actions: ReferenceMenuItem[] = [
    { id: 'dsh-browser-reference-text', label: '引用选中的文字', kind: 'reference', target: 'text' },
  ]
  if (context.mediaType === 'image') {
    actions.push({ id: 'dsh-browser-reference-image', label: '引用这张图片', kind: 'reference', target: 'image' })
  }
  if (context.hasSelection === true) {
    actions.push({ id: 'dsh-browser-reference-table', label: '引用选中的表格', kind: 'reference', target: 'table' })
  }
  return [
    ...actions,
    { id: 'dsh-browser-reference-separator', label: '', kind: 'separator' },
    { id: 'dsh-browser-copy', label: '复制', kind: 'role', role: 'copy' },
    { id: 'dsh-browser-cut', label: '剪切', kind: 'role', role: 'cut' },
    { id: 'dsh-browser-paste', label: '粘贴', kind: 'role', role: 'paste' },
    { id: 'dsh-browser-select-all', label: '全选', kind: 'role', role: 'selectAll' },
  ]
}

/** A CSS selector is accepted only if it is short and free of injection syntax. */
export function validateFrameSelector(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const selector = value.trim()
  if (selector === '' || selector.length > MAX_FRAME_SELECTOR) return undefined
  if (/[{}<>;`$\\]/.test(selector)) return undefined
  if (selector.includes('/*') || selector.includes('*/')) return undefined
  return selector
}

/** Wrap a one-shot or resident page expression in the same typed shell. */
function pageEval(body: string): string {
  return '(function (spec) { try { ' + body + ' } catch (error) { '
    + 'return JSON.stringify({ ok: false, reason: "script-error: " + String(error) }) '
    + '} })(arguments[0] || {})'
}

/**
 * Install the resident selection entry. Listeners survive the return value.
 * The saved Range is what keeps a `mousedown` on the button from collapsing
 * the selection before the capture runs (design §3.1:222).
 */
export function overlayScript(): string {
  const body = [
    // The carrier waits for a document identity handshake before it treats a guest as loaded
    // (IframePresentation.awaitIdentity posts `dsh.browser.guest.navigation.request`). This block
    // answers it, and announces on load so a fresh document is known without waiting for a request.
    // It sits BEFORE the "already installed" early return on purpose: a re-injected overlay still has
    // to answer, otherwise the carrier loses the document after a hot reload.
    // Everything here is defensive: this block runs before the overlay is built, and a page (or a
    // test double) without addEventListener must not stop the bar from being installed.
    'var guestDocumentId = window.__dshGuestDocumentId || (window.__dshGuestDocumentId = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2))',
    'var announceGuestIdentity = function (loadId) { try { if (window.parent && window.parent !== window) window.parent.postMessage({ type: "dsh.browser.guest.navigation", url: String(location.href), documentId: guestDocumentId, loadId: loadId }, "*") } catch (error) {} }',
    'try { window.addEventListener("message", function (event) { if (event.data && event.data.type === "dsh.browser.guest.navigation.request") announceGuestIdentity(event.data.loadId) }) } catch (error) {}',
    'try { if (document.readyState === "complete") announceGuestIdentity(); else window.addEventListener("load", function () { announceGuestIdentity() }) } catch (error) {}',
    'if (window.__dshRefOverlayInstalled) return JSON.stringify({ ok: true, already: true })',
    // The bar freezes the COMPLETE capture (ordered text runs, assets, table
    // ranges, anchors), not only its words. Installed once per document, in its
    // own function scope so the page library cannot shadow our locals.
    'if (typeof window.__dshRefCapture !== "function") { window.__dshRefCapture = ' + captureEntrySource() + ' }',
    'var bridge = null',
    'var channel = "postMessage"',
    'if (window.__dshRef && typeof window.__dshRef.intent === "function") { bridge = window.__dshRef; channel = "preload" }',
    'else if (window.bridge && typeof window.bridge.referenceIntent === "function") { bridge = window.bridge; channel = "bridge" }',
    // Three-state §3: a compact comment bar beside the selection, not a bare
    // button. The comment is optional; confirming with an empty box quotes the
    // selection unchanged.
    // One overlay per document. A second injection (hot reload, retry, two carriers) used to leave the
    // previous bar in the page with its old comment still typed in it — reported as "信息残留".
    'var stale = document.getElementById("' + OVERLAY_HOST_ID + '")',
    'if (stale && stale.parentNode) stale.parentNode.removeChild(stale)',
    'var host = document.createElement("div")',
    'host.id = "' + OVERLAY_HOST_ID + '"',
    'host.setAttribute("role", "group")',
    'host.setAttribute("aria-label", String(spec.label || "网页引用"))',
    // No fixed width: the bar starts as a short field and grows with the
    // comment, so it never covers a paragraph of the page it quotes.
    'host.style.cssText = "all:initial;position:fixed;z-index:2147483645;display:none;box-sizing:border-box;width:auto;min-width:0;max-width:min(360px,calc(100vw - 16px));background:#fff;color:#1a1a1a;border:0;border-radius:24px;corner-shape:round;padding:6px;font:400 13px/20px system-ui,sans-serif;box-shadow:0 0 0 .5px rgba(0,0,0,.14),0 6px 20px rgba(0,0,0,.18);pointer-events:auto"',
    'var preview = document.createElement("div")',
    // Keep the frozen excerpt available to the controller; the selected page
    // text itself remains the visible preview beside the compact comment bar.
    'preview.setAttribute("aria-hidden", "true")',
    'preview.style.cssText = "all:initial;display:none"',
    'var input = document.createElement("textarea")',
    'input.rows = 1',
    'input.maxLength = ' + MAX_REFERENCE_COMMENT,
    'input.setAttribute("aria-label", "添加评论（可选）")',
    'input.setAttribute("placeholder", "添加可选评论…")',
    // `field-sizing: content` is what makes "grow while typing, then wrap"
    // possible: the field follows its text until `max-width`, then the extra
    // text wraps and the bar gets taller instead of wider.
    'input.cols = 8',
    'input.style.cssText = "all:initial;display:block;flex:0 1 auto;min-width:96px;max-width:236px;min-height:28px;max-height:88px;box-sizing:border-box;resize:none;overflow-y:auto;overflow-x:hidden;overflow-wrap:anywhere;word-break:break-word;white-space:pre-wrap;background:transparent;color:#1a1a1a;border:0;border-radius:8px;padding:4px 8px;font:400 13px/20px system-ui,sans-serif;field-sizing:content"',
    'var confirm = document.createElement("button")',
    'confirm.setAttribute("type", "button")',
    'confirm.id = "' + OVERLAY_HOST_ID + '-add"',
    // The only thing that changed: the bare "✓" glyph became a stroked check in
    // inline SVG, so it inherits CanvasText and stays crisp at any zoom. The
    // button itself keeps the bar's own grey, DSH-style chrome.
    // A font glyph, not an inline SVG. Measured on a real page: the stroked SVG inside this button
    // painted nothing at all (a white disc with no mark), so the only visible state was "an empty
    // circle". A text glyph renders in every case and inherits colour normally.
    "confirm.textContent = '✓'",
    'confirm.setAttribute("aria-label", "引用所选内容")',
    'confirm.title = "引用所选内容"',
    // White circle, dark check, both forced: a page stylesheet used to win the `background` while the
    // mark stayed light, and the pair drifted apart. Inline `!important` outranks a page's own
    // `!important`, so the circle and the glyph can no longer disagree.
    'confirm.style.cssText = "all:initial;display:inline-flex!important;align-items:center!important;justify-content:center!important;flex:none;box-sizing:border-box;width:28px;height:28px;border-radius:50%;corner-shape:round;border:0!important;font:600 18px/1 system-ui,sans-serif;cursor:pointer"',
    // A compact status line: the failure reason (nothing selected), the note
    // length near its bound, and the post-add confirmation all land here.
    'var status = document.createElement("span")',
    'status.setAttribute("role", "status")',
    'status.setAttribute("aria-live", "polite")',
    'status.style.cssText = "all:initial;position:absolute;left:6px;right:6px;top:calc(100% + 6px);box-sizing:border-box;color:#1a1a1a;background:#fff;border-radius:8px;padding:6px 10px;font:400 12px/18px system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.16);overflow-wrap:anywhere"',
    'var footer = document.createElement("div")',
    'footer.style.cssText = "all:initial;display:contents"',
    'var entryStyle = document.createElement("style")',
    'entryStyle.textContent = "#' + OVERLAY_HOST_ID + ' span:empty{display:none!important}'
      + '#' + OVERLAY_HOST_ID + ' button:focus-visible{outline:2px solid Highlight;outline-offset:2px}'
      + '#' + OVERLAY_HOST_ID + '-add:disabled{cursor:default}'
      + '#' + OVERLAY_HOST_ID + ' textarea:focus-visible{outline:0}"',
    'host.appendChild(entryStyle)',
    'var row = document.createElement("div")',
    'row.style.cssText = "all:initial;display:flex;align-items:center;gap:6px"',
    'host.appendChild(preview)',
    'row.appendChild(input)',
    'footer.appendChild(confirm)',
    'footer.appendChild(status)',
    'row.appendChild(footer)',
    'host.appendChild(row)',
    'var savedRange = null',
    // The page selection is destroyed the moment the comment field takes focus,
    // so its text is frozen here and submitted with the intent; the host locates
    // it again from the frozen quote instead of re-reading a dead selection.
    'var frozenText = ""',
    // The COMPLETE capture frozen at the same moment: ordered text runs, image
    // sources and table ranges with their anchors. A text-only freeze loses
    // images/tables and lets a duplicate paragraph be re-located by wording.
    'var frozenCapture = null',
    'var dismissedText = ""',
    'function textField(node) {',
    '  if (!node || node.nodeType !== 1) return false',
    '  var tag = String(node.tagName || "").toUpperCase()',
    '  return tag === "TEXTAREA" || tag === "INPUT" || node.isContentEditable === true',
    '}',
    'function clip(text, max) {',
    '  var value = String(text || "").replace(/[ \\t\\r\\n]+/g, " ").trim()',
    '  return value.length > max ? value.slice(0, max) + "…" : value',
    '}',
    // One place decides what the bar says about the pending quote, so the
    // preview, the disabled state and the hint can never disagree.
    'function setQuote(text) {',
    '  var value = clip(text, 90)',
    '  preview.textContent = value === "" ? "" : "「" + value + "」"',
    '  preview.style.display = "none"',
    '  confirm.disabled = value === ""',
    '  confirm.style.opacity = value === "" ? "0.9" : "1"',
    '  status.textContent = value === "" ? "请先在网页上选中内容" : ""',
    '  status.style.color = value === "" ? "#b42318" : "GrayText"',
    '}',
    'function freeze() {',
    // Once focus is inside the bar, the page selection is already gone and the
    // bar's own selection (a Ctrl+A of the human's note) is what getSelection()
    // reports. The first freeze stays authoritative: rewriting it here is what
    // turned a page quote into the comment.
    '  if (document.activeElement && host.contains(document.activeElement)) return',
    '  var selection = window.getSelection ? window.getSelection() : null',
    '  var text = selection ? String(selection.toString()) : ""',
    '  if (text) { frozenText = text; setQuote(text) }',
    '  var range = currentRange()',
    '  if (range) savedRange = range',
    // Freeze once, before focus moves: clicking the comment field collapses the
    // page selection, so this is the last moment the real range exists.
    '  if (range && frozenCapture === null && typeof window.__dshRefCapture === "function") {',
    '    try { frozenCapture = window.__dshRefCapture({ context: 32 }) } catch (error) { frozenCapture = null }',
    '    if (frozenCapture && frozenCapture.ok !== true) frozenCapture = null',
    '  }',
    '}',
    // Which way round the page is painted. System colour keywords (`Canvas`,
    // `CanvasText`) read the OS preference, not the page, which is how a dark
    // article ended up with an invisible black-on-black comment field. The bar
    // now measures the page instead and paints explicitly.
    'function colorOf(value) {',
    '  var text = String(value || "")',
    '  var open = text.indexOf("(")',
    '  if (open < 0) return null',
    '  var parts = text.slice(open + 1, text.lastIndexOf(")")).split(/[ ,\\/]+/)',
    '  var numbers = []',
    '  for (var i = 0; i < parts.length; i += 1) { var n = parseFloat(parts[i]); if (!isNaN(n)) numbers.push(n) }',
    '  if (numbers.length < 3) return null',
    '  return { a: numbers.length > 3 ? numbers[3] : 1, r: numbers[0], g: numbers[1], b: numbers[2] }',
    '}',
    'function brightness(value) {',
    '  var color = colorOf(value)',
    '  if (!color || color.a === 0) return -1',
    '  return (0.299 * color.r + 0.587 * color.g + 0.114 * color.b) / 255',
    '}',
    'function pageIsDark(range) {',
    // A carrier without a full style engine must not lose the whole bar: an
    // unknown page is treated as light, which is still readable.
    '  try {',
    '    var node = range ? range.startContainer : null',
    '    var element = node && node.nodeType === 1 ? node : (node && node.parentElement ? node.parentElement : null)',
    '    while (element) {',
    '      var painted = brightness(getComputedStyle(element).backgroundColor)',
    '      if (painted >= 0) return painted < 0.5',
    '      element = element.parentElement',
    '    }',
    '    var bodyPainted = brightness(getComputedStyle(document.body).backgroundColor)',
    '    if (bodyPainted >= 0) return bodyPainted < 0.5',
    '    var rootPainted = brightness(getComputedStyle(document.documentElement).backgroundColor)',
    '    if (rootPainted >= 0) return rootPainted < 0.5',
    // A page that only sets `color` still says which way it thinks; read that.
    '    return brightness(getComputedStyle(document.body).color) > 0.5',
    '  } catch (error) { return false }',
    '}',
    'function paint(dark) {',
    '  var surface = dark ? "#1c1c1e" : "#ffffff"',
    '  var ink = dark ? "#f5f5f7" : "#1a1a1a"',
    '  host.style.background = surface',
    '  host.style.color = ink',
    '  host.style.boxShadow = dark',
    '    ? "0 0 0 .5px rgba(255,255,255,.16),0 6px 20px rgba(0,0,0,.45)"',
    '    : "0 0 0 .5px rgba(0,0,0,.14),0 6px 20px rgba(0,0,0,.18)"',
    '  input.style.color = ink',
    '  confirm.style.background = ink',
    '  confirm.style.color = surface',
    '  status.style.background = surface',
    '  status.style.color = ink',
    '}',
    'var painted = null',
    'function paintFor(range) {',
    '  var dark = pageIsDark(range)',
    '  if (painted === dark) return',
    '  painted = dark',
    '  paint(dark)',
    '}',
    'var listeners = []',
    'function listen(target, name, fn) {',
    // A carrier document without event support must not break installation: the
    // bar is an enhancement on top of a page we do not own.
    '  if (!target || typeof target.addEventListener !== "function") return',
    '  target.addEventListener(name, fn, true); listeners.push({ target: target, name: name, fn: fn })',
    '}',
    'function currentRange() {',
    '  var selection = window.getSelection ? window.getSelection() : null',
    '  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null',
    '  try { return selection.getRangeAt(0).cloneRange() } catch (error) { return null }',
    '}',
    // The bar belongs above the FIRST selected character, not above the bounding box of the whole
    // selection: a selection spanning several lines has a box that starts at the left margin, so the
    // bar used to hang over unrelated text. Measured in the sidebar and reported as "太丑了".
    'function firstCharBox(range) {',
    // 首选选区**第一行**的矩形：它就是「划线第一个字所在的那一行」，高只有一行。
    // 旧的实现先折叠再按一个单元扩一格，遇到跨块选区时 endContainer 是元素节点，
    // 扩一格会得到整块的高度，`place()` 据此认为「上方放不下」并把它压到面板最底部。
    '  var lines = range.getClientRects ? range.getClientRects() : null',
    '  if (lines && lines.length) return lines[0]',
    '  try {',
    '    var head = range.cloneRange()',
    '    head.collapse(true)',
    '    var unit = head.cloneRange()',
    '    if (unit.endContainer && unit.endContainer.nodeType === 3) {',
    '      var length = unit.endContainer.data.length',
    '      unit.setEnd(unit.endContainer, Math.min(unit.endOffset + 1, length))',
    '    } else if (unit.endContainer) {',
    '      unit.setEnd(unit.endContainer, Math.min(unit.endOffset + 1, unit.endContainer.childNodes.length || 1))',
    '    }',
    '    var box = unit.getBoundingClientRect()',
    '    if (box.width || box.height) return box',
    '  } catch (error) { /* fall back to the line rects below */ }',
    '  var rects = range.getClientRects ? range.getClientRects() : null',
    '  if (rects && rects.length) return rects[0]',
    '  return range.getBoundingClientRect()',
    '}',
    'function place(range) {',
    '  var box = firstCharBox(range)',
    '  var width = host.offsetWidth || 240',
    '  var height = host.offsetHeight || 76',
    '  var viewWidth = window.innerWidth || 1024',
    '  var viewHeight = window.innerHeight || 768',
    // A detached node or a zero-width anchor reports an empty box: placing the
    // bar from it parked the bar in the corner, looking like a stuck popup.
    '  if (!box.width && !box.height) { host.style.display = "none"; return }',
    // 选区当前必须有一行在视口里。整段选区可能已经滚出屏幕（第一行在下方几百像素），
    // 这时按它算出来的位置只会被夹到面板边缘，看起来就是「浮条卡在底部」——那种情况直接不显示。
    '  if (box.bottom < 0 || box.top > viewHeight) { host.style.display = "none"; return }',
    // Left-aligned with the first character, shifted back only when that would leave the viewport.
    '  var left = Math.max(8, Math.min(box.left, viewWidth - width - 8))',
    // Prefer above the selection so the quoted text stays readable, then below.
    '  var above = box.top - height - 10',
    '  var top = above >= 8 ? above : Math.min(box.bottom + 10, viewHeight - height - 8)',
    '  top = Math.max(8, Math.min(top, viewHeight - height - 8))',
    '  host.style.left = left + "px"; host.style.top = top + "px"',
    '}',
    // A settled selection is the right moment to take the complete snapshot:
    // keyboard selection (Shift+arrows, then Tab into the note) never fires a
    // mousedown, and without this its images and tables degraded to a wording
    // search. Debounced, because `selectionchange` fires during the drag.
    'var captureTimer = null',
    'function captureSoon() {',
    '  if (typeof window.__dshRefCapture !== "function") return',
    '  if (captureTimer !== null && typeof clearTimeout === "function") clearTimeout(captureTimer)',
    '  captureTimer = setTimeout(function () {',
    '    captureTimer = null',
    '    if (document.activeElement && host.contains(document.activeElement)) return',
    '    var range = currentRange()',
    '    if (!range) return',
    '    var text = String(window.getSelection ? window.getSelection() : "")',
    '    if (text === "" || text !== frozenText) return',
    '    try {',
    '      var snap = window.__dshRefCapture({ context: 32 })',
    '      if (snap && snap.ok === true) frozenCapture = snap',
    '    } catch (error) { /* the click path will try again */ }',
    '  }, 180)',
    '}',
    'function refresh() {',
    '  var range = currentRange()',
    // Hiding keeps the frozen capture: the same quote can be re-shown when the
    // selection is re-established, and a click may still need it.
    '  if (!range) { host.style.display = "none"; return }',
    '  var selection = window.getSelection()',
    '  if (dismissedText && String(selection.toString()) === dismissedText) { host.style.display = "none"; return }',
    '  savedRange = range',
    '  var live = String(selection || "")',
    '  if (live !== frozenText) {',
    // A different selection: the old snapshot no longer describes it.
    '    frozenText = live',
    '    frozenCapture = null',
    '    setQuote(live)',
    // The comment belongs to the selection it was written for. Carrying it into a new selection made the
    // bar look like it had remembered a message the reader already sent.
    '    input.value = ""',
    '    status.textContent = ""',
    '    confirm.style.opacity = "0.9"',
    '  }',
    '  if (frozenCapture === null) captureSoon()',
    '  paintFor(range)',
    // Re-attach when the page swapped its body out from under us; without this the bar was "shown" in
    // a detached tree and the reader saw nothing.
    '  if (!host.isConnected && !host.__dshAttached) { (document.documentElement || document.body).appendChild(host); host.__dshAttached = true }',
    '  host.style.display = "block"; place(range)',
    '}',
    // The selection must survive clicking or typing in the bar (§3: 点击或输入
    // 评论不会导致选区丢失).
    'listen(document, "mousedown", function (event) {',
    '  if (host.contains(event.target)) {',
    '    // Freeze BEFORE the focus move: clicking the textarea collapses the page',
    '    // selection, and the captured content must survive that.',
    '    freeze()',
    '    // A text field must keep its native default, otherwise it can never be',
    '    // focused or typed into (three-state §3).',
    '    if (textField(event.target)) return',
    '    event.preventDefault()',
    '    return',
    '  }',
    '  dismissedText = ""',
    '  freeze()',
    '})',
    'listen(document, "mouseup", function (event) { if (!host.contains(event.target)) setTimeout(refresh, 0) })',
    'listen(document, "selectionchange", function () { if (!host.contains(document.activeElement)) refresh() })',
    'listen(host, "scroll", function (event) { event.stopPropagation() })',
    // Scrolling is reading, not cancelling. Follow the quoted range while it is
    // still on screen; hide only once it has scrolled out of view.
    'listen(document, "scroll", function (event) {',
    '  if (host.contains(event.target)) return',
    '  if (host.style.display !== "block" || !savedRange) { host.style.display = "none"; return }',
    '  var box = savedRange.getBoundingClientRect()',
    '  var viewHeight = window.innerHeight || 768',
    '  if (box.bottom < 0 || box.top > viewHeight) { host.style.display = "none"; return }',
    '  place(savedRange)',
    '}, true)',
    'listen(window, "resize", function () { if (host.style.display === "block" && savedRange) place(savedRange) })',
    'listen(document, "keydown", function (event) {',
    // A dismissed quote was blocked until the next mousedown, so re-selecting
    // the same words with Shift+arrows (or Ctrl+A) never brought the bar back.
    // Any key that is not typed INSIDE the bar starts a fresh selection.
    '  if (event.key !== "Escape" && !host.contains(document.activeElement)) dismissedText = ""',
    '  if (event.key === "Escape") {',
    '    var selection = window.getSelection ? window.getSelection() : null',
    '    dismissedText = selection ? String(selection.toString()) : ""',
    '    input.value = ""',
    '    host.style.display = "none"',
    '  }',
    '})',
    // IME: a composition Enter must never confirm (§3 中文输入法组词过程不会误确认).
    'listen(input, "keydown", function (event) {',
    '  if (event.key !== "Enter") return',
    '  if (event.isComposing === true || event.keyCode === 229) return',
    '  if (event.ctrlKey || event.metaKey) { event.preventDefault(); event.stopPropagation(); submit(event) }',
    '})',
    // Never read the live selection here: the comment field can hold a Ctrl+A
    // selection of the human's own note, and that must never replace the page
    // quote. `frozenText` was captured before the field took focus.
    'function submit(event) {',
    '  var selectionText = frozenText',
    // Keyboard submission (Tab into the note, then Ctrl+Enter) never passes
    // through the bar's mousedown, so the rich capture was never taken and an
    // image/table quote degraded to a wording search. Capture now if the page
    // selection is still alive.
    '  if (frozenCapture === null && typeof window.__dshRefCapture === "function") {',
    // Only take it when the live selection is still the quoted text: capturing
    // a different range here would attach content the bar never showed.
    '    var live = window.getSelection ? String(window.getSelection()) : ""',
    '    if (selectionText === "" || live === selectionText) {',
    '      try { frozenCapture = window.__dshRefCapture({ context: 32 }) } catch (error) { frozenCapture = null }',
    '      if (frozenCapture && frozenCapture.ok !== true) frozenCapture = null',
    '    }',
    '  }',
    // Nothing frozen: the user clicked through a stale bar. Say why instead of
    // closing, which used to look like the click did nothing at all.
    '  if (selectionText === "" && frozenCapture === null) { setQuote(""); return }',
    '  var comment = String(input.value || "").trim()',
    '  if (comment.length > ' + MAX_REFERENCE_COMMENT + ') comment = comment.slice(0, ' + MAX_REFERENCE_COMMENT + ')',
    '  dismissedText = selectionText',
    '  var intent = {',
    '    type: "' + REFERENCE_INTENT_CHANNEL + '",',
    '    entry: "page-overlay", origin: "user-selection",',
    '    hasSelection: savedRange !== null || selectionText !== "",',
    '    selectionText: selectionText,',
    // The complete ordered snapshot taken while the real range still existed;
    // the host consumes it verbatim instead of searching the page by wording.
    '    capture: frozenCapture,',
    '    isTrusted: event ? event.isTrusted === true : false,',
    '    comment: comment,',
    '    frameSelector: null,',
    '    capabilities: []',
    '  }',
    '  if (bridge) { if (typeof bridge.intent === "function") bridge.intent(intent); else bridge.referenceIntent(intent) }',
    '  else {',
    '    window.postMessage(intent, "*")',
    // No preload bridge (the Desktop sidebar carrier): keep the intent where the',
    // host can collect it. The host polls __dshRefTake every tick.',
    '    var queue = window.__dshRefIntents || (window.__dshRefIntents = [])',
    '    queue.push(intent)',
    '  }',
    '  frozenText = ""',
    '  frozenCapture = null',
    '  input.value = ""',
    '  setQuote("")',
    '  preview.textContent = ""',
    '  preview.style.display = "none"',
    '  confirm.style.opacity = "0.9"',
    // Leave NOTHING behind: the bar closes the moment the intent is queued.
    // It used to stay for 1.2 s saying "已提交，正在加入…", and a throttled
    // timer in a background webContents could leave that strip pinned in a
    // corner for minutes — stray UI the user could not dismiss, describing a
    // selection that no longer existed.
    '  status.style.color = "GrayText"',
    '  status.textContent = ""',
    '  host.style.display = "none"',
    '}',
    'listen(confirm, "click", function (event) { event.preventDefault(); event.stopPropagation(); submit(event) })',
    // Only speak up when the note gets near the bound the host enforces; a
    // counter on every keystroke is noise.
    'listen(input, "input", function () {',
    '  if (document.activeElement !== input) return',
    '  var length = String(input.value || "").length',
    '  if (length > ' + MAX_REFERENCE_COMMENT * 0.8 + ') {',
    '    status.style.color = length > ' + MAX_REFERENCE_COMMENT + ' ? "#b42318" : "GrayText"',
    '    status.textContent = "评论 " + length + "/" + ' + MAX_REFERENCE_COMMENT + ' + " 字"',
    '  } else if (status.textContent && status.textContent.indexOf("评论 ") === 0) {',
    '    status.textContent = ""',
    '  }',
    // The bar is only as wide as its text now, so it has to be re-placed as it
    // grows: otherwise a comment typed at the right edge walks off screen.
    '  if (savedRange) setTimeout(function () { place(savedRange) }, 0)',
    '})',
    // Attach to the ROOT element, not to body: pages that replace <body> after load (SPA shells, some CMS
    // templates) silently detached the bar, so selecting real article text showed nothing at all —
    // measured on a CCTV article reached from 百度新闻 ("shown: none" while the same code worked on other
    // sites). A later re-attach guard in show() covers the remaining cases.
    ';(document.documentElement || document.body).appendChild(host)',
    // Collection point for the carrier without a preload bridge. Defined once,
    // so a re-injection over a live overlay cannot double-collect intents.',
    'window.__dshRefTake = function () {',
    '  var queue = window.__dshRefIntents',
    '  if (!queue || !queue.length) return null',
    '  return queue.shift()',
    '}',
    'window.__dshRefOverlayInstalled = true',
    'window.__dshRefOverlayDispose = function () {',
    '  if (captureTimer !== null && typeof clearTimeout === "function") clearTimeout(captureTimer)',
    '  for (var i = 0; i < listeners.length; i += 1) {',
    '    try { listeners[i].target.removeEventListener(listeners[i].name, listeners[i].fn, true) } catch (error) {}',
    '  }',
    '  if (host.parentNode) host.parentNode.removeChild(host)',
    '  var notice = typeof document.getElementById === "function" ? document.getElementById("__dsh-ref-notice") : null',
    '  if (notice && notice.parentNode) notice.parentNode.removeChild(notice)',
    '  window.__dshRefOverlayInstalled = false',
    '  window.__dshRefOverlayDispose = null',
    '  return listeners.length',
    '}',
    'return JSON.stringify({ ok: true, installed: true, channel: channel })',
  ].join('\n')
  return pageEval(body)
}

/**
 * Turn an arguments[0]-based page expression into a standalone expression that
 * Electron's executeJavaScript can run in the top-level main world, where
 * `arguments` does not exist. The CDP execute path keeps the original form.
 */
export function standaloneScript(script: string, spec: Record<string, unknown> = {}): string {
  return script.replace('(arguments[0] || {})', `(${JSON.stringify(spec)})`)
}

/** Remove the resident entry and all its listeners (idempotent, §11.3). */
export function overlayDisposeScript(): string {
  const body = [
    'if (typeof window.__dshRefOverlayDispose !== "function") return JSON.stringify({ ok: true, removed: 0 })',
    'var count = window.__dshRefOverlayDispose()',
    'return JSON.stringify({ ok: true, removed: count })',
  ].join('\n')
  return pageEval(body)
}

/** The untrusted shape a frame capture returns. */
export interface FrameCaptureResult {
  readonly ok: boolean
  readonly reason?: string
  readonly url?: string
  readonly frameUrl?: string
  readonly title?: string
  readonly frameSelector?: string
  readonly events?: readonly unknown[]
}

/**
 * Collect a same-origin iframe's selection, images and tables. The frame's URL
 * is read from the iframe element in the TOP document, never from a payload
 * field the frame could forge; cross-origin frames answer with an explicit
 * `frame-inaccessible` reason rather than a fabricated identity.
 */
export function frameCaptureScript(): string {
  const body = [
    'var selector = String(spec.frameSelector || "")',
    'var element = null',
    'try { element = document.querySelector(selector) } catch (error) { element = null }',
    'if (!element || String(element.tagName || "").toUpperCase() !== "IFRAME") {',
    '  return JSON.stringify({ ok: false, reason: "frame-not-found" })',
    '}',
    'var frameDoc = null',
    'try { frameDoc = element.contentDocument } catch (error) { frameDoc = null }',
    'if (!frameDoc) return JSON.stringify({ ok: false, reason: "frame-inaccessible" })',
    'var frameUrl = ""',
    'try { frameUrl = String(element.contentWindow.location.href) } catch (error) {',
    '  frameUrl = String(element.getAttribute("src") || "")',
    '}',
    'if (!frameUrl) frameUrl = String(element.getAttribute("src") || "")',
    'var result = (function (document, window, location) {',
    '  return (' + captureEntrySource() + ')(spec)',
    '})(frameDoc, element.contentWindow, { href: frameUrl })',
    'result.url = String(location.href)',
    'result.frameUrl = frameUrl',
    'result.frameSelector = selector',
    'return JSON.stringify(result)',
  ].join('\n')
  return pageEval(body)
}

/** Validate a frame result field by field; the page cannot self-report identity. */
export function validateFrameCapture(value: unknown, requestedSelector: string): FrameCaptureResult | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Record<string, unknown>
  if (row.ok !== true) return { ok: false, reason: typeof row.reason === 'string' ? row.reason.slice(0, 100) : 'frame-unavailable' }
  if (typeof row.url !== 'string' || typeof row.frameUrl !== 'string') return undefined
  const events = Array.isArray(row.events) ? row.events.slice(0, MAX_FRAME_EVENTS) : []
  return {
    ok: true,
    url: row.url.slice(0, 4_000),
    frameUrl: row.frameUrl.slice(0, 4_000),
    title: typeof row.title === 'string' ? row.title.slice(0, 500) : '',
    // Identity always comes from the host's request, not the page payload.
    frameSelector: requestedSelector,
    events,
  }
}

/** Hide any of our own UI before a screenshot; used by the overlay owner. */
export const OVERLAY_IDS = [OVERLAY_HOST_ID, HIGHLIGHT_HOST_ID] as const
