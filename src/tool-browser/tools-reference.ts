/**
 * Reference tools: capture, reveal and list what the human selected in the page.
 * @module dsh-browser/tool-browser/tools-reference
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { createReferenceService, summarizeReference, type BrowserReferenceService } from '../browser-reference/service.ts'
import type { BrowserReferenceCarrier } from '../browser-reference/types.ts'
import { resolveSessionHandle, sessionWireId } from '../browser/handles.ts'
import { agentOf, taskKey, ensureSession, type ToolScope, type ToolDefinition } from './state.ts'

/**
 * Define this module's tools for one apply.
 * @param scope - the apply's context, settings and per-apply state.
 * @returns the tool definitions, for the entry to register.
 */
export function referenceTools(scope: ToolScope): ToolDefinition[] {
  const { ctx, state, settingsStore, timeoutMs } = scope
  const tools: ToolDefinition[] = []

  // Built on first use, not at apply time: the provider is registered by another plugin's apply,
  // and a tool registered before the browser exists must still work once it does.
  let referenceService: BrowserReferenceService | undefined
  const references = (): BrowserReferenceService => {
    if (referenceService !== undefined) return referenceService
    const browser = ctx.get('browser')
    if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
    // Keep the SAME image fallback as the floating bar and the HTTP capture
    // (browser-electron/entry.ts): a clipped visible-region read lets an image
    // whose source URL cannot be downloaded still become a real reference.
    referenceService = createReferenceService(browser, {
      visibleCapture: async (sessionId, clip, signal) => {
        const shot = await browser.screenshot(sessionWireId(resolveSessionHandle(sessionId)), { clip, format: 'png' }, signal)
        return { dataUrl: shot.dataUrl, mime: 'image/png' }
      },
    })
    return referenceService
  }
  const referenceCarrier = (): BrowserReferenceCarrier => {
    const channel = settingsStore.get().browser.channel
    return channel === 'sidebar' || channel === 'chrome' || channel === 'edge' ? channel : 'bundled'
  }

  tools.push(defineTool({
    name: 'dsh_browser_reference_capture',
    description: 'Capture what the human has selected in the shared-browser page as a durable reference, so it can be quoted and found again later. The reference keeps the selected text with enough surrounding context to relocate it, any images selected with their real bytes, and any table as a structural snapshot. Tool-only captures are stored for later dsh_browser_reference_reveal or export and do not create a chat capsule; do not emit dsh-browser-ref: URIs, reference markers, or synthetic source links in the reply. Re-capturing the same region creates a NEW reference, because a stored reference is an immutable snapshot.',
    parameters: {
      allowPartial: { type: 'boolean', description: 'Commit the fragments that succeeded when another fragment failed (default false: a group with a broken image or oversized table is refused as a whole).' },
      tableSelector: { type: 'string', description: 'Capture this table whole (CSS selector) even when the selection does not touch it.' },
      excerptText: { type: 'string', description: 'With no live selection, register the first occurrence of this exact page text as an agent excerpt. Two occurrences make it ambiguous and are refused.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          referenceId: { type: 'string' },
          pageUrl: { type: 'string' },
          title: { type: 'string' },
          parts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                partId: { type: 'string', required: true },
                type: { type: 'string', required: true },
                preview: { type: 'string', required: true },
              },
            },
          },
          failures: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true },
                reason: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.ok !== true) {
          const reasons = value.failures.map(failure => `${failure.kind}: ${failure.reason}`).join('; ')
          return [{ type: 'text', text: `Nothing was captured. ${reasons}` }]
        }
        const lines = [
          `Reference ${value.referenceId} captured from ${value.title !== undefined && value.title !== '' ? value.title : value.pageUrl}.`,
          'Stored in the reference library for dsh_browser_reference_reveal or export (tool-only captures do not create a chat capsule). Do not emit dsh-browser-ref: URIs or reference markers in the reply.',
          ...value.parts.map(part => `  ${part.partId} (${part.type}): ${part.preview}`),
        ]
        if (value.failures.length > 0) lines.push(`(${value.failures.length} fragment(s) failed and were left out: ${value.failures.map(failure => failure.reason).join('; ')})`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const outcome = await references().capture({
        // The DSH session owns the reference; the provider session holds the page. They are
        // different ids, and reveal needs the second one even after the first is long gone.
        sessionId: taskKey(exec),
        browserSessionId: session,
        origin: args.excerptText !== undefined ? 'agent-excerpt' : 'user-selection',
        entry: 'agent-tool',
        carrier: state.panelUrlByTask.has(taskKey(exec)) ? 'sidebar' : referenceCarrier(),
        ...args.allowPartial !== undefined ? { allowPartial: args.allowPartial } : {},
        ...args.tableSelector !== undefined ? { tableSelector: args.tableSelector } : {},
        ...args.excerptText !== undefined ? { excerptText: args.excerptText } : {},
      }, exec.signal)
      const failures = outcome.failures.map(failure => ({ kind: failure.kind, reason: failure.reason }))
      if (outcome.reference === undefined) return { ok: false, parts: [], failures }
      const summary = summarizeReference(outcome.reference)
      return {
        ok: true,
        referenceId: summary.referenceId,
        pageUrl: summary.pageUrl,
        title: summary.title,
        // The summary's arrays are readonly; the schema declares a mutable array,
        // so the parts are projected into plain objects rather than cast away.
        parts: summary.parts.map(part => ({ partId: part.partId, type: part.type, preview: part.preview })),
        failures,
      }
    },
  }))

  tools.push(defineTool({
    name: 'dsh_browser_reference_reveal',
    description: 'Return to a stored browser reference: select the browser session that captured it, verify the page is still the same one, then scroll to and highlight the part. Without partId the reference\'s first part is located; pass a partId to locate one specific fragment. A result status of page-mismatch means the session is showing another page (open the stored pageUrl first); ambiguous means several candidates matched equally and the exact one cannot be chosen; session-unavailable means the browser that captured it is gone.',
    parameters: {
      referenceId: { type: 'string', required: true, description: 'The reference id, with or without the dsh-browser-ref: prefix.' },
      partId: { type: 'string', description: 'Locate this fragment instead of the whole reference\'s first part.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          pageUrl: { type: 'string', required: true },
          currentUrl: { type: 'string' },
          note: { type: 'string' },
          parts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                partId: { type: 'string', required: true },
                type: { type: 'string', required: true },
                status: { type: 'string', required: true },
                matches: { type: 'number' },
                collapsed: { type: 'boolean' },
                note: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const head = value.status === 'revealed'
          ? 'Located the reference in the page.'
          : `Could not locate the reference: ${value.status}${value.note !== undefined ? ` — ${value.note}` : ''}`
        const lines = [head, ...value.parts.map(part => `  ${part.partId} (${part.type}): ${part.status}${part.matches !== undefined ? `, ${part.matches} match(es)` : ''}${part.collapsed === true ? ', whitespace-collapsed' : ''}${part.note !== undefined ? ` — ${part.note}` : ''}`)]
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      // The documented citation form is `dsh-browser-ref:<referenceId>/<partId?>`; accept it
      // whole so a model can paste what it wrote instead of splitting the id by hand.
      let referenceId = args.referenceId.startsWith('dsh-browser-ref:') ? args.referenceId.slice('dsh-browser-ref:'.length) : args.referenceId
      let partId = args.partId
      const slash = referenceId.indexOf('/')
      if (slash !== -1) {
        if (partId === undefined) partId = referenceId.slice(slash + 1)
        referenceId = referenceId.slice(0, slash)
      }
      const outcome = await references().reveal(referenceId, {
        ownerSessionId: taskKey(exec),
        ...partId !== undefined && partId !== '' ? { partId } : {},
      }, exec.signal)
      return {
        status: outcome.status,
        pageUrl: outcome.pageUrl,
        ...outcome.currentUrl !== undefined ? { currentUrl: outcome.currentUrl } : {},
        ...outcome.note !== undefined ? { note: outcome.note } : {},
        parts: outcome.parts.map(part => ({
          partId: part.partId,
          type: part.type,
          status: part.status,
          ...part.matches !== undefined ? { matches: part.matches } : {},
          ...part.collapsed !== undefined ? { collapsed: part.collapsed } : {},
          ...part.note !== undefined ? { note: part.note } : {},
        })),
      }
    },
  }))

  tools.push(defineTool({
    name: 'dsh_browser_reference_list',
    description: 'List the browser references stored for this task, newest first: id, page, capture time, and one preview line per fragment. Use it to identify a reference from earlier in the conversation. Source navigation is provided by reference capsules; do not repeat reference URIs, source URLs, markers, or source/citation links in the reply.',
    parameters: {
      limit: { type: 'number', description: 'Most references to return (default 20, maximum 100).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          references: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                referenceId: { type: 'string', required: true },
                title: { type: 'string', required: true },
                pageUrl: { type: 'string', required: true },
                capturedAt: { type: 'string', required: true },
                carrier: { type: 'string', required: true },
                origin: { type: 'string', required: true },
                entry: { type: 'string', required: true },
                partCount: { type: 'number', required: true },
                parts: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      partId: { type: 'string', required: true },
                      type: { type: 'string', required: true },
                      preview: { type: 'string', required: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.references.length === 0) return [{ type: 'text', text: 'No browser references are stored for this task.' }]
        return [{
          type: 'text',
          text: value.references.map(reference => [
            `Reference ${reference.referenceId} — ${reference.title !== '' ? reference.title : reference.pageUrl} (${reference.capturedAt}); source navigation is in its capsule, not a reply link.`,
            ...reference.parts.map(part => `  ${part.partId} (${part.type}): ${part.preview}`),
          ].join('\n')).join('\n\n'),
        }]
      },
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const key = taskKey(exec)
      const limit = Math.min(Math.max(Math.trunc(args.limit ?? 20), 1), 100)
      // Always scoped: with no agent the key is `default`, and an unfiltered read
      // would hand this task every conversation's references.
      const stored = references().list({ sessionId: key, limit })
      return {
        references: stored.slice().reverse().map(reference => {
          const summary = summarizeReference(reference)
          return {
            referenceId: summary.referenceId,
            title: summary.title,
            pageUrl: summary.pageUrl,
            capturedAt: summary.capturedAt,
            carrier: summary.carrier,
            origin: summary.origin,
            entry: summary.entry,
            partCount: summary.partCount,
            parts: summary.parts.map(part => ({ partId: part.partId, type: part.type, preview: part.preview })),
          }
        }),
      }
    },
  }))

  return tools
}
