/**
 * Visible-region snapshots and image-version verification.
 *
 * The design (§8.1/§8.2, B33/B57/B58/B12) asks for three things the plain
 * capture path cannot do:
 *   - record viewport / scroll / zoom / DPR before a screenshot;
 *   - mask the unselected parts of a multi-column or discontinuous selection
 *     instead of saving one big bounding box containing neighbouring content;
 *   - prove that bytes downloaded from a URL are the version the page had
 *     loaded, so a re-download that returns a newer asset is not advertised
 *     as the source image the human selected.
 *
 * Everything that comes back from the page is untrusted input: shapes are
 * validated field by field and every number is clamped. A probe that cannot be
 * collected is reported as `unverifiable`, never as `verified`.
 * @module dsh-browser/browser-reference/visible
 */

/** Hard caps: a page can claim neither an unbounded selection nor an unbounded clip. */
export const MAX_VISIBLE_RECTS = 48
export const MAX_REGION_EDGE = 8_192
export const MAX_FACT_STRING = 4_000

export const MASK_HOST_ID = '__dsh-ref-visible-mask'
export const OVERLAY_HOST_ID = '__dsh-ref-overlay'
export const HIGHLIGHT_HOST_ID = '__dsh-ref-highlight'

/** One selected client rectangle, in CSS pixels relative to the viewport. */
export interface VisibleRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Page facts sampled immediately before a visible-region screenshot. */
export interface ScreenshotFacts {
  readonly url: string
  readonly title: string
  readonly frameUrl: string
  readonly frameRoute: 'main' | 'frame'
  readonly dpr: number
  readonly scrollX: number
  readonly scrollY: number
  readonly viewportWidth: number
  readonly viewportHeight: number
  readonly visualScale: number
  readonly rects: readonly VisibleRect[]
  readonly multipleRanges: boolean
}

/** CDP `Page.captureScreenshot` clip, in document CSS pixels. */
export interface VisibleClip {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly scale: 1
}

/** What the host needs to describe the saved region honestly. */
export interface VisibleCaptureMeta {
  readonly clip: VisibleClip
  readonly rects: number
  readonly partiallyVisible: boolean
  readonly dpr: number
  readonly visualScale: number
  readonly viewport: { readonly width: number; readonly height: number }
  readonly scroll: { readonly x: number; readonly y: number }
}

/** Page-side result of hashing the bytes the page session can still reach. */
export interface VersionProbe {
  readonly ok: boolean
  readonly length?: number
  readonly digest?: string
  readonly reason?: string
}

export type VersionStatus = 'verified' | 'changed' | 'unverifiable'

/** What a host must return for one visible-region screenshot. */
export interface VisibleCaptureResult {
  readonly dataUrl: string
  readonly mime: string
}

/** Wrap a one-shot page expression the same way the capture scripts are wrapped. */
function pageEval(body: string): string {
  return '(function (spec) { try { ' + body + ' } catch (error) { '
    + 'return JSON.stringify({ ok: false, reason: "script-error: " + String(error) }) '
    + '} })(arguments[0] || {})'
}

/** Both halves of the checksum must agree; the implementation is shared verbatim. */
export function probeDigest(bytes: Uint8Array | Buffer): string {
  let a = 2_166_136_261
  let b = 16_777_619
  for (let i = 0; i < bytes.length; i += 1) {
    a = Math.imul(a ^ bytes[i], 16_777_619) >>> 0
    b = Math.imul(b ^ bytes[i], 2_246_822_519) >>> 0
  }
  return `${a.toString(16)}-${b.toString(16)}-${String(bytes.length)}`
}

/**
 * Sample the facts a screenshot must be judged by. `getClientRects()` is what
 * makes multi-column and discontinuous selections visible: one bounding box
 * would silently include the text between two columns.
 */
export function visibleFactsScript(): string {
  const body = [
    'var selection = window.getSelection ? window.getSelection() : null',
    'var rects = []',
    'if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {',
    '  for (var i = 0; i < selection.rangeCount && rects.length < 48; i += 1) {',
    '    var range = selection.getRangeAt(i)',
    '    var list = range.getClientRects ? range.getClientRects() : []',
    '    for (var j = 0; j < list.length && rects.length < 48; j += 1) {',
    '      var r = list[j]',
    '      if (!(r.width >= 1) || !(r.height >= 1)) continue',
    '      rects.push({ x: r.left, y: r.top, width: r.width, height: r.height })',
    '    }',
    '    if (list.length === 0) {',
    '      var box = range.getBoundingClientRect()',
    '      if (box.width >= 1 && box.height >= 1) rects.push({ x: box.left, y: box.top, width: box.width, height: box.height })',
    '    }',
    '  }',
    '}',
    'var vv = window.visualViewport',
    'var frameRoute = "main"',
    'try { if (window.top !== window) frameRoute = "frame" } catch (error) { frameRoute = "frame" }',
    'return JSON.stringify({ ok: true, probe: "dsh-visible-facts",',
    '  url: String(location.href), title: String(document.title || ""),',
    '  frameUrl: String(location.href), frameRoute: frameRoute,',
    '  dpr: Number(window.devicePixelRatio || 1),',
    '  scrollX: Number(window.scrollX || window.pageXOffset || 0),',
    '  scrollY: Number(window.scrollY || window.pageYOffset || 0),',
    '  viewportWidth: Number(window.innerWidth || 0), viewportHeight: Number(window.innerHeight || 0),',
    '  visualScale: Number(vv && vv.scale ? vv.scale : 1),',
    '  rects: rects, multipleRanges: selection ? selection.rangeCount > 1 : false })',
  ].join('\n')
  return pageEval(body)
}

/**
 * Ask the page session for a digest of the bytes it can still reach at `url`.
 * A plain `fetch` in the page keeps the page's cookies and partitioning; when
 * it is blocked (cross origin, login, signed URL) the result is honest
 * `ok: false` rather than a guess. The digest is not a cryptographic proof —
 * it is a same-session version check, which is exactly what B33/B57 need.
 */
export function versionProbeScript(): string {
  const body = [
    'function dshFnv(bytes) {',
    '  var a = 2166136261, b = 16777619',
    '  for (var i = 0; i < bytes.length; i += 1) {',
    '    a = Math.imul(a ^ bytes[i], 16777619) >>> 0',
    '    b = Math.imul(b ^ bytes[i], 2246822519) >>> 0',
    '  }',
    '  return a.toString(16) + "-" + b.toString(16) + "-" + String(bytes.length)',
    '}',
    'var url = String(spec.url || "")',
    'if (!/^https?:\\/\\//i.test(url)) return JSON.stringify({ ok: false, reason: "unsupported-url" })',
    'return fetch(url, { credentials: "include", cache: "no-store" })',
    '  .then(function (response) {',
    '    if (!response.ok) return { ok: false, reason: "http-" + String(response.status) }',
    '    return response.arrayBuffer().then(function (buffer) {',
    '      var bytes = new Uint8Array(buffer)',
    '      return { ok: true, length: bytes.length, digest: dshFnv(bytes) }',
    '    })',
    '  })',
    '  .then(function (result) { return JSON.stringify(result) })',
    '  .catch(function () { return JSON.stringify({ ok: false, reason: "page-fetch-unavailable" }) })',
  ].join('\n')
  return pageEval(body)
}

/**
 * Cover everything outside the selected rectangles, and hide our own UI so it
 * cannot be baked into the reference image. The mask is a single SVG stacked
 * over the viewport: a white mask rect (visible shade) with black holes
 * (transparent) punched out for every selected client rect. That keeps
 * multi-column selections free of the neighbouring column without any image
 * library, and works for partially visible targets too.
 */
export function maskScript(): string {
  const body = [
    'var ns = "http://www.w3.org/2000/svg"',
    'var existing = document.getElementById("' + MASK_HOST_ID + '")',
    'if (existing && existing.parentNode) existing.parentNode.removeChild(existing)',
    'var hidden = []',
    'var ids = ["' + OVERLAY_HOST_ID + '", "' + HIGHLIGHT_HOST_ID + '"]',
    'for (var k = 0; k < ids.length; k += 1) {',
    '  var node = document.getElementById(ids[k])',
    '  if (node) { hidden.push({ node: node, display: node.style.display }); node.style.display = "none" }',
    '}',
    'window.__dshRefMaskHidden = hidden',
    'var width = Math.max(1, Number(spec.viewportWidth) || Number(window.innerWidth) || 1)',
    'var height = Math.max(1, Number(spec.viewportHeight) || Number(window.innerHeight) || 1)',
    'var host = document.createElement("div")',
    'host.id = "' + MASK_HOST_ID + '"',
    'host.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:2147483646;pointer-events:none"',
    'var svg = document.createElementNS(ns, "svg")',
    'svg.setAttribute("width", "100%")',
    'svg.setAttribute("height", "100%")',
    'svg.setAttribute("viewBox", "0 0 " + width + " " + height)',
    'svg.setAttribute("preserveAspectRatio", "none")',
    'var defs = document.createElementNS(ns, "defs")',
    'var mask = document.createElementNS(ns, "mask")',
    'mask.setAttribute("id", "__dsh_ref_mask")',
    'var white = document.createElementNS(ns, "rect")',
    'white.setAttribute("x", "0"); white.setAttribute("y", "0")',
    'white.setAttribute("width", String(width)); white.setAttribute("height", String(height))',
    'white.setAttribute("fill", "white")',
    'mask.appendChild(white)',
    'for (var i = 0; i < spec.rects.length; i += 1) {',
    '  var r = spec.rects[i]',
    '  var hole = document.createElementNS(ns, "rect")',
    '  hole.setAttribute("x", String(r.x)); hole.setAttribute("y", String(r.y))',
    '  hole.setAttribute("width", String(r.width)); hole.setAttribute("height", String(r.height))',
    '  hole.setAttribute("fill", "black")',
    '  mask.appendChild(hole)',
    '}',
    'defs.appendChild(mask); svg.appendChild(defs)',
    'var shade = document.createElementNS(ns, "rect")',
    'shade.setAttribute("x", "0"); shade.setAttribute("y", "0")',
    'shade.setAttribute("width", String(width)); shade.setAttribute("height", String(height))',
    'shade.setAttribute("fill", "#0b0d12")',
    'shade.setAttribute("fill-opacity", "0.94")',
    'shade.setAttribute("mask", "url(#__dsh_ref_mask)")',
    'svg.appendChild(shade); host.appendChild(svg)',
    'document.body.appendChild(host)',
    'return JSON.stringify({ ok: true, rects: spec.rects.length, hidden: hidden.length })',
  ].join('\n')
  return pageEval(body)
}

/** Remove the mask and restore whatever UI it hid, even after a failed capture. */
export function unmaskScript(): string {
  const body = [
    'var host = document.getElementById("' + MASK_HOST_ID + '")',
    'if (host && host.parentNode) host.parentNode.removeChild(host)',
    'var hidden = window.__dshRefMaskHidden || []',
    'for (var i = 0; i < hidden.length; i += 1) {',
    '  try { hidden[i].node.style.display = hidden[i].display } catch (error) { /* node went away */ }',
    '}',
    'window.__dshRefMaskHidden = []',
    'return JSON.stringify({ ok: true, removed: host ? 1 : 0, restored: hidden.length })',
  ].join('\n')
  return pageEval(body)
}

function finiteOf(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function rectOf(value: unknown): VisibleRect | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Record<string, unknown>
  const x = finiteOf(row.x, 0, -MAX_REGION_EDGE, MAX_REGION_EDGE)
  const y = finiteOf(row.y, 0, -MAX_REGION_EDGE, MAX_REGION_EDGE)
  const width = finiteOf(row.width, 0, 0, MAX_REGION_EDGE)
  const height = finiteOf(row.height, 0, 0, MAX_REGION_EDGE)
  if (width < 1 || height < 1) return undefined
  return { x, y, width, height }
}

/** Validate the untrusted page facts. Anything missing makes the sample unusable. */
export function validateVisibleFacts(value: unknown): ScreenshotFacts | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Record<string, unknown>
  if (row.ok !== true || row.probe !== 'dsh-visible-facts') return undefined
  const url = typeof row.url === 'string' ? row.url.slice(0, MAX_FACT_STRING) : ''
  if (url === '') return undefined
  const viewportWidth = finiteOf(row.viewportWidth, 0, 0, MAX_REGION_EDGE)
  const viewportHeight = finiteOf(row.viewportHeight, 0, 0, MAX_REGION_EDGE)
  if (viewportWidth < 1 || viewportHeight < 1) return undefined
  const rawRects = Array.isArray(row.rects) ? row.rects.slice(0, MAX_VISIBLE_RECTS) : []
  const rects: VisibleRect[] = []
  for (const item of rawRects) {
    const rect = rectOf(item)
    if (rect !== undefined) rects.push(rect)
  }
  if (rects.length === 0) return undefined
  const frameUrl = typeof row.frameUrl === 'string' ? row.frameUrl.slice(0, MAX_FACT_STRING) : url
  return {
    url,
    title: typeof row.title === 'string' ? row.title.slice(0, 500) : '',
    frameUrl,
    frameRoute: row.frameRoute === 'frame' ? 'frame' : 'main',
    dpr: finiteOf(row.dpr, 1, 0.25, 8),
    // A long page can be scrolled far past MAX_REGION_EDGE*8 (65 536px);
    // clamping the scroll offset mis-translates client rects into document
    // coordinates and the clip lands in the wrong place. Keep the value finite
    // but allow a realistically long document (all other caps stay in force).
    scrollX: finiteOf(row.scrollX, 0, -1e7, 1e7),
    scrollY: finiteOf(row.scrollY, 0, -1e7, 1e7),
    viewportWidth,
    viewportHeight,
    visualScale: finiteOf(row.visualScale, 1, 0.25, 8),
    rects,
    multipleRanges: row.multipleRanges === true || rects.length > 1,
  }
}

/**
 * Turn viewport client rects into one CDP clip. The clip is intersected with
 * the viewport (a target only partly on screen keeps only its visible part),
 * then translated into document coordinates with the sampled scroll offset.
 * The mask, not the clip, is what excludes the unselected neighbouring content.
 */
export function clipFromFacts(facts: ScreenshotFacts): { clip: VisibleClip; meta: VisibleCaptureMeta } | undefined {
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  let partiallyVisible = false
  for (const rect of facts.rects) {
    const x1 = Math.max(0, rect.x)
    const y1 = Math.max(0, rect.y)
    const x2 = Math.min(facts.viewportWidth, rect.x + rect.width)
    const y2 = Math.min(facts.viewportHeight, rect.y + rect.height)
    if (x2 <= x1 || y2 <= y1) continue
    if (x1 > rect.x || y1 > rect.y || x2 < rect.x + rect.width || y2 < rect.y + rect.height) partiallyVisible = true
    left = Math.min(left, x1)
    top = Math.min(top, y1)
    right = Math.max(right, x2)
    bottom = Math.max(bottom, y2)
  }
  if (!Number.isFinite(left) || right <= left || bottom <= top) return undefined
  const width = Math.min(MAX_REGION_EDGE, right - left)
  const height = Math.min(MAX_REGION_EDGE, bottom - top)
  if (width < 1 || height < 1) return undefined
  const clip: VisibleClip = {
    x: Math.round((left + facts.scrollX) * 100) / 100,
    y: Math.round((top + facts.scrollY) * 100) / 100,
    width: Math.round(width * 100) / 100,
    height: Math.round(height * 100) / 100,
    scale: 1,
  }
  return {
    clip,
    meta: {
      clip,
      rects: facts.rects.length,
      partiallyVisible: partiallyVisible || facts.rects.length > 1,
      dpr: facts.dpr,
      visualScale: facts.visualScale,
      viewport: { width: facts.viewportWidth, height: facts.viewportHeight },
      scroll: { x: facts.scrollX, y: facts.scrollY },
    },
  }
}

/** Compare the page session's digest with the bytes the host actually saved. */
export function compareImageVersion(probe: unknown, bytes: Buffer): VersionStatus {
  if (typeof probe !== 'object' || probe === null) return 'unverifiable'
  const row = probe as Record<string, unknown>
  if (row.ok !== true || typeof row.digest !== 'string' || typeof row.length !== 'number') return 'unverifiable'
  if (!Number.isFinite(row.length) || row.length < 0) return 'unverifiable'
  const digest = probeDigest(bytes)
  if (row.length !== bytes.length || row.digest !== digest) return 'changed'
  return 'verified'
}
