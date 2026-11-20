// @vitest-environment jsdom
import { createElement, Fragment } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { $getSelection, $isRangeSelection } from 'lexical'
import { DraftEditorRuntime } from '@deepseek-ai/dsh-client-ui-conversation/src/client/input/editor/runtime.ts'
import { serializeDraftPrompt } from '@deepseek-ai/dsh-client-ui-conversation/src/client/input/prompt.ts'
import { UserText } from '@deepseek-ai/dsh-client-ui-conversation/src/client/user-text/UserText.tsx'
import { UserTextDocument } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation/user-text-document.ts'
import { UserContent } from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/UserContent.tsx'
import { apply } from '../plugin.ts'
import type { HostContext } from '../production/assembly.ts'
import { browserSourceRule } from '../production/user-text-rule.ts'
import { makeDelivery, manualScheduler, memoryKV } from './production.fixtures.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const primitives = await vi.importActual('@deepseek-ai/dsh-client-ui-primitives')
  const { formatQuoteText } = await import('@deepseek-ai/dsh-client-ui-primitives/src/markdown/quote-text.ts')
  const passthrough = ({ children }: { children?: unknown }) => createElement(Fragment, null, children)
  return { ...primitives, formatQuoteText, Tooltip: passthrough, HoverCardGroup: passthrough, UserMessageBubble: passthrough,
    UserTextRun: ({ text }: { text: string }) => createElement('span', { 'data-plain-run': '' }, text),
    ReferenceChip: passthrough, QuotePreview: passthrough, ReferenceIconRegular: passthrough,
    FileTypeIcon: passthrough, JsonBlock: passthrough, fileExtension: () => '', fileSizeText: () => '',
    IconEditOutlineRegular: passthrough, IconLinkOutlineRegular: passthrough, IconTrashOutlineRegular: passthrough,
  }
})

const disposers: (() => void | Promise<void>)[] = []
afterEach(async () => { cleanup(); for (const dispose of disposers.splice(0).reverse()) await dispose(); document.body.replaceChildren() })

it.each([[1, ''], [1, '请用一句话总结我引用的内容'], [10, '请用一句话总结我引用的内容']] as const)('web delivery inserts %i atomic host quote nodes, then sends %s through the real host renderer without editable source links', async (count, question) => {
  let editor!: DraftEditorRuntime
  editor = new DraftEditorRuntime({ onUpdate: () => { editor.refreshProjection() }, quoteLabels: () => ({ remove: 'Remove' }),
    openReference: () => false, lexicon: () => new Map(), resolveLexicon: () => undefined })
  disposers.push(editor.register())
  const editable = document.createElement('div')
  editable.contentEditable = 'true'
  document.body.append(editable)
  editor.editor.setRootElement(editable)
  editor.setDraft('')
  const components = new Map<string, (props: unknown) => unknown>()
  let sourceRule: typeof browserSourceRule | undefined
  const services = { uiConversation: { userText: { register(rule: typeof browserSourceRule) { sourceRule = rule; return () => {} } } } }
  const context: HostContext = {
    get: name => services[name as keyof typeof services], effect: fn => { const off = fn(); if (off) disposers.push(off) },
    slots: { inject: (_name, produce) => { [...produce()] }, register: (registration, component) => {
      components.set((registration as { name: string }).name, component as (props: unknown) => unknown)
    } },
  }
  let deliveries: ReturnType<typeof makeDelivery>[] = []
  const runtime = apply(context, { initialSessionId: 'sess-A', request: async (_url, init) => ({
    ok: true, status: 200, bytes: async () => new Uint8Array(),
    json: async () => init?.method === 'POST' ? { ok: true } : { ok: true, sequence: deliveries.length, deliveries },
  }), scheduler: manualScheduler(), storage: memoryKV() })
  disposers.push(() => runtime.dispose())
  // Bind the real production plugin's Session-scoped dock to the host's editor actions.
  const insertText = vi.fn((text, span) => editor.insertAsyncText(span, text))
  const insertReference = vi.fn(() => { throw new Error('the host quote API is available') })
  const actions = {
    captureInsertion: () => ({ start: editor.projection.selection?.start ?? 0, end: editor.projection.selection?.end ?? 0, draftRev: 1 }),
    insertText, insertReference, persistDraft() {}, insertQuote: (text: string) => editor.insertQuote(text, { remove: 'Remove' }),
  }
  const input = { get draft() { return editor.projection.clipboardText } }
  await act(async () => { render(components.get('conversation.input.dock')!({ sessionId: 'session-sess-A', input, inputActions: actions }) as never) })
  deliveries = Array.from({ length: count }, (_, index) => {
    const base = makeDelivery({ state: 'acknowledged', sequence: index + 1 })
    return { ...base, intentId: `intent-${index}`, referenceId: `ref-${index}`, requiredAssets: [], snapshot: {
      ...base.snapshot, referenceId: `ref-${index}`, source: { ...base.snapshot.source, title: 'HTML 列表 | 菜鸟教程' },
      parts: [{ partId: 'text', type: 'text' as const, text: 'selected words', anchor: { exact: 'selected words', prefix: '', suffix: '' } }],
    } }
  })
  // The HTTP seam is injected without replacing delivery processing or editor insertion.
  await act(async () => { await runtime.pollOnce() })
  expect(editable.querySelectorAll('[data-composer-quote][contenteditable="false"]')).toHaveLength(count)
  expect(insertText).not.toHaveBeenCalled()
  expect(insertReference).not.toHaveBeenCalled()
  expect(editor.projection.caret).toBe(editor.projection.detectText.length)
  editor.editor.update(() => {
    const selection = $getSelection()
    expect($isRangeSelection(selection)).toBe(true)
    if ($isRangeSelection(selection) && question) selection.insertText(question)
  }, { discrete: true })
  editor.refreshProjection()
  expect(editor.projection.quotes).toHaveLength(count)
  if (question) expect(editor.projection.quotes.every(quote => !quote.text.includes(question))).toBe(true)
  const serialized = await serializeDraftPrompt({ text: editor.projection.clipboardText, references: [], quotes: editor.projection.quotes }, async () => '')
  const content = runtime.submission.buildContent({ sessionId: 'sess-A', uploaded: [], text: serialized, requestId: 'send' })
  await runtime.submission.commit('sess-A', 'send')
  const message = content.flatMap(part => part.type === 'text' ? [part.text] : []).join('')
  expect(message).toContain('<dsh-browser-quote length="')
  if (question) expect(message).not.toContain(`](d${question}sh-browser-ref:`)
  const userTextDocument = new UserTextDocument()
  const failures = vi.fn()
  const sent = render(createElement(UserContent, {
    content: { text: message, attachments: [], extraBlocks: [] }, facts: {}, interactive: true, t: (key: string) => key,
    renderFactorySlot: (_name, props) => createElement(UserText, { ...props,
      useUserTextRevision: () => 0, createUserTextEvaluator: () => input => userTextDocument.evaluate(input, [sourceRule!]), reportTransformFailure: failures,
      renderSlot: (_slot, owner, options) => owner.node.id === 'browser-ref' ? components.get('conversation.user.text.node')!(owner) : options.fallback,
    }),
  } as never))
  expect(failures).not.toHaveBeenCalled()
  expect(sent.container.querySelectorAll('[data-reference-id]')).toHaveLength(count)
  expect([...sent.container.querySelectorAll('[data-plain-run]')].map(node => node.textContent).join('').trim()).toBe(question)
  expect(sent.container.textContent).not.toContain('dsh-browser-ref:')
})
