// @vitest-environment jsdom
import { createElement, Fragment } from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { runInNewContext } from 'node:vm'
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
import { apply as applyQuotes } from '@deepseek-ai/dsh-message-quotes/src/client/index.ts'
import { guestReferenceHandlerScript } from '../../../../browser-reference/page-script.ts'
import { registerIframeReference, iframeReferenceSource } from '../../../browser/iframe-reference.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const primitives = await vi.importActual('@deepseek-ai/dsh-client-ui-primitives')
  const { formatQuoteText } = await import('@deepseek-ai/dsh-client-ui-primitives/src/markdown/quote-text.ts')
  const { QuotePreview } = await import('@deepseek-ai/dsh-client-ui-primitives/src/QuotePreview.tsx')
  const passthrough = ({ children }: { children?: unknown }) => createElement(Fragment, null, children)
  return { ...primitives, formatQuoteText, Tooltip: passthrough, HoverCardGroup: passthrough, UserMessageBubble: passthrough,
    UserTextRun: ({ text }: { text: string }) => createElement('span', { 'data-plain-run': '' }, text),
    ReferenceChip: passthrough, QuotePreview, ReferenceIconRegular: passthrough,
    FileTypeIcon: passthrough, JsonBlock: passthrough, fileExtension: () => '', fileSizeText: () => '',
    IconEditOutlineRegular: passthrough, IconLinkOutlineRegular: passthrough, IconTrashOutlineRegular: passthrough,
  }
})

const disposers: (() => void | Promise<void>)[] = []
afterEach(async () => { cleanup(); for (const dispose of disposers.splice(0).reverse()) await dispose(); vi.restoreAllMocks(); document.body.replaceChildren() })

it.each([[1, '', false], [1, '请用一句话总结我引用的内容', true], [10, '请用一句话总结我引用的内容', true], [1, '请用一句话总结我引用的内容', false]] as const)('web delivery inserts %i atomic host quotes, then sends %s with submission projection=%s and both builtin plugins', async (count, question, project) => {
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
  const rules: (typeof browserSourceRule)[] = []
  const services = { uiConversation: { userText: { register(rule: typeof browserSourceRule) { rules.push(rule); return () => {} } },
    interactions: { register: () => () => {} } } }
  const context: HostContext = {
    get: name => services[name as keyof typeof services], effect: fn => { const off = fn(); if (off) disposers.push(off) },
    slots: { inject: (_name, produce) => { const result = produce(); if (result?.[Symbol.iterator]) [...result] }, register: (registration, component) => {
      const { name, key } = registration as { name: string; key?: string }
      components.set(name === 'conversation.user.text.node' ? `${name}:${key}` : name, component as (props: unknown) => unknown)
    } },
  }
  applyQuotes({ ...context, ...services, locale: { register: () => () => {} }, sessions: {} } as never)
  const frame = document.createElement('iframe')
  document.body.append(frame)
  const guest = frame.contentWindow!
  guest.document.body.innerHTML = '<p>before selected words after</p>'
  vi.spyOn(guest.HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 100, right: 180, bottom: 120, width: 170, height: 20 } as DOMRect)
  Object.defineProperty(guest.Range.prototype, 'getClientRects', { value: () => [{ left: 10, top: 100, right: 180, bottom: 120, width: 170, height: 20 }] })
  vi.spyOn(guest, 'scrollTo').mockImplementation(() => {})
  const command = runInNewContext(`(${guestReferenceHandlerScript()})`, {
    window: guest, document: guest.document, NodeFilter: guest.NodeFilter, URL, location: guest.location,
  })
  disposers.push(registerIframeReference('sent-guest', 'sess-A', () => async (operation, spec) => command(operation, spec)))
  const reveals: object[] = []
  let deliveries: ReturnType<typeof makeDelivery>[] = []
  const runtime = apply(context, { initialSessionId: 'sess-A', request: async (url, init) => ({
    ok: true, status: 200, bytes: async () => new Uint8Array(),
    json: async () => {
      if (url.endsWith('/reveal')) {
        const request = JSON.parse(String(init?.body))
        reveals.push(request)
        const snapshot = deliveries.find(delivery => delivery.referenceId === request.referenceId)!.snapshot
        const status = await iframeReferenceSource('sent-guest', 'sess-A')!.reveal!(snapshot, undefined, new AbortController().signal)
        expect(status).toBe('revealed')
        return { ok: true, status }
      }
      return init?.method === 'POST' ? { ok: true } : { ok: true, sequence: deliveries.length, deliveries }
    },
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
      ...base.snapshot, referenceId: `ref-${index}`, owner: { sessionId: 'sess-A', sourcePageId: 'sent-guest' },
      source: { ...base.snapshot.source, title: 'HTML 列表 | 菜鸟教程', frameRoute: 'main' as const },
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
  const projected = content.flatMap(part => part.type === 'text' ? [part.text] : []).join('')
  expect(projected).toContain('<dsh-browser-quote length="')
  const message = project ? projected : serialized
  if (question) expect(message).not.toContain(`](d${question}sh-browser-ref:`)
  const userTextDocument = new UserTextDocument()
  const failures = vi.fn()
  const sent = render(createElement(UserContent, {
    content: { text: message, attachments: [], extraBlocks: [] }, facts: {}, interactive: true, t: (key: string) => key,
    renderFactorySlot: (_name, props) => createElement(UserText, { ...props,
      useUserTextRevision: () => 0, createUserTextEvaluator: () => input => userTextDocument.evaluate(input, [...rules].sort((a, b) => a.order - b.order)), reportTransformFailure: failures,
      renderSlot: (_slot, owner, options) => components.get(`conversation.user.text.node:${owner.node.id}`)?.(owner) ?? options.fallback,
    }),
  } as never))
  expect(failures).not.toHaveBeenCalled()
  expect(sent.container.querySelectorAll('[data-reference-id]')).toHaveLength(count)
  expect([...sent.container.querySelectorAll('[data-plain-run]')].map(node => node.textContent).join('').trim()).toBe(question)
  expect(sent.container.textContent).not.toContain('dsh-browser-ref:')
  expect(sent.container.querySelector('[data-quote-preview]')).toBeNull()
  const pill = sent.container.querySelector<HTMLButtonElement>('button[data-reference-id]')!
  fireEvent.mouseEnter(pill)
  await waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('selected words'))
  await act(async () => { pill.click() })
  expect(reveals).toEqual([{ referenceId: 'ref-0' }])
  expect(guest.getSelection()!.toString()).toBe('selected words')
  expect(guest.document.querySelector('#__dsh-ref-highlight')?.children.length).toBe(1)
})
