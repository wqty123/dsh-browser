export const MAX_REFERENCE_TEXT = 20_000

export type ReferenceTextNode =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'break' }
  | { readonly type: 'block' | 'paragraph' | 'strong' | 'emphasis' | 'code' | 'pre' | 'list-item' | 'blockquote'; readonly children: readonly ReferenceTextNode[] }
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
    if (node.type === 'break') return true
    if (!['block', 'paragraph', 'strong', 'emphasis', 'code', 'pre', 'list-item', 'blockquote', 'link', 'list'].includes(node.type)) return false
    if (node.type === 'link' && (typeof node.href !== 'string' || node.href.length > 4000 || !/^https?:\/\//iu.test(node.href))) return false
    if (node.type === 'list' && (typeof node.ordered !== 'boolean' || !Number.isSafeInteger(node.start) || node.start < 0 || node.start > 1_000_000)) return false
    return visit(node.children, depth + 1)
  })
  return visit(value, 0)
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]<>!|#]/gu, '\\$&')
}

export function referenceTextContent(nodes: readonly ReferenceTextNode[]): string {
  return nodes.map(node => node.type === 'text' ? node.text : node.type === 'break' ? '\n' : referenceTextContent(node.children)).join('')
}

/** The host accepts text content parts; encode the frozen semantics as Markdown. */
export function renderReferenceText(nodes: readonly ReferenceTextNode[]): string {
  const render = (items: readonly ReferenceTextNode[]): string => {
    let result = ''
    for (const node of items) {
      const text = renderNode(node)
      if (['block', 'paragraph', 'pre', 'blockquote', 'list'].includes(node.type)) {
        if (result && !result.endsWith('\n\n')) result += result.endsWith('\n') ? '\n' : '\n\n'
        result += `${text}\n\n`
      } else result += text
    }
    return result
  }
  const renderNode = (node: ReferenceTextNode): string => {
    if (node.type === 'text') return escapeMarkdown(node.text)
    if (node.type === 'break') return '  \n'
    if (node.type === 'code' || node.type === 'pre') {
      const text = referenceTextContent(node.children)
      const size = Math.max(node.type === 'pre' ? 3 : 1, ...[...text.matchAll(/`+/gu)].map(match => match[0].length + 1))
      const fence = '`'.repeat(size)
      return node.type === 'pre' ? `${fence}\n${text}\n${fence}` : `${fence} ${text} ${fence}`
    }
    const text = render(node.children)
    switch (node.type) {
      case 'block':
      case 'paragraph': return text.trim()
      case 'strong': return `**${text}**`
      case 'emphasis': return `*${text}*`
      case 'link': return `[${text}](${node.href.replace(/[\s()<>\\]/gu, char => encodeURIComponent(char).replace(/[()]/gu, token => `%${token.charCodeAt(0).toString(16).toUpperCase()}`))})`
      case 'blockquote': return text.trim().split('\n').map(line => `> ${line}`).join('\n')
      case 'list-item': return text
      case 'list': return node.children.map((child, index) => {
        const prefix = node.ordered ? `${node.start + index}. ` : '- '
        const lines = render([child]).trim().split('\n')
        return prefix + lines.join(`\n${' '.repeat(prefix.length)}`)
      }).join('\n')
    }
  }
  return render(nodes).trim()
}

export interface ReferenceTable {
  readonly cells: readonly {
    readonly row: number
    readonly column: number
    readonly rowSpan: number
    readonly columnSpan: number
    readonly role: 'header' | 'data'
    readonly text: string
  }[]
  readonly caption?: string
}

export function isReferenceTable(value: unknown): value is ReferenceTable {
  if (typeof value !== 'object' || value === null) return false
  const table = value as ReferenceTable
  return (table.caption === undefined || (typeof table.caption === 'string' && table.caption.length <= MAX_REFERENCE_TEXT))
    && Array.isArray(table.cells) && table.cells.length <= 20_000
    && table.cells.every(cell => cell && typeof cell.text === 'string' && cell.text.length <= MAX_REFERENCE_TEXT
      && (cell.role === 'header' || cell.role === 'data')
      && [cell.row, cell.column].every(n => Number.isSafeInteger(n) && n >= 0)
      && [cell.rowSpan, cell.columnSpan].every(n => Number.isSafeInteger(n) && n > 0))
}

export function renderReferenceTable(table: ReferenceTable): string {
  const escape = (text: string): string => text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/\r?\n/gu, '<br>')
  const rows = new Map<number, ReferenceTable['cells'][number][]>()
  for (const cell of table.cells) {
    const row = rows.get(cell.row) ?? []
    row.push(cell)
    rows.set(cell.row, row)
  }
  const caption = table.caption === undefined ? '' : `<caption>${escape(table.caption)}</caption>\n`
  return `<table>\n${caption}${[...rows].sort(([a], [b]) => a - b).map(([, cells]) => `<tr>${cells.sort((a, b) => a.column - b.column).map(cell => {
    const tag = cell.role === 'header' ? 'th' : 'td'
    return `<${tag} rowspan="${cell.rowSpan}" colspan="${cell.columnSpan}">${escape(cell.text)}</${tag}>`
  }).join('')}</tr>`).join('\n')}\n</table>`
}
