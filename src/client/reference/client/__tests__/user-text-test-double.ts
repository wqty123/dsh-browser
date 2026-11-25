/**
 * Lightweight test doubles for host conversation text parsing and composer quote
 * serialization, replacing deep `@deepseek-ai/*\/src/...` imports removed in DSH 0.2.3.
 */
import { createElement, Fragment, type ReactNode } from 'react'

export interface UserTextNodeLike {
  readonly id: string
  readonly start: number
  readonly end: number
  readonly data: Record<string, unknown>
}

export interface UserTextRuleLike {
  readonly id: string
  readonly order: number
  match(text: string, from: number, facts?: Record<string, unknown>): UserTextNodeLike | undefined
}

/** Minimal ordered non-overlapping user-text evaluator with memoization across identical inputs. */
export class UserTextDocument {
  private lastText: string | undefined
  private lastRules: readonly UserTextRuleLike[] | undefined
  private lastNodes: UserTextNodeLike[] | undefined

  evaluate(
    input: { readonly text: string; readonly facts: Record<string, unknown> },
    rules: readonly UserTextRuleLike[],
  ): UserTextNodeLike[] {
    if (
      this.lastNodes !== undefined
      && this.lastText === input.text
      && this.lastRules !== undefined
      && this.lastRules.length === rules.length
      && this.lastRules.every((rule, index) => rule === rules[index])
    ) {
      return this.lastNodes
    }
    const text = input.text
    const nodes: UserTextNodeLike[] = []
    let cursor = 0
    while (cursor < text.length) {
      let best: { node: UserTextNodeLike; order: number } | undefined
      for (const rule of rules) {
        const match = rule.match(text, cursor, input.facts)
        if (match === undefined || match.start < cursor || match.end <= match.start) continue
        if (
          best === undefined
          || match.start < best.node.start
          || (match.start === best.node.start && rule.order < best.order)
        ) {
          best = { node: match, order: rule.order }
        }
      }
      if (best === undefined) {
        nodes.push({ id: 'text', start: cursor, end: text.length, data: { text: text.slice(cursor) } })
        break
      }
      if (best.node.start > cursor) {
        nodes.push({ id: 'text', start: cursor, end: best.node.start, data: { text: text.slice(cursor, best.node.start) } })
      }
      nodes.push(best.node)
      cursor = best.node.end
    }
    this.lastText = text
    this.lastRules = [...rules]
    this.lastNodes = nodes
    return nodes
  }
}

/** Minimal generic blockquote rule matching host `dsh-message-quotes` ordering (`order: 0`). */
export const quoteRule: UserTextRuleLike = {
  id: 'quote',
  order: 0,
  match(text, from) {
    let cursor = from
    while (cursor < text.length) {
      const lineStart = cursor === 0 || text[cursor - 1] === '\n' ? cursor : text.indexOf('\n', cursor) + 1
      if (lineStart <= 0 && cursor > 0) return undefined
      const lineEnd = text.indexOf('\n', lineStart)
      const end = lineEnd === -1 ? text.length : lineEnd
      const line = text.slice(lineStart, end)
      if (/^ {0,3}>/u.test(line)) {
        let blockEnd = end
        while (blockEnd < text.length) {
          const nextStart = blockEnd + 1
          const nextEnd = text.indexOf('\n', nextStart)
          const resolvedEnd = nextEnd === -1 ? text.length : nextEnd
          const nextLine = text.slice(nextStart, resolvedEnd)
          if (!/^ {0,3}>/u.test(nextLine)) break
          blockEnd = resolvedEnd
        }
        return {
          id: 'quote',
          start: lineStart,
          end: blockEnd,
          data: { text: text.slice(lineStart, blockEnd) },
        }
      }
      if (lineEnd === -1) return undefined
      cursor = lineEnd + 1
    }
    return undefined
  },
}

export interface DraftQuoteEntry {
  readonly text: string
}

/** Minimal composer editor double supporting atomic quote pills, plain text typing, and DOM reflection. */
export class TestDraftEditorRuntime {
  private root: HTMLElement | null = null
  private readonly quotesList: DraftQuoteEntry[] = []
  private tailText = ''
  private readonly onUpdate?: () => void

  constructor(options: { readonly onUpdate?: () => void } = {}) {
    this.onUpdate = options.onUpdate
  }

  register(): () => void {
    return () => {
      if (this.root !== null) this.root.replaceChildren()
      this.root = null
    }
  }

  readonly editor = {
    setRootElement: (element: HTMLElement | null): void => {
      this.root = element
      this.syncDom()
    },
  }

  setDraft(text: string): void {
    this.quotesList.length = 0
    this.tailText = text
    this.syncDom()
    this.onUpdate?.()
  }

  insertQuote(text: string): void {
    this.quotesList.push({ text })
    this.syncDom()
    this.onUpdate?.()
  }

  insertPlainText(text: string): void {
    this.tailText += text
    this.syncDom()
    this.onUpdate?.()
  }

  insertAsyncText(_span: unknown, text: string): void {
    this.tailText += text
    this.syncDom()
    this.onUpdate?.()
  }

  refreshProjection(): void {
    this.syncDom()
  }

  get projection(): {
    readonly quotes: readonly DraftQuoteEntry[]
    readonly clipboardText: string
    readonly detectText: string
    readonly caret: number
    readonly selection: { readonly start: number; readonly end: number }
  } {
    const quoted = this.quotesList.map(quote => quote.text.split('\n').map(line => `> ${line}`).join('\n')).join('\n\n')
    const clipboardText = quoted === '' ? this.tailText : this.tailText === '' ? quoted : `${quoted}\n\n${this.tailText}`
    const detectText = clipboardText
    const caret = detectText.length
    return {
      quotes: [...this.quotesList],
      clipboardText,
      detectText,
      caret,
      selection: { start: caret, end: caret },
    }
  }

  private syncDom(): void {
    if (this.root === null) return
    this.root.replaceChildren()
    for (const quote of this.quotesList) {
      const node = document.createElement('span')
      node.setAttribute('data-composer-quote', '')
      node.setAttribute('contenteditable', 'false')
      node.textContent = quote.text
      this.root.append(node)
    }
    if (this.tailText !== '') {
      const span = document.createElement('span')
      span.textContent = this.tailText
      this.root.append(span)
    }
  }
}

export async function serializeDraftPrompt(
  draft: { readonly text: string; readonly references: readonly unknown[]; readonly quotes: readonly DraftQuoteEntry[] },
): Promise<string> {
  return draft.text
}

export function TestUserContent(props: {
  readonly text: string
  readonly rules: readonly UserTextRuleLike[]
  readonly renderNode: (owner: { readonly node: UserTextNodeLike; readonly raw: string }) => ReactNode | undefined
}): ReactNode {
  const nodes = new UserTextDocument().evaluate({ text: props.text, facts: {} }, [...props.rules].sort((a, b) => a.order - b.order))
  return createElement(Fragment, null, ...nodes.map((node, index) => {
    const raw = props.text.slice(node.start, node.end)
    if (node.id === 'text') {
      const display = (node.data.display ?? node.data.text ?? raw) as string
      return createElement('span', { key: index, 'data-plain-run': '' }, display)
    }
    const rendered = props.renderNode({ node, raw })
    return createElement(Fragment, { key: index }, rendered ?? createElement('span', { 'data-plain-run': '' }, raw))
  }))
}
