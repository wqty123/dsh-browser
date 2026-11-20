/**
 * Page-side scripts for browser references: read the current selection as ordered
 * parts, rebuild the page's visible text map for a text-quote locate, draw a
 * non-interactive highlight, and rasterise one image element when its source
 * cannot be fetched.
 *
 * WHY ONE LIBRARY OF STRINGS
 * Every script travels through the same `execute` path every carrier already
 * has, so no carrier needs a new CDP method. The page half is untrusted: it
 * returns data, never code, and the host validates every field before a
 * reference is stored. Keeping the DOM helpers in one string means capture and
 * reveal agree on what "visible text" means — a map built differently in the two
 * places would make every anchor miss.
 *
 * Capture and reveal share a text map with semantic block/line separators.
 * Only actual text nodes carry DOM offsets; separators occupy map offsets.
 * Hidden subtrees, script,
 * style, template and the plugin's own highlight overlay are excluded.
 * @module dsh-browser/browser-reference/page-script
 */

import type { ReferenceTextNode } from '../reference-text.ts'

/** Options the capture script accepts as its single argument. */
export interface CaptureScriptOptions {
  /** Characters of context kept on each side of a selected run. */
  readonly context?: number
  /** Text-map character budget; anything past it is reported as truncated. */
  readonly maxChars?: number
  /** Most table cells captured per table. */
  readonly maxCells?: number
  /** Capture this table whole even when it is not part of the selection. */
  readonly tableSelector?: string
  /**
   * Agent excerpt: with no live selection, register the first occurrence of this
   * text instead. Two occurrences make the result ambiguous and are refused.
   */
  readonly excerptText?: string
}

/** One raw reference part as the page produced it, before host validation. */
export interface RawCaptureEvent {
  readonly kind?: string
  readonly exact?: string
  readonly content?: readonly ReferenceTextNode[]
  readonly prefix?: string
  readonly suffix?: string
  readonly src?: string
  readonly currentSrc?: string
  readonly attributeSrc?: string
  readonly alt?: string
  readonly caption?: string
  readonly selector?: string
  readonly path?: readonly number[]
  readonly svg?: boolean
  readonly canvas?: boolean
  /** Canvas pixels captured in the page; validated and hashed host-side. */
  readonly dataUrl?: string
  readonly width?: number
  readonly height?: number
  readonly geometry?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
  readonly table?: RawTable
}

/** Raw table snapshot; cell shapes are validated host-side. */
export interface RawTable {
  readonly rowCount?: number
  readonly columnCount?: number
  readonly caption?: string
  readonly completeness?: string
  readonly truncated?: boolean
  readonly cells?: readonly RawCell[]
}

/** Raw cell snapshot, including inline runs. */
export interface RawCell {
  readonly row?: number
  readonly column?: number
  readonly rowSpan?: number
  readonly columnSpan?: number
  readonly role?: string
  readonly text?: string
  readonly includedAs?: string
  readonly partialText?: boolean
  readonly inlineContent?: readonly RawCellRun[]
}

/** One inline run inside a cell: text, or an image the host will materialise. */
export interface RawCellRun {
  readonly type?: string
  readonly text?: string
  readonly src?: string
  readonly currentSrc?: string
  readonly alt?: string
}

/** Capture result. A refusal is a status, not an exception. */
export interface RawCaptureResult {
  readonly ok: boolean
  readonly reason?: string
  readonly url?: string
  readonly frameUrl?: string
  readonly title?: string
  readonly multipleRanges?: boolean
  readonly truncated?: boolean
  readonly ambiguousExcerpt?: boolean
  readonly events?: readonly RawCaptureEvent[]
}

/** Page text map: what a text-quote locate searches. */
export interface RawPageTextResult {
  readonly ok: boolean
  readonly reason?: string
  readonly url?: string
  readonly title?: string
  readonly text?: string
  readonly truncated?: boolean
}

/** Result of drawing a highlight. */
export interface RawHighlightResult {
  readonly ok: boolean
  readonly reason?: string
  readonly rects?: number
  readonly scrolled?: boolean
}

/** Result of locating one element (image or table) and highlighting it. */
export interface RawElementRevealResult {
  readonly ok: boolean
  readonly status?: string
  readonly reason?: string
  readonly matches?: number
  readonly described?: string
  readonly rects?: number
  readonly scrolled?: boolean
}

/** Result of rasterising one image element in the page. */
export interface RawRasterResult {
  readonly ok: boolean
  readonly reason?: string
  readonly dataUrl?: string
  readonly width?: number
  readonly height?: number
}

/**
 * DOM helpers shared by every script below.
 *
 * No backticks and no `${` inside: the whole block is embedded in a template
 * literal. `String.raw` keeps the regex escapes intact.
 */
const PAGE_LIB = String.raw`
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, TEXTAREA: 1 }
  var HIGHLIGHT_ID = '__dsh-ref-highlight'
  var visibilityCache = typeof WeakMap === 'function' ? new WeakMap() : null

  function pageBody() { return document.body || document.documentElement }

  function collapse(value, limit) {
    var text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
    return limit && text.length > limit ? text.slice(0, limit) : text
  }

  function elementHidden(el) {
    if (!el || el.nodeType !== 1) return false
    try {
      if (el.hidden === true) return true
      var style = window.getComputedStyle ? window.getComputedStyle(el) : null
      if (!style) return false
      if (style.display === 'none') return true
      if (style.opacity === '0' && el.getClientRects && el.getClientRects().length === 0) return true
      if (style.display !== 'contents' && el.getBoundingClientRect) {
        var box = el.getBoundingClientRect()
        if (box.width === 0 && box.height === 0 && style.position !== 'fixed') return true
      }
    } catch (error) { return false }
    return false
  }

  function visibleNode(node) {
    var el = node.nodeType === 1 ? node : node.parentElement
    var seen = []
    var verdict = true
    while (el && el !== document.documentElement) {
      if (visibilityCache) {
        var cached = visibilityCache.get(el)
        if (cached === false) { verdict = false; break }
        if (cached === true) break
      }
      if (elementHidden(el)) {
        if (visibilityCache) visibilityCache.set(el, false)
        verdict = false
        break
      }
      seen.push(el)
      el = el.parentElement
    }
    if (verdict && visibilityCache) {
      for (var i = 0; i < seen.length; i++) visibilityCache.set(seen[i], true)
    }
    return verdict
  }

  function textVisible(node) {
    var parent = node.parentElement
    if (!parent) return false
    try {
      var style = window.getComputedStyle ? window.getComputedStyle(parent) : null
      if (style && (style.visibility === 'hidden' || style.visibility === 'collapse')) return false
    } catch (error) { /* no style engine: fall through to the ancestor walk */ }
    return visibleNode(parent)
  }

  function skippedText(node) {
    var el = node.parentElement
    var depth = 0
    while (el && depth < 64) {
      if (SKIP_TAGS[el.tagName] || el.id === HIGHLIGHT_ID) return true
      el = el.parentElement
      depth += 1
    }
    return false
  }

  function flatTextMap(maxChars, structured, legacy) {
    var body = pageBody()
    var out = { text: '', nodes: [], content: [], truncated: false }
    if (!body || typeof document.createTreeWalker !== 'function') return out
    var limit = maxChars && maxChars > 0 ? maxChars : 2000000
    function append(value) {
      var room = Math.max(0, limit - out.text.length)
      if (value.length > room) out.truncated = true
      out.text += value.slice(0, room)
    }
    function boundary(value) {
      if (legacy || !out.text) return
      var overlap = 0
      for (var i = 1; i <= value.length; i++) if (out.text.endsWith(value.slice(0, i))) overlap = i
      append(value.slice(overlap))
    }
    function visit(node, depth) {
      if (out.truncated) return []
      if (depth > 64) { out.truncated = true; return [] }
      if (node.nodeType === 3) {
        var value = node.nodeValue || ''
        if (!value || skippedText(node) || !textVisible(node)) return []
        var start = out.text.length
        append(value)
        var end = out.text.length
        if (end === start) return []
        out.nodes.push({ node: node, start: start, end: end })
        return structured ? [{ type: 'text', text: out.text.slice(start, end), start: start, end: end }] : []
      }
      if (node.nodeType !== 1 || SKIP_TAGS[node.tagName] || node.id === HIGHLIGHT_ID || !visibleNode(node)) return []
      var tag = node.tagName
      if (tag === 'BR') {
        if (legacy) return []
        var at = out.text.length
        append('\n')
        return structured ? [{ type: 'break', start: at, end: out.text.length }] : []
      }
      var block = /^(P|DIV|MAIN|ASIDE|NAV|SECTION|ARTICLE|HEADER|FOOTER|FIGURE|FIGCAPTION|DL|DT|DD|H[1-6]|UL|OL|PRE|BLOCKQUOTE|TABLE)$/.test(tag)
      if (block) boundary('\n\n')
      if (tag === 'LI' || tag === 'TR') boundary('\n')
      if (tag === 'TD' || tag === 'TH') boundary('\t')
      var start = out.text.length
      var children = []
      for (var child = node.firstChild; child; child = child.nextSibling) {
        var added = visit(child, depth + 1)
        for (var a = 0; a < added.length; a++) children.push(added[a])
      }
      var end = out.text.length
      if (block) boundary('\n\n')
      if (tag === 'LI' || tag === 'TR') boundary('\n')
      if (!children.length) return []
      var types = { P: 'paragraph', DIV: 'paragraph', H1: 'paragraph', H2: 'paragraph', H3: 'paragraph', H4: 'paragraph', H5: 'paragraph', H6: 'paragraph', STRONG: 'strong', B: 'strong', EM: 'emphasis', I: 'emphasis', CODE: 'code', PRE: 'pre', BLOCKQUOTE: 'blockquote', LI: 'list-item', UL: 'list', OL: 'list' }
      var type = types[tag] || (block ? 'block' : undefined)
      if (tag === 'DIV') type = 'block'
      var result = { type: type, children: children, start: start, end: end }
      if (tag === 'A' && /^https?:\/\//i.test(node.href || '')) { result.type = 'link'; result.href = String(node.href).slice(0, 4000) }
      if (type === 'list') {
        result.ordered = tag === 'OL'
        var first = Number(node.getAttribute('start') || 1)
        result.listStart = Number.isSafeInteger(first) && first >= 0 && first <= 1000000 ? first : 1
        result.children = children.filter(function (child) { return child.type === 'list-item' })
      }
      return result.type ? [result] : children
    }
    for (var child = body.firstChild; child && !out.truncated; child = child.nextSibling) {
      var added = visit(child, 0)
      for (var a = 0; a < added.length; a++) out.content.push(added[a])
    }
    return out
  }

  function selectedContent(nodes, start, end) {
    var result = []
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i]
      if (node.end <= start || node.start >= end) continue
      if (node.type === 'text') {
        result.push({ type: 'text', text: node.text.slice(Math.max(0, start - node.start), Math.min(node.text.length, end - node.start)) })
      } else if (node.type === 'break') result.push({ type: 'break' })
      else {
        var children = selectedContent(node.children, start, end)
        if (!children.length) continue
        var part = { type: node.type, children: children }
        if (node.type === 'link') part.href = node.href
        if (node.type === 'list') {
          part.ordered = node.ordered
          part.start = node.listStart + (node.ordered ? node.children.filter(function (child) { return child.end <= start }).length : 0)
        }
        result.push(part)
      }
    }
    return result
  }

  function safeStart(text, index) {
    if (index > 0 && index < text.length) {
      var code = text.charCodeAt(index)
      if (code >= 0xdc00 && code <= 0xdfff) return index - 1
    }
    return index
  }

  function safeEnd(text, index) {
    if (index > 0 && index < text.length) {
      var code = text.charCodeAt(index)
      if (code >= 0xdc00 && code <= 0xdfff) return index + 1
    }
    return index
  }

  function rangeContainsNode(range, node) {
    try {
      if (!range.intersectsNode(node)) return false
      var box = document.createRange()
      box.selectNode(node)
      return range.compareBoundaryPoints(0, box) <= 0 && range.compareBoundaryPoints(3, box) >= 0
    } catch (error) { return false }
  }

  function selectedPart(range, entry) {
    var node = entry.node
    var value = node.nodeValue || ''
    var length = Math.min(value.length, entry.end === undefined ? value.length : entry.end - entry.start)
    var start = 0
    var end = length
    try {
      if (range.startContainer === node) start = Math.max(0, Math.min(range.startOffset, length))
      else if (range.comparePoint(node, 0) === 1) return null
      if (range.endContainer === node) end = Math.max(0, Math.min(range.endOffset, length))
      else if (range.comparePoint(node, length) === -1) return null
    } catch (error) { return null }
    if (end <= start) return null
    return { start: entry.start + start, end: entry.start + end, node: node }
  }

  function mergeRanges(ranges, text) {
    ranges.sort(function (a, b) { return a.start - b.start })
    var out = []
    for (var i = 0; i < ranges.length; i++) {
      var run = ranges[i]
      var last = out.length ? out[out.length - 1] : null
      if (last && (run.start <= last.end || (text !== undefined && /^\s*$/.test(text.slice(last.end, run.start))))) last.end = Math.max(last.end, run.end)
      else out.push({ start: run.start, end: run.end, node: run.node })
    }
    return out
  }

  function pathOf(node) {
    var body = pageBody()
    var path = []
    var current = node
    while (current && current !== body) {
      var parent = current.parentNode
      if (!parent) return null
      var index = 0
      var child = parent.firstChild
      while (child && child !== current) { child = child.nextSibling; index += 1 }
      if (!child) return null
      path.unshift(index)
      current = parent
    }
    return current === body ? path : null
  }

  function nodeAtPath(path) {
    var node = pageBody()
    if (!node || !path || !path.length) return node
    for (var i = 0; i < path.length; i++) {
      if (!node || !node.childNodes || path[i] < 0 || path[i] >= node.childNodes.length) return null
      node = node.childNodes[path[i]]
    }
    return node
  }

  function selectorOf(el) {
    if (!el || el.nodeType !== 1) return ''
    try {
      if (el.id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(el.id)) return '#' + el.id
      var parts = []
      var node = el
      var depth = 0
      while (node && node.nodeType === 1 && depth < 6) {
        var tag = node.tagName.toLowerCase()
        var index = 1
        var sibling = node.previousElementSibling
        while (sibling) { if (sibling.tagName === node.tagName) index += 1; sibling = sibling.previousElementSibling }
        parts.unshift(tag + (index > 1 ? ':nth-of-type(' + index + ')' : ''))
        if (node.id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(node.id)) { parts.unshift('#' + node.id); break }
        node = node.parentElement
        depth += 1
      }
      return parts.join(' > ')
    } catch (error) { return '' }
  }

  function documentOrder(a, b) {
    if (a === b) return 0
    try {
      var position = a.compareDocumentPosition(b)
      if (position & 4) return -1
      if (position & 2) return 1
    } catch (error) { /* fall through */ }
    return 0
  }

  function geometryOf(el) {
    try {
      var box = el.getBoundingClientRect()
      return { x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height) }
    } catch (error) { return { x: 0, y: 0, w: 0, h: 0 } }
  }

  function isInside(node, ancestor) {
    var el = node.parentElement
    while (el) {
      if (el === ancestor) return true
      el = el.parentElement
    }
    return false
  }

  function captionOf(el) {
    var node = el.parentElement
    var depth = 0
    while (node && depth < 8) {
      if (node.tagName === 'FIGURE') {
        var caption = node.querySelector ? node.querySelector('figcaption') : null
        return caption ? collapse(caption.innerText || caption.textContent, 500) : ''
      }
      node = node.parentElement
      depth += 1
    }
    return ''
  }

  function isSvg(el) {
    return String(el.tagName).toLowerCase() === 'svg'
  }

  function cellImageRuns(cell) {
    var runs = []
    if (!cell || typeof document.createTreeWalker !== 'function') return runs
    var walker = document.createTreeWalker(cell, 5, null, false)
    var node = walker.nextNode()
    while (node) {
      if (node.nodeType === 3) {
        var text = collapse(node.nodeValue, 2000)
        if (text !== '') {
          var last = runs.length ? runs[runs.length - 1] : null
          if (last && last.type === 'text') last.text = collapse(last.text + ' ' + text, 2000)
          else runs.push({ type: 'text', text: text })
        }
      } else if (String(node.tagName).toUpperCase() === 'IMG') {
        runs.push({
          type: 'image',
          src: String(node.currentSrc || node.src || ''),
          currentSrc: String(node.currentSrc || ''),
          alt: collapse(node.getAttribute('alt'), 500),
        })
      }
      node = walker.nextNode()
    }
    return runs
  }

  function cellFacts(cell, ranges) {
    var selected = false
    var contained = false
    for (var i = 0; i < ranges.length; i++) {
      var range = ranges[i]
      try {
        if (!range.intersectsNode(cell)) continue
      } catch (error) { continue }
      selected = true
      if (rangeContainsNode(range, cell)) contained = true
    }
    if (!selected) return { selected: false, partial: false }
    if (contained) return { selected: true, partial: false }
    var full = ''
    var picked = ''
    if (typeof document.createTreeWalker === 'function') {
      var walker = document.createTreeWalker(cell, 4, null, false)
      var node = walker.nextNode()
      while (node) {
        var value = node.nodeValue || ''
        full += value
        for (var r = 0; r < ranges.length; r++) {
          var part = selectedPart(ranges[r], { node: node, start: 0, end: value.length })
          if (part) picked += value.slice(part.start, part.end)
        }
        node = walker.nextNode()
      }
    }
    return { selected: true, partial: collapse(picked, 0) !== collapse(full, 0) }
  }

  function tableSnapshot(table, ranges, spec) {
    // An explicit right-click table target is a whole-table action too: the
    // selection was cleared on purpose, so judging cells by "selected" would
    // return null and silently drop the very object the user right-clicked.
    var wholeTable = Boolean(spec.tableSelector)
      || Boolean(spec.target && typeof spec.target === 'object' && String(spec.target.kind) === 'table')
    var scope = wholeTable ? 'table' : 'selection'
    var rows = []
    try { rows = table.rows ? Array.prototype.slice.call(table.rows) : [] } catch (error) { rows = [] }
    var grid = []
    var cells = []
    var selectedAny = false
    var maxColumns = 0
    var maxRow = 0
    var truncated = false
    var maxCells = Math.max(1, Math.min(Number(spec.maxCells) || 2000, 5000))
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r]
      var rowCells = row && row.cells ? row.cells : []
      var column = 0
      for (var c = 0; c < rowCells.length; c++) {
        var cell = rowCells[c]
        var rowSpan = Math.max(1, Math.min(Number(cell.rowSpan) || 1, 1000))
        var columnSpan = Math.max(1, Math.min(Number(cell.colSpan) || 1, 200))
        if (!grid[r]) grid[r] = []
        while (grid[r][column]) column += 1
        for (var dr = 0; dr < rowSpan; dr++) {
          if (!grid[r + dr]) grid[r + dr] = []
          for (var dc = 0; dc < columnSpan; dc++) grid[r + dr][column + dc] = true
        }
        column += columnSpan
        if (column > maxColumns) maxColumns = column
        if (r + rowSpan > maxRow) maxRow = r + rowSpan
        var rowIsHead = cell.parentElement && String(cell.parentElement.tagName).toUpperCase() === 'THEAD'
        var role = String(cell.tagName).toUpperCase() === 'TH' || rowIsHead ? 'header' : 'data'
        var facts = cellFacts(cell, ranges)
        if (facts.selected) selectedAny = true
        if (scope === 'selection' && !facts.selected && role !== 'header') continue
        if (cells.length >= maxCells) { truncated = true; continue }
        cells.push({
          row: r,
          column: column - columnSpan,
          rowSpan: rowSpan,
          columnSpan: columnSpan,
          role: role,
          text: collapse(cell.innerText || cell.textContent, 2000),
          includedAs: facts.selected || scope === 'table' ? 'selection' : 'header-context',
          partialText: facts.selected ? facts.partial : false,
          inlineContent: cellImageRuns(cell),
        })
      }
    }
    if (scope === 'selection' && !selectedAny) return null
    var declaredRows = Number(table.getAttribute && table.getAttribute('aria-rowcount')) || 0
    var completeness = scope === 'table'
      ? declaredRows > rows.length ? 'visible-rows' : 'dom-table'
      : 'selected-cells'
    return {
      rowCount: truncated ? maxRow : Math.max(maxRow, rows.length),
      columnCount: maxColumns,
      caption: collapse(table.caption ? table.caption.innerText || table.caption.textContent : '', 500),
      completeness: completeness,
      truncated: truncated,
      cells: cells,
    }
  }

  function ownedByGrid(element, grid) {
    var node = element.parentElement
    while (node && node !== grid) {
      var role = String(node.getAttribute && node.getAttribute('role') || '')
      if (role === 'grid' || role === 'table') return false
      node = node.parentElement
    }
    return node === grid
  }

  function closestRoleRow(element, grid) {
    var node = element
    while (node && node !== grid) {
      if (String(node.getAttribute && node.getAttribute('role') || '') === 'row') return node
      node = node.parentElement
    }
    return null
  }

  // ARIA grids are not HTML tables: rows and cells are role-named elements.
  // The snapshot keeps the declared row/column indices so a virtualised grid
  // can still be located after re-render.
  function ariaTableSnapshot(grid, ranges, spec) {
    var rows = []
    try { rows = grid.querySelectorAll ? Array.prototype.slice.call(grid.querySelectorAll('[role="row"]')) : [] } catch (error) { rows = [] }
    var cells = []
    var selectedAny = false
    var maxCells = Math.max(1, Math.min(Number(spec.maxCells) || 2000, 5000))
    var truncated = false
    var maxColumns = 0
    var declaredRows = Number(grid.getAttribute && grid.getAttribute('aria-rowcount')) || 0
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r]
      if (!ownedByGrid(row, grid)) continue
      var all = row.querySelectorAll ? row.querySelectorAll('[role="gridcell"], [role="cell"], [role="columnheader"], [role="rowheader"]') : []
      var column = 0
      for (var c = 0; c < all.length; c++) {
        var cell = all[c]
        if (closestRoleRow(cell, grid) !== row) continue
        var rowSpan = Math.max(1, Math.min(Number(cell.getAttribute('aria-rowspan')) || 1, 1000))
        var columnSpan = Math.max(1, Math.min(Number(cell.getAttribute('aria-colspan')) || 1, 200))
        var declaredColumn = Number(cell.getAttribute('aria-colindex'))
        if (declaredColumn > 0) column = declaredColumn - 1
        var declaredRow = Number(cell.getAttribute('aria-rowindex'))
        var rowIndex = declaredRow > 0 ? declaredRow - 1 : r
        var roleName = String(cell.getAttribute('role') || '')
        var role = roleName === 'columnheader' || roleName === 'rowheader' ? 'header' : 'data'
        var facts = cellFacts(cell, ranges)
        if (facts.selected) selectedAny = true
        if (!facts.selected && role !== 'header') { column += columnSpan; continue }
        if (cells.length >= maxCells) { truncated = true; column += columnSpan; continue }
        cells.push({
          row: rowIndex,
          column: column,
          rowSpan: rowSpan,
          columnSpan: columnSpan,
          role: role,
          text: collapse(cell.innerText || cell.textContent, 2000),
          includedAs: facts.selected ? 'selection' : 'header-context',
          partialText: facts.selected ? facts.partial : false,
          inlineContent: cellImageRuns(cell),
        })
        if (column + columnSpan > maxColumns) maxColumns = column + columnSpan
        column += columnSpan
      }
    }
    if (!selectedAny) return null
    var rowCount = declaredRows > 0 ? declaredRows : rows.length
    return {
      rowCount: Math.max(rowCount, rows.length),
      columnCount: maxColumns,
      caption: collapse(grid.getAttribute && grid.getAttribute('aria-label') || '', 500),
      completeness: declaredRows > rows.length ? 'visible-rows' : 'aria-grid',
      truncated: truncated,
      cells: cells,
    }
  }

  function trimmedRun(map, start, end) {    while (start < end && /\s/.test(map.text.charAt(start))) start += 1
    while (end > start && /\s/.test(map.text.charAt(end - 1))) end -= 1
    return end > start ? { start: start, end: end } : null
  }

  function subtractSpans(run, spans) {
    var pieces = [{ start: run.start, end: run.end }]
    for (var i = 0; i < spans.length; i++) {
      var next = []
      for (var p = 0; p < pieces.length; p++) {
        var piece = pieces[p]
        if (spans[i].end <= piece.start || spans[i].start >= piece.end) { next.push(piece); continue }
        if (spans[i].start > piece.start) next.push({ start: piece.start, end: spans[i].start })
        if (spans[i].end < piece.end) next.push({ start: spans[i].end, end: piece.end })
      }
      pieces = next
    }
    return pieces
  }

  function excerptRun(map, needle) {
    if (!needle) return null
    var first = map.text.indexOf(needle)
    if (first === -1) return null
    var second = map.text.indexOf(needle, first + 1)
    if (second !== -1) return { ambiguous: true, start: first, end: first + needle.length }
    return { ambiguous: false, start: first, end: first + needle.length }
  }

  function capture(spec) {
    var body = pageBody()
    if (!body) return { ok: false, reason: 'no-document' }
    var selection = window.getSelection ? window.getSelection() : null
    var ranges = []
    if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
      for (var i = 0; i < selection.rangeCount; i++) {
        try { ranges.push(selection.getRangeAt(i).cloneRange()) } catch (error) { /* a lost range is skipped */ }
      }
    }
    var tableSelector = spec.tableSelector ? String(spec.tableSelector) : ''
    var targetTable = null
    // An explicit right-click target (§3.2 / §3.3): capture THIS image or THIS
    // table even when the selection collapsed while the native menu was open.
    var target = spec.target && typeof spec.target === 'object' ? spec.target : null
    var targetImage = null
    if (target && String(target.kind) === 'image') {
      var wanted = String(target.srcUrl || '')
      var candidates = body.querySelectorAll ? body.querySelectorAll('img, svg, canvas') : []
      for (var ci = 0; ci < candidates.length && ci < 400; ci++) {
        var candidate = candidates[ci]
        var candidateSrc = String(candidate.currentSrc || candidate.src
          || (candidate.getAttribute && candidate.getAttribute('src')) || '')
        if (wanted && candidateSrc && (candidateSrc === wanted
          || candidateSrc.indexOf(wanted) >= 0 || wanted.indexOf(candidateSrc) >= 0)) {
          targetImage = candidate
          break
        }
      }
      if (!targetImage && target.x !== undefined && target.y !== undefined && document.elementFromPoint) {
        try {
          var hitNode = document.elementFromPoint(Number(target.x), Number(target.y))
          targetImage = hitNode && hitNode.closest ? hitNode.closest('img, svg, canvas') : null
        } catch (error) { targetImage = null }
      }
      if (!targetImage) return { ok: false, reason: 'image-target-not-found' }
    } else if (target && String(target.kind) === 'table' && !tableSelector) {
      if (target.x !== undefined && target.y !== undefined && document.elementFromPoint) {
        try {
          var tableHit = document.elementFromPoint(Number(target.x), Number(target.y))
          targetTable = tableHit && tableHit.closest ? tableHit.closest('table') : null
        } catch (error) { targetTable = null }
      }
      if (!targetTable && ranges.length > 0) {
        var rangeBase = ranges[0].commonAncestorContainer
        var rangeElement = rangeBase && rangeBase.nodeType === 1 ? rangeBase : (rangeBase && rangeBase.parentElement)
        targetTable = rangeElement && rangeElement.closest ? rangeElement.closest('table') : null
      }
      if (!targetTable) return { ok: false, reason: 'table-target-not-found' }
    }
    if (tableSelector) {
      try { targetTable = document.querySelector(tableSelector) } catch (error) { targetTable = null }
      if (!targetTable || String(targetTable.tagName).toUpperCase() !== 'TABLE') return { ok: false, reason: 'table-not-found' }
    }
    // Any explicit target is a whole-object action: the selection is not part of it.
    if (targetTable || targetImage) ranges = []
    var excerpt = null
    if (ranges.length === 0 && !targetTable && !targetImage) {
      if (!spec.excerptText) return { ok: false, reason: 'no-selection' }
    }

    var map = flatTextMap(spec.maxChars, true)
    if (ranges.length === 0 && !targetTable && !targetImage) {
      excerpt = excerptRun(map, String(spec.excerptText))
      if (!excerpt) return { ok: false, reason: 'excerpt-not-found' }
      if (excerpt.ambiguous) return { ok: false, reason: 'excerpt-ambiguous' }
    }

    var textRuns = []
    for (var r = 0; r < ranges.length; r++) {
      var found = []
      for (var n = 0; n < map.nodes.length; n++) {
        var part = selectedPart(ranges[r], map.nodes[n])
        if (part) found.push(part)
      }
      var merged = mergeRanges(found, map.text)
      for (var m = 0; m < merged.length; m++) textRuns.push(merged[m])
    }
    if (excerpt) textRuns = [{ start: excerpt.start, end: excerpt.end, node: nodeForOffset(map, excerpt.start) }]
    textRuns = mergeRanges(textRuns)

    var tables = []
    if (targetTable) tables.push(targetTable)
    else {
      var allTables = body.querySelectorAll ? body.querySelectorAll('table') : []
      for (var t = 0; t < allTables.length && t < 200; t++) {
        for (var q = 0; q < ranges.length; q++) {
          var hitTable = false
          try { hitTable = ranges[q].intersectsNode(allTables[t]) } catch (error) { hitTable = false }
          if (hitTable) { tables.push(allTables[t]); break }
        }
      }
    }
    var topTables = []
    for (var t2 = 0; t2 < tables.length; t2++) {
      var nested = false
      for (var t3 = 0; t3 < tables.length; t3++) {
        if (t3 !== t2 && isInside(tables[t2], tables[t3])) { nested = true; break }
      }
      if (!nested) topTables.push(tables[t2])
    }
    tables = topTables

    if (!targetTable) {
      var ariaGrids = body.querySelectorAll ? body.querySelectorAll('[role="grid"], [role="table"]') : []
      for (var ag = 0; ag < ariaGrids.length && ag < 50; ag++) {
        var grid = ariaGrids[ag]
        if (String(grid.tagName || '').toUpperCase() === 'TABLE') continue
        var hitGrid = false
        for (var qg = 0; qg < ranges.length; qg++) {
          try { hitGrid = ranges[qg].intersectsNode(grid) } catch (error) { hitGrid = false }
          if (hitGrid) break
        }
        if (!hitGrid) continue
        var insideSelected = false
        for (var ht = 0; ht < tables.length; ht++) {
          if (isInside(grid, tables[ht])) { insideSelected = true; break }
        }
        if (!insideSelected) tables.push(grid)
      }
    }

    var images = []
    if (targetImage) images.push(targetImage)
    else if (!targetTable) {
      var allImages = body.querySelectorAll ? body.querySelectorAll('img, svg, canvas') : []
      for (var g = 0; g < allImages.length && g < 400; g++) {
        var image = allImages[g]
        var canvasImage = String(image.tagName || '').toUpperCase() === 'CANVAS'
        if (!canvasImage && isSvg(image) && image.parentElement && isSvg(image.parentElement)) continue
        if (!visibleNode(image)) continue
        var hitImage = false
        for (var w = 0; w < ranges.length; w++) {
          try { hitImage = ranges[w].intersectsNode(image) } catch (error) { hitImage = false }
          if (hitImage) break
        }
        if (!hitImage) continue
        var box = geometryOf(image)
        if (box.w < 8 || box.h < 8) continue
        var insideTable = false
        for (var it = 0; it < tables.length; it++) {
          if (isInside(image, tables[it])) { insideTable = true; break }
        }
        if (insideTable) continue
        images.push(image)
      }
    }

    // A selected table's text belongs to the table part. The flat map runs straight through
    // it (cells contribute their text like any other node), so a run that spans a table would
    // carry that text a second time; cut each table's span out and keep the text on both sides.
    var tableSpans = []
    if (typeof Map === 'function' && typeof document.createTreeWalker === 'function') {
      var nodeOffsets = new Map()
      for (var no = 0; no < map.nodes.length; no++) nodeOffsets.set(map.nodes[no].node, map.nodes[no])
      for (var ts = 0; ts < tables.length; ts++) {
        var min = Infinity
        var max = -1
        var tableWalker = document.createTreeWalker(tables[ts], 4, null, false)
        var tableNode = tableWalker.nextNode()
        while (tableNode) {
          var offset = nodeOffsets.get(tableNode)
          if (offset) {
            if (offset.start < min) min = offset.start
            if (offset.end > max) max = offset.end
          }
          tableNode = tableWalker.nextNode()
        }
        if (max > min) tableSpans.push({ start: min, end: max })
      }
    }
    var keptRuns = []
    for (var kr = 0; kr < textRuns.length; kr++) {
      var pieces = subtractSpans(textRuns[kr], tableSpans)
      for (var kp = 0; kp < pieces.length; kp++) {
        var trimmed = trimmedRun(map, pieces[kp].start, pieces[kp].end)
        if (trimmed) keptRuns.push({ start: trimmed.start, end: trimmed.end, node: nodeForOffset(map, trimmed.start) })
      }
    }

    var events = []
    var context = Math.max(0, Math.min(Number(spec.context) || 32, 512))
    for (var tr = 0; tr < keptRuns.length; tr++) {
      var run = keptRuns[tr]
      var start = safeStart(map.text, run.start)
      var end = safeEnd(map.text, run.end)
      var exact = map.text.slice(start, end)
      if (collapse(exact, 0) === '') continue
      events.push({
        node: run.node,
        payload: {
          kind: 'text',
          exact: exact,
          content: selectedContent(map.content, start, end),
          prefix: map.text.slice(safeStart(map.text, Math.max(0, start - context)), start),
          suffix: map.text.slice(end, safeEnd(map.text, Math.min(map.text.length, end + context))),
        },
      })
    }
    for (var im = 0; im < images.length; im++) {
      var element = images[im]
      var elementCanvas = String(element.tagName || '').toUpperCase() === 'CANVAS'
      var canvasData = ''
      if (elementCanvas) {
        try { canvasData = String(element.toDataURL('image/png') || '') } catch (error) { canvasData = '' }
      }
      events.push({
        node: element,
        payload: {
          kind: 'image',
          src: elementCanvas ? canvasData : String(element.currentSrc || element.src || ''),
          currentSrc: elementCanvas ? canvasData : String(element.currentSrc || ''),
          attributeSrc: elementCanvas ? canvasData : element.getAttribute ? String(element.getAttribute('src') || '') : '',
          dataUrl: canvasData,
          alt: collapse(element.getAttribute ? element.getAttribute('alt') : '', 500),
          caption: captionOf(element),
          selector: selectorOf(element),
          path: pathOf(element),
          svg: isSvg(element),
          canvas: elementCanvas,
          width: elementCanvas ? (Number(element.width) || 0) : (Number(element.naturalWidth) || 0),
          height: elementCanvas ? (Number(element.height) || 0) : (Number(element.naturalHeight) || 0),
          geometry: geometryOf(element),
        },
      })
    }
    for (var tb = 0; tb < tables.length; tb++) {
      var gridRole = String(tables[tb].getAttribute && tables[tb].getAttribute('role') || '').toLowerCase()
      var ariaGrid = gridRole === 'grid' || gridRole === 'table'
      var snapshot = ariaGrid ? ariaTableSnapshot(tables[tb], ranges, spec) : tableSnapshot(tables[tb], ranges, spec)
      if (snapshot === null) continue
      events.push({
        node: tables[tb],
        payload: {
          kind: 'table',
          selector: selectorOf(tables[tb]),
          path: pathOf(tables[tb]),
          geometry: geometryOf(tables[tb]),
          table: snapshot,
        },
      })
    }
    events.sort(function (a, b) { return documentOrder(a.node, b.node) })

    return {
      ok: true,
      url: String(location.href),
      frameUrl: String(location.href),
      title: String(document.title || ''),
      multipleRanges: ranges.length > 1,
      truncated: map.truncated,
      ambiguousExcerpt: excerpt ? excerpt.ambiguous : false,
      events: events.map(function (entry) { return entry.payload }),
    }
  }

  function nodeForOffset(map, offset) {
    for (var i = 0; i < map.nodes.length; i++) {
      if (offset >= map.nodes[i].start && offset < map.nodes[i].end) return map.nodes[i].node
    }
    return map.nodes.length ? map.nodes[0].node : null
  }

  function highlightRects(rects, spec) {
    clearHighlight()
    var host = document.createElement('div')
    host.id = HIGHLIGHT_ID
    host.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;pointer-events:none;z-index:2147483646'
    var scrollX = window.scrollX || window.pageXOffset || 0
    var scrollY = window.scrollY || window.pageYOffset || 0
    var fill = spec.fill || 'rgba(255,214,0,0.35)'
    var line = spec.line || 'rgba(214,158,0,0.9)'
    for (var i = 0; i < rects.length; i++) {
      var rect = rects[i]
      if (!rect || rect.width <= 0 || rect.height <= 0) continue
      var box = document.createElement('div')
      box.style.cssText = 'position:absolute;pointer-events:none;border-radius:2px'
      box.style.background = fill
      box.style.outline = '1px solid ' + line
      box.style.left = (rect.left + scrollX) + 'px'
      box.style.top = (rect.top + scrollY) + 'px'
      box.style.width = rect.width + 'px'
      box.style.height = rect.height + 'px'
      host.appendChild(box)
    }
    if (!host.firstChild) return 0
    ;(document.body || document.documentElement).appendChild(host)
    var count = host.childNodes.length
    var lifetime = Math.max(500, Math.min(Number(spec.durationMs) || 2500, 10000))
    setTimeout(clearHighlight, lifetime)
    return count
  }

  function clearHighlight() {
    var existing = document.getElementById(HIGHLIGHT_ID)
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing)
  }

  function scrollRect(rect) {
    if (!rect) return false
    try {
      var height = window.innerHeight || 0
      if (height > 0 && (rect.top < 48 || rect.bottom > height - 48)) {
        var target = (window.scrollY || 0) + rect.top - height / 2 + rect.height / 2
        window.scrollTo({ left: window.scrollX || 0, top: Math.max(0, target), behavior: 'auto' })
        return true
      }
    } catch (error) { /* a page that refuses scrolling still gets the highlight */ }
    return false
  }

  function highlightText(spec) {
    var map = flatTextMap(spec.maxChars, false, spec.legacy)
    var start = Math.max(0, Math.min(Number(spec.start) || 0, map.text.length))
    var end = Math.max(0, Math.min(Number(spec.end) || 0, map.text.length))
    if (end <= start) return { ok: false, reason: 'range-not-found' }
    var startEntry = null
    var endEntry = null
    for (var i = 0; i < map.nodes.length; i++) {
      var entry = map.nodes[i]
      if (start >= entry.start && start < entry.end) startEntry = { node: entry.node, offset: start - entry.start }
      if (end > entry.start && end <= entry.end) endEntry = { node: entry.node, offset: end - entry.start }
    }
    if (!startEntry || !endEntry) return { ok: false, reason: 'range-not-found' }
    var range = document.createRange()
    range.setStart(startEntry.node, startEntry.offset)
    range.setEnd(endEntry.node, endEntry.offset)
    var rects = range.getClientRects ? range.getClientRects() : []
    var first = rects.length ? rects[0] : range.getBoundingClientRect()
    var scrolled = scrollRect(first)
    var count = highlightRects(rects, spec)
    return { ok: true, rects: count, scrolled: scrolled }
  }

  function loadImage(url) {
    return new Promise(function (resolve) {
      var image = new Image()
      if (!/^data:image\/svg\+xml/i.test(url)) image.crossOrigin = 'anonymous'
      var done = false
      var timer = setTimeout(function () {
        if (done) return
        done = true
        resolve({ ok: false, reason: 'image-timeout' })
      }, 5000)
      image.onload = function () {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ ok: true, image: image, width: image.naturalWidth || image.width, height: image.naturalHeight || image.height })
      }
      image.onerror = function () {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ ok: false, reason: 'image-load-failed' })
      }
      image.src = url
    })
  }

  function rasterize(spec) {
    var node = spec.path ? nodeAtPath(spec.path) : (spec.selector ? document.querySelector(spec.selector) : null)
    if (!node) return Promise.resolve({ ok: false, reason: 'element-not-found' })
    var url = ''
    var canvasNode = String(node.tagName || '').toUpperCase() === 'CANVAS'
    try {
      if (isSvg(node)) {
        var xml = new XMLSerializer().serializeToString(node)
        url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml)
      } else if (canvasNode) {
        url = node.toDataURL('image/png')
      } else {
        url = node.currentSrc || node.src || ''
      }
    } catch (error) { return Promise.resolve({ ok: false, reason: 'no-image-source' }) }
    if (!url) return Promise.resolve({ ok: false, reason: 'no-image-source' })
    return loadImage(url).then(function (loaded) {
      if (!loaded.ok) return { ok: false, reason: loaded.reason }
      var width = canvasNode ? Number(node.width) || 0 : Number(node.naturalWidth) || loaded.width || 0
      var height = canvasNode ? Number(node.height) || 0 : Number(node.naturalHeight) || loaded.height || 0
      if (!width || !height) {
        var box = geometryOf(node)
        width = box.w
        height = box.h
      }
      if (!width || !height) return { ok: false, reason: 'no-image-size' }
      if (canvasNode) {
        var capDirect = Math.max(64, Math.min(Number(spec.maxDimension) || 1600, 4096))
        if (Math.max(width, height) <= capDirect) {
          try {
            return { ok: true, dataUrl: node.toDataURL('image/png'), width: width, height: height }
          } catch (error) { return { ok: false, reason: 'canvas-tainted' } }
        }
      }
      var cap = Math.max(64, Math.min(Number(spec.maxDimension) || 1600, 4096))
      var scale = Math.min(1, cap / Math.max(width, height))
      var canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(width * scale))
      canvas.height = Math.max(1, Math.round(height * scale))
      var context = canvas.getContext ? canvas.getContext('2d') : null
      if (!context) return { ok: false, reason: 'no-canvas' }
      try {
        context.drawImage(loaded.image, 0, 0, canvas.width, canvas.height)
        var dataUrl = canvas.toDataURL('image/png')
        return { ok: true, dataUrl: dataUrl, width: canvas.width, height: canvas.height }
      } catch (error) {
        return { ok: false, reason: 'canvas-tainted' }
      }
    })
  }

  function revealElement(spec) {
    var anchor = spec.anchor || {}
    var kind = spec.kind
    var best = null
    var bestScore = 0
    var ties = 0
    var pool = []
    var wantedTag = kind === 'image' ? 'img' : 'table'
    var imageTags = ['IMG', 'SVG', 'CANVAS']
    if (anchor.selector) {
      try {
        var direct = document.querySelector(anchor.selector)
        var directTag = direct ? String(direct.tagName).toUpperCase() : ''
        if (direct && (kind === 'image' ? imageTags.indexOf(directTag) !== -1 : directTag === wantedTag.toUpperCase())) pool.push(direct)
      } catch (error) { /* an invalid stored selector is only a miss */ }
    }
    var all = pageBody().querySelectorAll ? pageBody().querySelectorAll(kind === 'image' ? 'img, svg, canvas' : 'table, [role="grid"], [role="table"]') : []
    for (var i = 0; i < all.length && i < 400; i++) {
      if (pool.indexOf(all[i]) === -1) pool.push(all[i])
    }
    for (var p = 0; p < pool.length; p++) {
      var candidate = pool[p]
      var score = 0
      if (kind === 'image') {
        var src = String(candidate.currentSrc || candidate.src || '')
        if (anchor.currentSrc && src === anchor.currentSrc) score += 4
        if (anchor.src && (src === anchor.src || String(candidate.getAttribute('src') || '') === anchor.src)) score += 3
        if (anchor.alt && collapse(candidate.getAttribute('alt'), 500) === anchor.alt) score += 2
        if (anchor.selector && selectorOf(candidate) === anchor.selector) score += 1
      } else {
        var caption = collapse(candidate.caption ? candidate.caption.innerText || candidate.caption.textContent : (candidate.getAttribute ? candidate.getAttribute('aria-label') || '' : ''), 500)
        if (anchor.caption && caption === anchor.caption) score += 6
        if (anchor.headers && anchor.headers.length) {
          var headRow = candidate.rows && candidate.rows.length ? candidate.rows[0] : null
          var headText = []
          if (headRow) {
            for (var hc = 0; hc < headRow.cells.length; hc++) headText.push(collapse(headRow.cells[hc].innerText || headRow.cells[hc].textContent, 200))
          } else if (candidate.querySelectorAll) {
            var headCells = candidate.querySelectorAll('[role="columnheader"], [role="rowheader"]')
            for (var hh = 0; hh < headCells.length && hh < 64; hh++) headText.push(collapse(headCells[hh].innerText || headCells[hh].textContent, 200))
          }
          if (headText.length > 0) {
            var matched = 0
            for (var ah = 0; ah < anchor.headers.length; ah++) {
              if (headText.indexOf(anchor.headers[ah]) !== -1) matched += 1
            }
            if (matched === anchor.headers.length) score += 4
            else score += matched * 0.5
          }
        }
        if (anchor.firstCells && anchor.firstCells.length) {
          var firstText = []
          if (candidate.rows && candidate.rows.length) {
            var firstRow = candidate.rows[0]
            for (var fc = 0; fc < firstRow.cells.length; fc++) firstText.push(collapse(firstRow.cells[fc].innerText || firstRow.cells[fc].textContent, 200))
          } else if (candidate.querySelectorAll) {
            var firstCells = candidate.querySelectorAll('[role="gridcell"], [role="cell"]')
            for (var ff = 0; ff < firstCells.length && ff < 64; ff++) firstText.push(collapse(firstCells[ff].innerText || firstCells[ff].textContent, 200))
          }
          var firstMatched = 0
          for (var af = 0; af < anchor.firstCells.length; af++) {
            if (firstText[af] === anchor.firstCells[af]) firstMatched += 1
          }
          if (firstMatched > 0) score += firstMatched * 0.5
        }
        if (anchor.selector && selectorOf(candidate) === anchor.selector) score += 1
      }
      if (score > bestScore) { best = candidate; bestScore = score; ties = 1 }
      else if (score === bestScore && score > 0 && candidate !== best) ties += 1
    }
    if (!best || bestScore <= 0) return { ok: true, status: 'missing', matches: 0, reason: 'no-candidate' }
    if (ties > 1) return { ok: true, status: 'ambiguous', matches: ties, reason: 'several-candidates' }
    var target = best
    if (kind === 'table' && anchor.cell) {
      var at = cellAt(best, anchor.cell.row, anchor.cell.column)
      if (at) target = at
    }
    try { target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }) } catch (error) {
      try { target.scrollIntoView() } catch (ignored) { /* highlight still lands */ }
    }
    var rects = target.getClientRects ? target.getClientRects() : []
    var count = highlightRects(rects.length ? rects : [target.getBoundingClientRect()], spec)
    return { ok: true, status: 'found', matches: 1, described: selectorOf(target), rects: count, scrolled: true }
  }

  function cellAt(table, row, column) {
    var rows = table.rows || []
    if (rows.length === 0 && table.querySelectorAll) {
      var ariaCells = table.querySelectorAll('[role="gridcell"], [role="cell"], [role="columnheader"], [role="rowheader"]')
      for (var ai = 0; ai < ariaCells.length && ai < 5000; ai++) {
        var ariaRow = Number(ariaCells[ai].getAttribute('aria-rowindex'))
        var ariaColumn = Number(ariaCells[ai].getAttribute('aria-colindex'))
        if (ariaRow === row + 1 && ariaColumn === column + 1) return ariaCells[ai]
      }
      return null
    }
    if (row < 0 || row >= rows.length) return null
    var cells = rows[row].cells || []
    var at = 0
    for (var i = 0; i < cells.length; i++) {
      var span = Math.max(1, Number(cells[i].colSpan) || 1)
      if (at <= column && column < at + span) return cells[i]
      at += span
    }
    return null
  }
`

function script(body: string): string {
  return `(function (spec) { ${PAGE_LIB} try { ${body} } catch (error) { return JSON.stringify({ ok: false, reason: 'script-error: ' + String(error) }) } })(arguments[0] || {})`
}

/** The capture script: selection (or one table / one excerpt) to ordered parts. */
export function captureScript(): string {
  return script('return JSON.stringify(capture(spec))')
}

/**
 * Show one short sentence inside the page, then let it fade.
 *
 * The bar used to disappear in silence when the host refused a capture (the
 * page had navigated, the selection was lost, the fragment limit was hit), so
 * the click looked like it did nothing. The host calls this with the reason; a
 * missing overlay still gets a plain toast, so the notice survives a re-inject.
 *
 * @param text - one sentence for the reader; bounded here, not by the caller.
 */
export function noticeScript(text: string): string {
  const payload = JSON.stringify(String(text ?? '').slice(0, 200))
  return script([
    `var text = ${payload}`,
    'var id = "__dsh-ref-notice"',
    'var toast = document.getElementById(id)',
    'if (!toast) {',
    '  toast = document.createElement("div")',
    '  toast.id = id',
    '  toast.setAttribute("role", "status")',
    '  toast.style.cssText = "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483646;max-width:min(420px,calc(100vw - 24px));padding:6px 10px;border-radius:8px;background:Canvas;color:CanvasText;border:.5px solid GrayText;font:500 12px/18px system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.18)"',
    '  ;(document.body || document.documentElement).appendChild(toast)',
    '}',
    'toast.textContent = text',
    'toast.style.display = "block"',
    'if (toast.__dshHide) clearTimeout(toast.__dshHide)',
    'toast.__dshHide = setTimeout(function () { toast.style.display = "none" }, 4200)',
    'return JSON.stringify({ ok: true })',
  ].join('\n'))
}

/**
 * The SAME capture as a resident page function, so the comment bar can freeze a
 * selection before its own focus destroys it.
 *
 * A text-only freeze cannot survive a rich selection: an image or a table would
 * be reduced to its words, and re-locating by the frozen text afterwards either
 * misses (the page changed) or silently picks another occurrence of the same
 * words. Freezing the complete ordered capture — text runs, assets and table
 * ranges, with their anchors — keeps the source identity attached to what the
 * human actually selected. It returns the raw object, not a JSON string,
 * because the caller hands it back to the host unchanged.
 */
export function captureEntrySource(): string {
  return `(function (spec) { ${PAGE_LIB} try { return capture(spec) } catch (error) { return { ok: false, reason: 'script-error: ' + String(error) } } })`
}

/** Bound for the frozen capture a page hands back; a real table can be large. */
export const MAX_FROZEN_CAPTURE_CHARS = 4_000_000
/**
 * Hard safety bound on a frozen capture's event count. Deliberately ABOVE the
 * service's `maxParts` (64): truncating here would silently drop fragments and
 * turn an honest `too-many-parts` refusal into a reference missing its tail.
 * Only a payload this large is rejected outright.
 */
export const MAX_FROZEN_CAPTURE_EVENTS = 512

/**
 * Validate the frozen capture a page bar reports, field by field.
 *
 * A page is low-trust: the payload is size-bounded and only the fields the
 * service reads are kept. Every part is validated again by the service's own
 * text/image/table checks, so a malformed event is refused there, not trusted
 * here.
 */
export function validateFrozenCapture(value: unknown): RawCaptureResult | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  if (row.ok !== true) return undefined
  let serialized: string
  try { serialized = JSON.stringify(row) } catch { return undefined }
  if (serialized.length > MAX_FROZEN_CAPTURE_CHARS) return undefined
  const events = Array.isArray(row.events) ? row.events : []
  if (events.length === 0 || events.length > MAX_FROZEN_CAPTURE_EVENTS) return undefined
  return {
    ok: true,
    ...typeof row.url === 'string' && row.url !== '' ? { url: row.url.slice(0, 4_000) } : {},
    ...typeof row.frameUrl === 'string' && row.frameUrl !== '' ? { frameUrl: row.frameUrl.slice(0, 4_000) } : {},
    ...typeof row.title === 'string' ? { title: row.title.slice(0, 500) } : {},
    // Not truncated: the service applies its own part bound and refuses an
    // oversized group as a whole, which is visible to the user.
    events: events as readonly RawCaptureEvent[],
  }
}

/** Read the page's visible text, for a host-side text-quote locate. */
export function pageTextScript(): string {
  return script(`var map = flatTextMap(spec.maxChars, false, spec.legacy)
    return JSON.stringify({ ok: true, url: String(location.href), title: String(document.title || ''), text: map.text, truncated: map.truncated })`)
}

/** Facts needed to decide whether the page is still the one a reference came from. */
export function pageFactsScript(): string {
  return script(`return JSON.stringify({ ok: true, url: String(location.href), title: String(document.title || '') })`)
}

/** Highlight one flat [start, end) range of the page text. */
export function highlightScript(): string {
  return script('return JSON.stringify(highlightText(spec))')
}

/** Locate one image or table by its stored anchor, scroll to it and highlight it. */
export function revealElementScript(): string {
  return script('return JSON.stringify(revealElement(spec))')
}

/** Rasterise one image element to a PNG data URL, for images whose bytes cannot be fetched. */
export function rasterizeScript(): string {
  return script('return rasterize(spec).then(function (result) { return JSON.stringify(result) })')
}
