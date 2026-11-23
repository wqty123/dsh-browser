/**
 * Annotated screenshots: numbered boxes over the interactive elements in the viewport, drawn into
 * the page just for the capture and removed right after it. The same numbers come back as
 * `{ id, x, y, role, label }` rows, with x/y the element's centre in viewport CSS pixels, the
 * coordinates click({x, y}) takes. Elements inside open shadow roots and same-origin iframes are
 * included; cross-origin frames stay opaque.
 * @module dsh-browser/tool-browser/screenshot-annotations
 */
import type { Context } from '@deepseek-ai/cordis'
import type { BrowserSessionId } from '../browser/types.ts'
import { DEEP_DOM_SOURCE } from '../browser/deep-dom.ts'

/** One numbered element on an annotated screenshot. */
export interface ScreenshotAnnotation {
  readonly id: number
  readonly x: number
  readonly y: number
  readonly role: string
  readonly label: string
}

const OVERLAY_ID = '__dsh_annotations__'
export const MAX_ANNOTATIONS = 80

/** Page script: draw the overlay and return the rows. Resolves after the overlay has painted. */
export const ANNOTATE_SCRIPT = `(async () => {${DEEP_DOM_SOURCE}
  const OVERLAY_ID = ${JSON.stringify(OVERLAY_ID)}
  const old = document.getElementById(OVERLAY_ID)
  if (old) old.remove()
  const SELECTOR = 'a[href], button, input:not([type=hidden]), textarea, select, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=option], [role=switch], [role=combobox], [role=searchbox], [role=textbox], [contenteditable=""], [contenteditable=true], [tabindex]:not([tabindex="-1"])'
  const implicit = (el) => {
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return 'link'
    if (tag === 'button' || tag === 'summary') return 'button'
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      if (type === 'checkbox' || type === 'radio') return type
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button'
      if (type === 'range') return 'slider'
      if (type === 'search') return 'searchbox'
      return 'textbox'
    }
    if (el.isContentEditable) return 'textbox'
    return 'generic'
  }
  const labelOf = (el) => {
    const root = el.getRootNode()
    const byIds = (el.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean)
      .map(id => { const n = root.getElementById ? root.getElementById(id) : null; return n ? n.textContent : '' }).join(' ')
    let text = el.getAttribute('aria-label') || byIds
    if (!text && el.labels && el.labels.length) text = el.labels[0].textContent
    // A field's value is what the user typed (possibly a password), never its label; only button inputs name themselves by value.
    const buttonValue = el.tagName === 'INPUT' && /^(submit|button|reset)$/i.test(el.getAttribute('type') || '') ? el.value : ''
    if (!text) text = el.innerText || buttonValue || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || ''
    return String(text).replace(/\\s+/g, ' ').trim().slice(0, 80)
  }
  const vw = window.innerWidth, vh = window.innerHeight
  // The element's box in top-viewport coordinates, clipped by every enclosing iframe's viewport.
  const visibleBox = (el) => {
    const r = el.getBoundingClientRect()
    let box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
    let doc = el.ownerDocument
    while (doc && doc.defaultView && doc.defaultView.frameElement) {
      const view = doc.defaultView
      box = { left: Math.max(box.left, 0), top: Math.max(box.top, 0), right: Math.min(box.right, view.innerWidth), bottom: Math.min(box.bottom, view.innerHeight) }
      const f = view.frameElement.getBoundingClientRect()
      box = { left: box.left + f.left, top: box.top + f.top, right: box.right + f.left, bottom: box.bottom + f.top }
      doc = view.frameElement.ownerDocument
    }
    return { left: Math.max(box.left, 0), top: Math.max(box.top, 0), right: Math.min(box.right, vw), bottom: Math.min(box.bottom, vh) }
  }
  const rows = []
  const boxes = []
  for (const root of __dshRoots()) {
    for (const el of root.querySelectorAll(SELECTOR)) {
      if (rows.length >= ${MAX_ANNOTATIONS}) break
      if (el.disabled) continue
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) continue
      const style = el.ownerDocument.defaultView.getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue
      const v = visibleBox(el)
      if (v.right - v.left < 2 || v.bottom - v.top < 2) continue
      const x = Math.round((v.left + v.right) / 2)
      const y = Math.round((v.top + v.bottom) / 2)
      const id = rows.length + 1
      rows.push({ id, x, y, role: el.getAttribute('role') || implicit(el), label: labelOf(el) })
      boxes.push({ id, left: v.left, top: v.top, width: v.right - v.left, height: v.bottom - v.top })
    }
  }
  const host = document.createElement('div')
  host.id = OVERLAY_ID
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;'
  const shadow = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : host
  const colors = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#008080', '#9a6324', '#800000']
  for (const b of boxes) {
    const color = colors[(b.id - 1) % colors.length]
    const box = document.createElement('div')
    box.style.cssText = 'position:fixed;box-sizing:border-box;border:2px solid ' + color + ';left:' + b.left + 'px;top:' + b.top + 'px;width:' + b.width + 'px;height:' + b.height + 'px;'
    const tag = document.createElement('span')
    tag.textContent = String(b.id)
    tag.style.cssText = 'position:absolute;left:-2px;top:' + (b.top >= 14 ? '-14px' : '0') + ';background:' + color + ';color:#fff;font:bold 11px/13px monospace;padding:0 3px;'
    box.appendChild(tag)
    shadow.appendChild(box)
  }
  ;(document.body || document.documentElement).appendChild(host)
  await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
  return rows
})()`

export const CLEAR_ANNOTATIONS_SCRIPT = `(() => { const el = document.getElementById(${JSON.stringify(OVERLAY_ID)}); if (el) el.remove(); return true })()`

type Browser = NonNullable<Context['browser']>

export async function drawAnnotations(browser: Browser, session: BrowserSessionId, signal?: AbortSignal): Promise<readonly ScreenshotAnnotation[]> {
  const result = await browser.execute(session, { script: ANNOTATE_SCRIPT }, signal)
  if (!result.ok) throw new Error(`browser: could not annotate the page (${result.exception})`)
  return Array.isArray(result.value) ? result.value as ScreenshotAnnotation[] : []
}

export async function clearAnnotations(browser: Browser, session: BrowserSessionId): Promise<void> {
  try { await browser.execute(session, { script: CLEAR_ANNOTATIONS_SCRIPT }) } catch { /* the page navigated away; nothing to clear */ }
}

/** Text lines naming each numbered element. */
export function annotationLines(rows: readonly ScreenshotAnnotation[]): string[] {
  return rows.map(row => `  [${row.id}] ${row.role}${row.label !== '' ? ` "${row.label}"` : ''} @ ${row.x},${row.y}`)
}
