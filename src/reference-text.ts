export const MAX_REFERENCE_TEXT = 20_000

export type ReferenceTextNode =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'break' }
  | { readonly type: 'rule' }
  | { readonly type: 'math'; readonly latex: string; readonly display: boolean }
  | { readonly type: 'heading'; readonly level: number; readonly children: readonly ReferenceTextNode[] }
  | { readonly type: 'pre'; readonly language?: string; readonly children: readonly ReferenceTextNode[] }
  | { readonly type: 'list-item'; readonly value?: number; readonly children: readonly ReferenceTextNode[] }
  | { readonly type: 'block' | 'paragraph' | 'strong' | 'emphasis' | 'code' | 'blockquote' | 'definition-list' | 'term' | 'definition' | 'sup' | 'sub' | 'ruby' | 'ruby-text'; readonly children: readonly ReferenceTextNode[] }
  | { readonly type: 'link'; readonly href: string; readonly children: readonly ReferenceTextNode[] }
  | { readonly type: 'list'; readonly ordered: boolean; readonly start: number; readonly children: readonly ReferenceTextNode[] }

/** Accept only bounded semantic data, never page HTML or arbitrary attributes. */
export function isReferenceText(value: unknown): value is readonly ReferenceTextNode[] {
  let count = 0
  let characters = 0
  const visit = (nodes: unknown, depth: number): boolean => Array.isArray(nodes) && depth <= 64 && nodes.every(node => {
    if (++count > 4096 || typeof node !== 'object' || node === null) return false
    if (node.type === 'text') {
      if (typeof node.text !== 'string') return false
      characters += node.text.length
      return characters <= MAX_REFERENCE_TEXT
    }
    if (node.type === 'break' || node.type === 'rule') return true
    if (node.type === 'math') {
      if (typeof node.latex !== 'string' || node.latex.length === 0 || typeof node.display !== 'boolean') return false
      characters += node.latex.length
      return characters <= MAX_REFERENCE_TEXT
    }
    if (!['block', 'paragraph', 'strong', 'emphasis', 'code', 'pre', 'list-item', 'blockquote', 'link', 'list', 'heading', 'definition-list', 'term', 'definition', 'sup', 'sub', 'ruby', 'ruby-text'].includes(node.type)) return false
    if (node.type === 'heading' && (!Number.isInteger(node.level) || node.level < 1 || node.level > 6)) return false
    if (node.type === 'pre' && node.language !== undefined && (typeof node.language !== 'string' || !/^[\w+-]{1,64}$/u.test(node.language))) return false
    if (node.type === 'list-item' && node.value !== undefined && (!Number.isSafeInteger(node.value) || Math.abs(node.value) > 1_000_000)) return false
    if (node.type === 'link' && (typeof node.href !== 'string' || node.href.length > 4000 || !/^https?:\/\//iu.test(node.href))) return false
    if (node.type === 'list' && (typeof node.ordered !== 'boolean' || !Number.isSafeInteger(node.start) || Math.abs(node.start) > 1_000_000)) return false
    return visit(node.children, depth + 1)
  })
  return visit(value, 0)
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]<>!|#]/gu, '\\$&')
}

export function referenceTextContent(nodes: readonly ReferenceTextNode[]): string {
  return nodes.map(node => node.type === 'text' ? node.text : node.type === 'math' ? node.latex : node.type === 'rule' ? '\n---\n' : node.type === 'break' ? '\n' : referenceTextContent(node.children)).join('')
}

/** The host accepts text content parts; encode the frozen semantics as Markdown. */
export function renderReferenceText(nodes: readonly ReferenceTextNode[]): string {
  const render = (items: readonly ReferenceTextNode[]): string => {
    let result = ''
    for (const node of items) {
      const text = renderNode(node)
      if (['block', 'paragraph', 'pre', 'blockquote', 'list', 'heading', 'definition-list', 'term', 'definition', 'rule'].includes(node.type) || (node.type === 'math' && node.display)) {
        if (result && !result.endsWith('\n\n')) result += result.endsWith('\n') ? '\n' : '\n\n'
        result += `${text}\n\n`
      } else result += text
    }
    return result
  }
  const renderNode = (node: ReferenceTextNode): string => {
    if (node.type === 'text') return escapeMarkdown(node.text)
    if (node.type === 'break') return '  \n'
    if (node.type === 'rule') return '---'
    if (node.type === 'math') return node.display ? `$$\n${node.latex}\n$$` : `$${node.latex}$`
    if (node.type === 'code' || node.type === 'pre') {
      const text = referenceTextContent(node.children)
      const size = Math.max(node.type === 'pre' ? 3 : 1, ...[...text.matchAll(/`+/gu)].map(match => match[0].length + 1))
      const fence = '`'.repeat(size)
      return node.type === 'pre' ? `${fence}${node.language ?? ''}\n${text}\n${fence}` : `${fence} ${text} ${fence}`
    }
    const text = render(node.children)
    switch (node.type) {
      case 'block':
      case 'paragraph': return text.trim()
      case 'heading': return `${'#'.repeat(node.level)} ${text.trim()}`
      case 'definition-list': return text.trim()
      case 'term': return text.trim()
      case 'definition': return `: ${text.trim()}`
      case 'sup': return `<sup>${text}</sup>`
      case 'sub': return `<sub>${text}</sub>`
      case 'ruby': return `<ruby>${text}</ruby>`
      case 'ruby-text': return `<rt>${text}</rt>`
      case 'strong': return `**${text}**`
      case 'emphasis': return `*${text}*`
      case 'link': return `[${text}](${node.href.replace(/[\s()<>\\]/gu, char => encodeURIComponent(char).replace(/[()]/gu, token => `%${token.charCodeAt(0).toString(16).toUpperCase()}`))})`
      case 'blockquote': return text.trim().split('\n').map(line => `> ${line}`).join('\n')
      case 'list-item': return text
      case 'list': {
        let next = node.start
        return node.children.map(child => {
          if (child.type === 'list-item' && child.value !== undefined) next = child.value
          const prefix = node.ordered ? `${next++}. ` : '- '
          const lines = render([child]).trim().split('\n')
          return prefix + lines.join(`\n${' '.repeat(prefix.length)}`)
        }).join('\n')
      }
    }
  }
  return render(nodes).trim()
}

export interface ReferenceTable {
  readonly columnCount?: number
  readonly cells: readonly {
    readonly row: number
    readonly column: number
    readonly rowSpan: number
    readonly columnSpan: number
    readonly role: 'header' | 'data'
    readonly text: string
    readonly content?: readonly ReferenceTextNode[]
  }[]
  readonly caption?: string
}

export function isReferenceTable(value: unknown): value is ReferenceTable {
  if (typeof value !== 'object' || value === null) return false
  const table = value as ReferenceTable
  return (table.caption === undefined || (typeof table.caption === 'string' && table.caption.length <= MAX_REFERENCE_TEXT))
    && (table.columnCount === undefined || (Number.isSafeInteger(table.columnCount) && table.columnCount >= 0))
    && Array.isArray(table.cells) && table.cells.length <= 20_000
    && table.cells.every(cell => cell && typeof cell.text === 'string' && cell.text.length <= MAX_REFERENCE_TEXT
      && (cell.content === undefined || isReferenceText(cell.content))
      && (cell.role === 'header' || cell.role === 'data')
      && [cell.row, cell.column].every(n => Number.isSafeInteger(n) && n >= 0)
      && [cell.rowSpan, cell.columnSpan].every(n => Number.isSafeInteger(n) && n > 0))
}

export function renderReferenceTable(table: ReferenceTable): string {
  const escape = (text: string): string => text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/\r?\n/gu, '<br>')
  const caption = table.caption === undefined ? '' : `<caption>${escape(table.caption)}</caption>\n`
  return `<table>\n${caption}${referenceTableRows(table).map(({ cells }) => `<tr>${cells.map(({ value: cell, columnSpan, rowSpan }) => {
    if (cell === undefined) return `<td colspan="${columnSpan}"></td>`
    const tag = cell.role === 'header' ? 'th' : 'td'
    return `<${tag} rowspan="${rowSpan}" colspan="${columnSpan}">${escape(cell.text)}</${tag}>`
  }).join('')}</tr>`).join('\n')}\n</table>`
}

export function renderReferenceMarkdownTable(table: ReferenceTable): string {
  if (table.cells.length === 0) return ''
  const rows = [...new Set(table.cells.map(cell => cell.row))].sort((a, b) => a - b)
  const width = Math.min(200, table.cells.reduce((max, cell) => Math.max(max, cell.column + cell.columnSpan), table.columnCount ?? 0))
  const escape = (text: string): string => text.replace(/\\/gu, '\\\\').replace(/\|/gu, '\\|').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/\r?\n/gu, '<br>')
  const line = (values: readonly string[]): string => `| ${values.join(' | ')} |`
  const values = rows.map(row => Array.from({ length: width }, (_, column) => {
    const cell = table.cells.find(cell => cell.row <= row && cell.row + cell.rowSpan > row && cell.column <= column && cell.column + cell.columnSpan > column)
    return cell?.content === undefined ? escape(cell?.text ?? '') : renderReferenceText(cell.content).replace(/\\?\|/gu, '\\|').replace(/\r?\n/gu, '<br>')
  }))
  const header = table.cells.some(cell => cell.row === rows[0] && cell.role === 'header') ? values.shift()! : Array.from({ length: width }, () => '')
  return [table.caption, line(header), line(Array.from({ length: width }, () => '---')), ...values.map(line)].filter(value => value !== undefined && value !== '').join('\n')
}

export function referenceTableRows<T extends ReferenceTable['cells'][number]>(table: { readonly cells: readonly T[]; readonly columnCount?: number }): {
  row: number; cells: { column: number; columnSpan: number; rowSpan: number; value?: T }[]
}[] {
  const rows = [...new Set(table.cells.map(cell => cell.row))].sort((a, b) => a - b)
  const width = table.cells.reduce((max, cell) => Math.max(max, cell.column + cell.columnSpan), table.columnCount ?? 0)
  return rows.map(row => {
    const slots = table.cells.filter(cell => cell.row <= row && cell.row + cell.rowSpan > row)
      .sort((a, b) => a.column - b.column)
    const cells: { column: number; columnSpan: number; rowSpan: number; value?: T }[] = []
    let column = 0
    for (const cell of slots) {
      if (cell.column > column) cells.push({ column, columnSpan: cell.column - column, rowSpan: 1 })
      if (cell.row === row) cells.push({ column: cell.column, columnSpan: cell.columnSpan,
        rowSpan: rows.filter(index => index >= row && index < row + cell.rowSpan).length, value: cell })
      column = Math.max(column, cell.column + cell.columnSpan)
    }
    if (column < width) cells.push({ column, columnSpan: width - column, rowSpan: 1 })
    return { row, cells }
  })
}
