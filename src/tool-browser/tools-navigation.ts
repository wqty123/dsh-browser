/**
 * Navigation, tab, history, session and start-page shortcut tools.
 * @module dsh-browser/tool-browser/tools-navigation
 */

import { setLastOpen } from '../browser-electron/open-slot.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createShortcutStore, type ShortcutSettings } from '../browser-electron/startpage-shortcuts.ts'
import type { BrowserSessionId } from '../browser/types.ts'
import { browserSessionHandle, resolveTabHandle, scopedTabs, sessionWireId, tabWireId } from '../browser/handles.ts'
import { ELEMENT_ITEM_SCHEMA, projectElement } from './element-fields.ts'
import { readSurface, enforceSurface, assertSurfaceCanHost, assertAllowed, agentOf, taskKey, rememberSession, ensureSession, panelBound, type ToolScope, type ToolDefinition } from './state.ts'
import { formatSnapshot } from './tools-observation.ts'

/**
 * Refuse the bare DSH web root, which answers 401 and looks like a real page.
 *
 * The address comes from `DSH_WEB_URL`, which the harness exports to its children — NOT from a
 * hardcoded port. This machine's GUI has run on 3080 and on 19387, so a number would stop matching
 * exactly when the guard is needed, and the trap is not a port anyway: it is the SHAPE. A loopback
 * address at its root with no token renders as an unauthenticated 401 page, which an agent reads
 * as the site it meant to open.
 * @param rawUrl - the address a caller asked to open.
 */
export function assertNotBareDshWebUrl(rawUrl: string): void {
  const advertised = process.env.DSH_WEB_URL
  if (typeof advertised !== 'string' || advertised === '') return
  let target: URL
  let dsh: URL
  try {
    target = new URL(rawUrl)
    dsh = new URL(advertised)
  } catch {
    return // not a URL this guard can judge; the provider's own admission is the next gate
  }
  if (target.origin !== dsh.origin) return
  if (target.pathname !== '/') return
  // The authenticated URL printed by `dsh web` carries a token; the bare root does not.
  if (target.searchParams.has('token')) return
  throw new Error(
    'dsh_browser_open: refusing the bare DSH web root (' + dsh.origin + '/) because it carries no '
    + 'authentication token, so it answers with a 401 page that reads like a real site. Open the '
    + 'target site instead; to open DSH itself, use the authenticated URL printed by `dsh web`.',
  )
}

/**
 * Define this module's tools for one apply.
 * @param scope - the apply's context, settings and per-apply state.
 * @returns the tool definitions, for the entry to register.
 */
export function navigationTools(scope: ToolScope): ToolDefinition[] {
  const { ctx, config, state, timeoutMs, maxWaitMs, surface } = scope
  const tools: ToolDefinition[] = []

  // The start page's shared shortcut list, reached through the settings section the
  // sidebar edits. Built lazily for the same reason `references()` is: the settings
  // service is registered by another entry and may not exist yet at apply time.
  const startpageShortcuts = createShortcutStore(() => ctx.get('settings') as unknown as ShortcutSettings | undefined)

  tools.push(defineTool({
    name: 'dsh_browser_shortcuts',
    description: 'Read or edit the Sidebar Browser start page shortcuts — the shared website entries a human sees on an empty tab. action=list returns them, action=add appends one (title + http(s) url required, http:// or https:// only, at most 48 entries), action=remove drops one by id. The list is shared with the sidebar UI: an entry added here appears on the next empty tab for every conversation, and one a human adds appears here.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'add', 'remove'], description: 'list the shortcuts, add one, or remove one by id.' },
      title: { type: 'string', description: 'Display title (add). At most 80 characters.' },
      url: { type: 'string', description: 'Destination (add): a full http:// or https:// address.' },
      id: { type: 'string', description: 'Shortcut id (remove), as returned by list or add.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          shortcuts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                url: { type: 'string', required: true },
                iconKey: { type: 'string' },
              },
            },
          },
          changed: { type: 'string', description: 'What the call changed: added <id>, removed <id>, or empty for list.' },
        },
      },
      render: (_args, value) => {
        const rows = value.shortcuts as Array<{ id: string; title: string; url: string }>
        const changed = typeof value.changed === 'string' && value.changed !== '' ? `${value.changed}\n` : ''
        const body = rows.length === 0
          ? '(the start page has no shortcuts)'
          : rows.map(row => `- ${row.title} -> ${row.url}  [${row.id}]`).join('\n')
        return [{ type: 'text', text: `${changed}${rows.length} shortcut(s):\n${body}` }]
      },
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_shortcuts', taskKey(exec))
      try {
        if (args.action === 'list') {
          const reading = startpageShortcuts.list()
          return { shortcuts: reading.shortcuts.map(row => ({ ...row })), changed: '' }
        }
        if (args.action === 'add') {
          const result = await startpageShortcuts.add({ title: args.title, url: args.url })
          return { shortcuts: result.shortcuts.map(row => ({ ...row })), changed: `added ${result.shortcut.id}` }
        }
        if (typeof args.id !== 'string' || args.id === '') throw new Error('remove needs the shortcut id')
        const result = await startpageShortcuts.remove(args.id)
        return {
          shortcuts: result.shortcuts.map(row => ({ ...row })),
          changed: result.removed ? `removed ${args.id}` : `${args.id} was not in the list`,
        }
      } catch (error) {
        // The store reports refusals as typed errors; a tool must not answer with a stack.
        throw new Error(`start page shortcuts: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }))

  tools.push(defineTool({
    name: 'dsh_browser_open',
    description: 'Open a URL on the selected controllable surface (default: panel). Success returns a live snapshot and supports subsequent browser tools on that same page. A Web iframe or unavailable desktop bridge is refused; no manual-only navigation is queued. Reading tools never start another browser. newTab is optional on CDP surfaces. Never treat the bare DSH host (e.g. http://127.0.0.1:<port>/) as the target — it needs the authenticated URL printed by `dsh web`, and the bare root is refused.',
    parameters: {
      url: { type: 'string', required: true, description: 'The URL to open (HTTP/HTTPS).' },
      newTab: { type: 'boolean', description: 'Open in a new tab instead of the active one.' },
      // Explicit per-call surface. "panel" (default) places the page in the DSH sidebar and opens no
      // window; "builtin" drives the plugin's own browser, which is what debugging DSH itself needs.
      surface: { type: 'string', enum: ['panel', 'builtin'], description: 'panel (default): the DSH sidebar only; builtin: the plugin browser, for debugging DSH itself.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          title: { type: 'string' },
          carrier: { type: 'string' },
          truncated: { type: 'boolean' },
          elements: {
            type: 'array',
            required: true,
            // Same shared item schema as dsh_browser_open's, so the two cannot drift apart.
            items: ELEMENT_ITEM_SCHEMA,
          },
          challenge: {
            type: 'object',
            additionalProperties: false,
            properties: {
              blocked: { type: 'boolean', required: true },
              kind: { type: 'string' },
              reason: { type: 'string' },
            },
          },
        },
      },
      // dsh_browser_open is an overview of what just loaded, not a locator: it has no
      // `coords` parameter, so coordinates stay off here (dsh_browser_snapshot owns
      // that switch for callers that actually target pixels).
      render: (_args, value) => [{ type: 'text', text: formatSnapshot(value, {}) }],
    },
    timeoutMs,
    isConcurrencySafe: () => false, // opens tabs / navigates; exclusive within a task
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_open', taskKey(exec))
      assertNotBareDshWebUrl(args.url)
      // ONE surface per open. On the Web shell the reader's sidebar is the browsing surface; opening the
      // plugin's own browser as well produced two live views of the same page (reported as "you opened the
      // built-in browser AND the sidebar at once"). `browser.surface` decides: "panel" (default on Web)
      // places the page in the sidebar and opens no window; "builtin" is the debugging surface.
      const surfaceHint = (args as { surface?: 'panel' | 'builtin' }).surface
      const surface = enforceSurface(surfaceHint ?? readSurface(), args.url)
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const key = taskKey(exec)
      if (surface === 'panel') {
        const preceding = state.pendingPanelOpens.get(key)
        let previous: BrowserSessionId | undefined
        let session: BrowserSessionId | undefined
        const opening = (async () => {
          await preceding
          await state.pendingOpens.get(key)
          previous = state.sessionsByTask.get(key)
          const target = new URL(args.url)
          if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('dsh_browser_open: panel requires an HTTP/HTTPS URL')
          exec.signal?.throwIfAborted()
          session = panelBound(state, key) && previous !== undefined && browser.exists(previous)
            ? previous : await browser.openPanel?.(key)
          if (session === undefined) {
            assertSurfaceCanHost(surface, args.url)
            exec.signal?.throwIfAborted()
            setLastOpen(args.url, Date.now(), key)
            rememberSession(browser, state, key, agentOf(exec), undefined, args.url)
            return { url: args.url, carrier: 'panel-iframe-navigation-requested', title: '', elements: [], truncated: false }
          }
          await browser.openUrl(session, { url: args.url, ...args.newTab === true ? { newTab: true } : {} }, exec.signal)
          const snapshot = await browser.snapshot(session, exec.signal)
          exec.signal?.throwIfAborted()
          rememberSession(browser, state, key, agentOf(exec), session, args.url)
          return {
            url: snapshot.url,
            ...snapshot.title !== undefined ? { title: snapshot.title } : {},
            elements: snapshot.elements.map(el => projectElement(el)),
            truncated: snapshot.truncated,
            ...snapshot.challenge !== undefined ? { challenge: snapshot.challenge } : {},
          }
        })()
        const pending = opening.then(() => {})
        state.pendingPanelOpens.set(key, pending)
        void pending.catch(() => {})
        try { return await opening } catch (error) {
          if (session !== undefined && session !== previous) await browser.close(session).catch(() => {})
          throw error
        } finally {
          if (state.pendingPanelOpens.get(key) === pending) state.pendingPanelOpens.delete(key)
        }
      }
      await state.pendingPanelOpens.get(key)
      await state.pendingOpens.get(key)
      if (panelBound(state, key)) {
        const previous = state.sessionsByTask.get(key)
        state.sessionsByTask.delete(key)
        state.panelUrlByTask.delete(key)
        if (previous !== undefined) await browser.close(previous)
      }
      const session = await ensureSession(browser, state, key, agentOf(exec), true)
      try {
        await browser.openUrl(session, {
          url: args.url,
          ...args.newTab === true ? { newTab: true } : {},
        }, exec.signal)
      } catch (error) {
        // The human's browser is already running on its own profile: the launch hands the request over and
        // exits with code 0. A new window opened inside THEIR browser with their logins — what "use my
        // Edge" means — it is simply not driveable, because their instance has no debugging port.
        const message = error instanceof Error ? error.message : String(error)
        if (!/exited immediately after launch \(exit code 0\)/u.test(message)) throw error
        return { url: args.url, carrier: 'launched-user-profile', title: '', elements: [], truncated: false }
      }
      // Hand the page to the Web sidebar as well. The desktop shell is told through the bridge; the Web
      // shell has no such channel, so the client polls this slot and places the tab itself. Written in the
      // TOOL (not a provider) on purpose: every open passes through here whatever serves it.
      try { setLastOpen(args.url, Date.now()) } catch { /* best effort */ }
      let snapshot: Awaited<ReturnType<typeof browser.snapshot>>
      try {
        snapshot = await browser.snapshot(session, exec.signal)
      } catch (error) {
        // The human's browser is ALREADY running on its own profile, so a launch hands the request over
        // and the launcher exits with code 0. That is not a failure: a new window opened inside THEIR
        // browser, with their logins, which is exactly what "use my Edge" means. It is only undriveable,
        // because their instance has no debugging port. Report the page, not an error.
        const message = error instanceof Error ? error.message : String(error)
        if (!/exited immediately after launch \(exit code 0\)/u.test(message)) throw error
        return {
          url: args.url,
          carrier: 'launched-user-profile',
          title: '',
          elements: [],
          truncated: false,
        }
      }
      return {
        url: snapshot.url,
        carrier: String((globalThis as unknown as Record<string, unknown>).__dshBrowserCarrier ?? 'bundled'),
        ...snapshot.title !== undefined ? { title: snapshot.title } : {},
        elements: snapshot.elements.map(el => projectElement(el)),
        truncated: snapshot.truncated,
        ...snapshot.challenge !== undefined ? { challenge: snapshot.challenge } : {},
      }
    },
  }))

  tools.push(defineTool({
    name: 'dsh_browser_wait',
    description: 'Wait until the shared-browser page is ready: load complete, and optionally the expected URL and/or a CSS selector present (top document or same-origin iframes). Use after dsh_browser_open on slow sites instead of snapshotting a white page — wait for the URL you navigated to first. Returns ready=true/false with a short reason; a miss is not an error.',
    parameters: {
      timeoutMs: { type: 'number', description: 'Maximum wait in ms (default 30000).' },
      url: { type: 'string', description: 'Expected page URL (exact or prefix), e.g. the URL you opened.' },
      selector: { type: 'string', description: 'CSS selector that must exist.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ready: { type: 'boolean', required: true },
          reason: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.ready ? 'Page ready.' : `Wait timed out: ${value.reason}` }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const result = await browser.waitFor(session, {
        // Capped so an over-budget argument returns the documented verdict (see maxWaitMs)
        // rather than aborting the whole tool call.
        ...args.timeoutMs !== undefined ? { timeoutMs: Math.min(args.timeoutMs, maxWaitMs) } : {},
        ...args.url !== undefined ? { url: args.url } : {},
        ...args.selector !== undefined ? { selector: args.selector } : {},
      }, exec.signal)
      return { ready: result.ready, reason: result.reason }
    },
  }))

  tools.push(defineTool({
    name: 'dsh_browser_back',
    description: 'Go back one step in the shared-browser page history. A no-op when there is no previous entry.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { back: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.back ? 'Went back.' : 'Failed.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false, // mutates page state; exclusive within a task
    async execute(_args, exec) {
      assertAllowed(state, 'dsh_browser_back', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      await browser.back(session, exec.signal)
      return { back: true }
    },
  }))

  tools.push(defineTool({
    name: 'dsh_browser_forward',
    description: 'Go forward one step in the shared-browser page history. A no-op when there is no next entry.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { forward: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.forward ? 'Went forward.' : 'Failed.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false, // mutates page state; exclusive within a task
    async execute(_args, exec) {
      assertAllowed(state, 'dsh_browser_forward', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      await browser.forward(session, exec.signal)
      return { forward: true }
    },
  }))

  tools.push(defineTool({
    name: 'dsh_browser_refresh',
    description: 'Reload the current page in the shared browser (like a browser\'s refresh button). Use after a page got stuck, to apply script changes, or to re-fetch a page.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { refreshed: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.refreshed ? 'Page reloaded.' : 'Failed.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false, // reloads the page; exclusive within a task
    async execute(_args, exec) {
      assertAllowed(state, 'dsh_browser_refresh', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      await browser.reload(session, exec.signal)
      return { refreshed: true }
    },
  }))

  if (config.tabTools !== false) {
    tools.push(defineTool({
      name: 'dsh_browser_list_tabs',
      description: 'List the shared-browser session\'s tabs with their URLs and which is active.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tabs: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  url: { type: 'string', required: true },
                  active: { type: 'boolean', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: (value.tabs as { id: string; url: string; active: boolean }[])
            .map(t => `${t.active ? '*' : ' '} ${t.id} ${t.url}`).join('\n'),
        }],
      },
      timeoutMs,
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        const browser = ctx.get('browser')
        if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
        const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
        const tabs = await browser.listTabs(session)
        return { tabs: scopedTabs(browserSessionHandle(taskKey(exec), session), tabs).map(t => ({ id: t.id, url: t.url, active: t.active })) }
      },
    }))

    tools.push(defineTool({
      name: 'dsh_browser_switch_tab',
      description: 'Switch the shared browser to a tab by id (from dsh_browser_list_tabs).',
      parameters: {
        tabId: { type: 'string', required: true, description: 'The tab id to switch to.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { switched: { type: 'boolean', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.switched ? 'Switched.' : 'Tab not found.' }],
      },
      timeoutMs,
      isConcurrencySafe: () => false, // mutates the active tab; exclusive within a task
      async execute(args, exec) {
        assertAllowed(state, 'dsh_browser_switch_tab', taskKey(exec))
        const browser = ctx.get('browser')
        if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
        const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
        const handle = resolveTabHandle(browserSessionHandle(taskKey(exec), session), args.tabId)
        await browser.switchTab(session, tabWireId(handle))
        return { switched: true }
      },
    }))

    tools.push(defineTool({
      name: 'dsh_browser_close_tab',
      description: 'Close a tab in the shared browser by id. Closing the active tab activates the next.',
      parameters: {
        tabId: { type: 'string', required: true, description: 'The tab id to close.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { closed: { type: 'boolean', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.closed ? 'Closed.' : 'Tab not found.' }],
      },
      timeoutMs,
      isConcurrencySafe: () => false, // mutates the tab list; exclusive within a task
      async execute(args, exec) {
        assertAllowed(state, 'dsh_browser_close_tab', taskKey(exec))
        const browser = ctx.get('browser')
        if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
        const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
        const handle = resolveTabHandle(browserSessionHandle(taskKey(exec), session), args.tabId)
        await browser.closeTab(session, tabWireId(handle))
        return { closed: true }
      },
    }))

    tools.push(defineTool({
      name: 'dsh_browser_reset',
      description: 'Close every tab in the shared browser and start fresh with one blank tab.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { reset: { type: 'boolean', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.reset ? 'Browser reset.' : 'Failed.' }],
      },
      timeoutMs,
      isConcurrencySafe: () => false, // closes every tab; exclusive within a task
      async execute(_args, exec) {
        assertAllowed(state, 'dsh_browser_reset', taskKey(exec))
        const browser = ctx.get('browser')
        if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
        const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
        await browser.reset(session)
        return { reset: true }
      },
    }))
  }

  tools.push(defineTool({
    name: 'dsh_browser_history',
    description: 'List the shared browser session\'s recorded operation history (navigate/execute/click/type), newest last, with per-step success/error. Use to understand what the agent did and to pick a step to replay.',
    parameters: {
      verbose: { type: 'boolean', description: "Include each operation's parameters (default false). They are what you just sent, so they are omitted unless asked for." },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                seq: { type: 'number', required: true },
                action: { type: 'string', required: true },
                ok: { type: 'boolean', required: true },
                params: { type: 'object', additionalProperties: true, required: true },
                result: { type: 'string' },
                error: { type: 'string' },
              },
            },
          },
        },
      },
      render: (args, value) => {
        const entries = value.entries as Array<{ seq: number; action: string; ok: boolean; params: Record<string, unknown>; result?: string; error?: string }>
        if (entries.length === 0) return [{ type: 'text', text: '(no recorded operations yet)' }]
        // The parameters are what the caller itself just sent, so echoing them back is cost
        // without information — measured at 18,162 characters for 200 operations, of which the
        // per-entry params dominated. Only the tail is shown by default: the recent steps are
        // what a caller reasons about, and the count leads so the tail is not mistaken for all.
        const recent = entries.slice(-20)
        const omitted = entries.length - recent.length
        const lines = recent.map(e => `#${e.seq} ${e.action} ${e.ok ? 'ok' : 'FAIL'}${e.result !== undefined ? ` -> ${e.result}` : ''}${e.error !== undefined ? ` !! ${e.error}` : ''}${args.verbose === true ? ` ${JSON.stringify(e.params)}` : ''}`)
        const header = omitted > 0
          ? `${entries.length} operations recorded; showing the last ${recent.length} (${args.verbose === true ? '' : ' (pass verbose: true for parameters)'}):`
          : `${entries.length} operation(s):`
        return [{ type: 'text', text: `${header}\n${lines.join('\n')}` }]
      },
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const entries = await browser.history(session)
      const rendered = entries.map(e => {
        const params = JSON.parse(JSON.stringify(e.params)) as Record<string, unknown>
        // Typed text / set values (possibly passwords) are kept verbatim in
        // the provider's history so replay can re-issue them, but must not be
        // echoed back to the model: mask them in the tool output, preserving
        // the length.
        if (e.action === 'type' && typeof params.text === 'string') {
          params.text = '*'.repeat(Math.min(params.text.length, 64)) + ` (${params.text.length} chars)`
        }
        if (e.action === 'setValue' && typeof params.value === 'string') {
          params.value = '*'.repeat(Math.min(params.value.length, 64)) + ` (${params.value.length} chars)`
        }
        // Replay of type/setValue carries the same sensitive fields.
        if (e.action === 'replay' && params.of === 'type' && typeof params.text === 'string') {
          params.text = '*'.repeat(Math.min(params.text.length, 64)) + ` (${params.text.length} chars)`
        }
        // Execute scripts may embed form tokens / credentials; mask script,
        // args, and result for both direct execute and replay-of-execute.
        const isExecute = e.action === 'execute' || (e.action === 'replay' && params.of === 'execute')
        if (isExecute) {
          if (typeof params.script === 'string') {
            params.script = `/* ${params.script.length} chars redacted */`
          }
          if (Array.isArray(params.args)) {
            params.args = params.args.map(() => '***')
          }
        }
        const row: { seq: number; action: string; ok: boolean; params: unknown; result?: string; error?: string } = {
          seq: e.seq,
          action: e.action,
          ok: e.ok,
          params,
        }
        if (isExecute && typeof e.result === 'string') {
          row.result = `[${e.result.length} chars redacted]`
        } else if (e.result !== undefined) {
          row.result = e.result
        }
        if (e.error !== undefined) row.error = e.error
        return row
      })
      return { entries: rendered as never }
    },
  }))

  tools.push(defineTool({
    name: 'dsh_browser_visited',
    description: 'List pages the shared browser has visited, newest first, from the PERSISTENT browsing history: it survives closing the browser and restarting DSH, so it is how you (or the human) find a page again afterwards. Reopen one by passing its url to dsh_browser_open. Not to be confused with dsh_browser_history, which is only the current session\'s operation log (navigate/click/type) and disappears with the session.',
    parameters: {
      limit: { type: 'number', description: 'Maximum entries to return (default 30, capped at 200).' },
      domain: { type: 'string', description: 'Only visits whose hostname contains this text (case-insensitive).' },
      query: { type: 'string', description: 'Only visits whose URL or title contains this text (case-insensitive).' },
      session: { type: 'string', description: 'Only visits recorded by this task/session label — use it to separate your own pages from another session\'s or the human\'s.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'number', required: true },
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                at: { type: 'number', required: true },
                url: { type: 'string', required: true },
                title: { type: 'string' },
                session: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const entries = value.entries as Array<{ at: number; url: string; title?: string; session?: string }>
        let lastSession: string | undefined
        if (entries.length === 0) {
          return [{ type: 'text', text: '(no recorded visits — nothing has been browsed yet, or history recording is turned off in settings)' }]
        }
        return [{
          type: 'text',
          text: entries.map(entry => {
            const when = new Date(entry.at).toISOString().replace('T', ' ').slice(0, 16)
            const title = entry.title !== undefined ? `${entry.title} — ` : ''
            const tag = entry.session !== undefined && entry.session !== lastSession
              ? `  [session ${entry.session.slice(0, 8)}]`
              : ''
            lastSession = entry.session
            return `${when}  ${title}${entry.url}${tag}`
          }).join('\n'),
        }]
      },
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const rawLimit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : 30
      const limit = Math.max(1, Math.min(200, Math.floor(rawLimit)))
      const domain = typeof args.domain === 'string' && args.domain.trim() !== '' ? args.domain.trim() : undefined
      const query = typeof args.query === 'string' && args.query.trim() !== '' ? args.query.trim() : undefined
      const session = typeof args.session === 'string' && args.session.trim() !== '' ? args.session.trim() : undefined
      const entries = browser.visited({
        limit,
        ...domain !== undefined ? { domain } : {},
        ...query !== undefined ? { query } : {},
        ...session !== undefined ? { session } : {},
      })
      return {
        count: entries.length,
        entries: entries.map(entry => ({
          at: entry.at,
          url: entry.url,
          ...entry.title !== undefined ? { title: entry.title } : {},
          ...entry.session !== undefined ? { session: entry.session } : {},
        })),
      }
    },
  }))

  tools.push(defineTool({
    name: 'dsh_browser_replay',
    description: 'Replay one recorded browser operation by its history sequence number (from dsh_browser_history). Navigate/click/type are re-issued against the current page; execute re-runs its script. The replayed step is appended to history as a new entry.',
    parameters: {
      seq: { type: 'number', required: true, description: 'The history entry sequence number to replay.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { replayed: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.replayed ? 'Replayed.' : 'Replay failed.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_replay', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      await browser.replay(session, args.seq)
      return { replayed: true }
    },
  }))

  tools.push(defineTool({
    name: 'dsh_browser_session',
    description: 'Show THIS task\'s browser session: its id and open tabs. Each task (DSH session) has its own browser session, so this reflects what your task drives. The window is shared with the human and other tasks, but tab sets and history are isolated per task.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session: { type: 'string', required: true },
          tabs: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                url: { type: 'string', required: true },
                active: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Session ${value.session}\n${(value.tabs as { id: string; url: string; active: boolean }[]).map(t => `${t.active ? '*' : ' '} ${t.id} ${t.url}`).join('\n')}`,
      }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const tabs = await browser.listTabs(session)
      const scope = browserSessionHandle(taskKey(exec), session)
      return { session: sessionWireId(scope), tabs: scopedTabs(scope, tabs).map(t => ({ id: t.id, url: t.url, active: t.active })) }
    },
  }))

  tools.push(defineTool({
    name: 'dsh_browser_reset_session',
    description: 'Reset THIS task\'s browser session: close it entirely so the next dsh_browser_* call starts a fresh session with one blank tab. Other tasks\' sessions are untouched. Use when a session is in a bad state or you want a clean slate.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { reset: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.reset ? 'This task\'s browser session was closed; the next call starts fresh.' : 'Failed.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false, // closes the whole session; exclusive within a task
    async execute(_args, exec) {
      assertAllowed(state, 'dsh_browser_reset_session', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const key = taskKey(exec)
      await state.pendingPanelOpens.get(key)
      state.panelUrlByTask.delete(key)
      const session = state.sessionsByTask.get(key)
      if (session !== undefined) {
        try {
          await browser.close(session)
        } finally {
          // Always forget the mapping so the next call opens a fresh session,
          // even if the provider close threw (the session is half-closed).
          state.sessionsByTask.delete(key)
        }
      }
      return { reset: true }
    },
  }))

  return tools
}
