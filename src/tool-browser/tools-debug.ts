/**
 * Debug and control tools: console, network, dialogs, assertions, doctor, help, batches, restriction, auth and human takeover.
 * @module dsh-browser/tool-browser/tools-debug
 */

import { type ToolRunContext, defineTool } from '@deepseek-ai/dsh-tools'
import { TAKEOVER_TOOL, type TakeoverDecision, type TakeoverOutcome, type TakeoverSummary } from '../takeover-protocol.ts'
import { clearLastOpen, getLastOpen } from '../browser-electron/open-slot.ts'
import { assertAllowed, agentOf, taskKey, ensureSession, type ToolScope, type ToolDefinition } from './state.ts'
import { pageValue, pageOperationValue, installProbe, probe, probeLive, pause, poll, type ProbeRow, runChecks } from './probe-client.ts'
import { formatSnapshot } from './tools-observation.ts'
import { MINIMIZED_TAKEOVER_NOTE } from './takeover.ts'

/**
 * Define this module's tools for one apply.
 * @param scope - the apply's context, settings and per-apply state.
 * @returns the tool definitions, for the entry to register.
 */
export function debugTools(scope: ToolScope): ToolDefinition[] {
  const { ctx, state, takeovers, timeoutMs, maxWaitMs } = scope
  const tools: ToolDefinition[] = []

  tools.push(defineTool({
    name: 'dsh_browser_request_takeover',
    description: 'Hand the selected visible sidebar browser tab in this conversation to the human for a CAPTCHA/slider, login, 2FA or payment. Works on the Web iframe without CDP, including user-opened tabs: adopts the selected tab for this request only, without granting agent control. Never solve CAPTCHAs automatically. Requires an active turn; waits for the sidebar connection and the native card or sidebar Confirm/Skip. Repeated calls on the same tab share one request. Returns done/skipped/cancelled plus a fresh page summary; inspect it before resuming. Never treat skipped/cancelled as success.',
    parameters: {
      reason: { type: 'string', required: true, description: 'Why the human must take over (1–1000 characters).' },
      instructions: { type: 'string', description: 'Optional concise instructions for the human (up to 2000 characters).' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      outcome: { type: 'string', required: true, enum: ['done', 'skipped', 'cancelled'] },
      page: { type: 'object', required: true, additionalProperties: false, properties: {
        url: { type: 'string', required: true }, title: { type: 'string', required: true },
        snapshotHint: { type: 'string', required: true }, fresh: { type: 'boolean', required: true },
      } },
    } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      if (!exec.agent?.session) throw new Error('Browser takeover requires an active agent turn.')
      if (!args.reason.trim()) throw new Error('Browser takeover reason must not be empty.')
      if (args.reason.length > 1000 || (args.instructions?.length ?? 0) > 2000) throw new Error('Browser takeover reason or instructions are too long.')
      const owner = taskKey(exec)
      const opening = state.pendingPanelOpens.get(owner)
      if (opening) await opening
      const open = getLastOpen()
      const navigationUrl = open?.owner === owner && Date.now() - open.at < 10000 ? open.url : undefined
      const page = await takeovers.adopt(owner, exec.signal, navigationUrl)
      if (navigationUrl !== undefined && getLastOpen()?.owner === owner) clearLastOpen(open!.at)
      const instructions = await page.minimized?.().catch(() => false) === true ? [args.instructions, MINIMIZED_TAKEOVER_NOTE].filter(Boolean).join('\n') : args.instructions
      return takeovers.run(page, args.reason.trim(), instructions, exec.signal, async (pending): Promise<{ outcome: TakeoverOutcome; page: TakeoverSummary }> => {
        const approval = ctx.get('approval' as never) as unknown as { request(request: {
          agent: ToolRunContext['agent']; toolName: string; reason: string; displayReason: { en: string; zh: string };
          callId: ToolRunContext['callId']; signal: AbortSignal;
        }): Promise<TakeoverDecision> } | undefined
        let decision: TakeoverDecision = 'unavailable'
        try {
          if (approval) decision = await approval.request({ agent: exec.agent, toolName: TAKEOVER_TOOL, callId: exec.callId,
            reason: pending.reason, displayReason: {
              en: `Please take over the browser: ${pending.reason}. When finished, click Allow once or Confirm completion in the sidebar.${pending.instructions ? '\n' + pending.instructions : ''}`,
              zh: `请接管浏览器：${pending.reason}（完成后点「允许一次」或侧栏「确认完成」）${pending.instructions ? '\n' + pending.instructions : ''}`,
            }, signal: pending.controller.signal })
        } finally { pending.controller.abort() }
        const outcome = decision === 'allowed-once' ? 'done' : decision === 'rejected' ? 'skipped' : 'cancelled'
        const unavailable = (error: unknown): TakeoverSummary => ({ url: page.url, title: '', snapshotHint: `Live page summary unavailable: ${String(error).slice(0, 300)}. Re-read the page before continuing.`, fresh: false })
        if (exec.signal.aborted) return { outcome: 'cancelled', page: unavailable('turn stopped') }
        pending.phase = 'summary'
        let fresh: TakeoverSummary
        try {
          if (!page.pageId.startsWith('iframe:')) {
            const browser = ctx.get('browser')!
            const session = await browser.bindPanelPage(`session-${page.owner}`, page.pageId)
            const snapshot = await browser.snapshot(session, AbortSignal.any([exec.signal, AbortSignal.timeout(5000)]))
            fresh = { url: snapshot.url, title: (snapshot.title ?? '').slice(0, 1000), snapshotHint: formatSnapshot(snapshot, {}).slice(0, 1500), fresh: true }
          } else {
            fresh = await new Promise<TakeoverSummary>((resolve, reject) => {
              const finish = (value?: TakeoverSummary, error?: unknown): void => {
                clearTimeout(timer); exec.signal.removeEventListener('abort', abort)
                if (error !== undefined) reject(error); else resolve(value!)
              }
              const abort = (): void => { finish(undefined, exec.signal.reason) }
              const timer = setTimeout(() => { finish(undefined, new Error('sidebar summary timed out')) }, 8000)
              exec.signal.addEventListener('abort', abort, { once: true })
              void pending.summary.then(value => { finish(value) })
              if (exec.signal.aborted) abort()
            })
          }
        } catch (error) { fresh = unavailable(error) }
        return { outcome: exec.signal.aborted ? 'cancelled' : outcome, page: fresh }
      })
    },
  }))

  tools.push(defineTool({
    name: 'dsh_browser_restrict',
    description: 'Allow only the listed browser tools; any other dsh_browser_* call is refused. Empty list or omitted lifts it. Never blocked whatever the list says — the observing tools (snapshot/a11y/content/scrape/screenshot/get_value/wait/challenge/list_tabs/session/history/visited) and restrict/reset/reset_session — so a restriction can always be read around and undone. A SOFT guardrail against stray clicks, NOT a security boundary: you can lift it with an empty list.',
    parameters: {
      allowed: {
        type: 'array',
        items: { type: 'string' },
        description: 'Allow-list of browser tool names; empty clears the restriction.',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { restrictedTo: { type: 'array', required: true, items: { type: 'string' } } } },
      render: (_args, value) => [{ type: 'text', text: (value.restrictedTo as string[]).length > 0 ? `Restricted to: ${(value.restrictedTo as string[]).join(', ')}` : 'Restriction lifted.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      // Always allowed so the guard can be lifted.
      const allowed = args.allowed ?? []
      const unknown = allowed.filter((t: string) => !t.startsWith('dsh_browser_'))
      if (unknown.length > 0) {
        throw new Error(`dsh_browser_restrict: unknown tool name(s) ${unknown.map(t => `"${t}"`).join(', ')} (must start with "dsh_browser_")`)
      }
      // Empty list (or omitted) lifts this task's restriction; a non-empty list is its
      // new allow-list. Per task, not per plugin: this state object is shared by every
      // agent, so one value here used to lock every other task's browser tools.
      //
      if (allowed.length === 0) state.restrictedByTask.delete(taskKey(exec))
      else state.restrictedByTask.set(taskKey(exec), [...allowed])
      const current = state.restrictedByTask.get(taskKey(exec))
      return { restrictedTo: current === undefined ? [] : [...current] }
    },
  }))

  tools.push(defineTool({
    name: 'dsh_browser_auth',
    description: 'Export or restore the session\'s cookies (login state): "flush" returns a JSON cookie list, "restore" takes that list back (e.g. after the host restarted). Works on all carriers. Refused when the credential switch is off. Exported cookies are LIVE CREDENTIALS: never echo them into the conversation or logs; keep the list in a private file.',
    parameters: {
      action: { type: 'string', required: true, enum: ['flush', 'restore'], description: 'flush = export cookies; restore = import cookies.' },
      cookies: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Cookie list to restore (required when action=restore).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cookies: { type: 'array', items: { type: 'object', additionalProperties: true } },
          restored: { type: 'number' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.cookies !== undefined ? `Exported ${(value.cookies as unknown[]).length} cookies — LIVE CREDENTIALS; store privately and never echo them.` : `Restored ${value.restored} cookies.` }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_auth', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      if (args.action === 'flush') {
        const cookies = await browser.flushAuth(session)
        return { cookies: cookies.map(c => ({ ...c })) as never }
      }
      // The description says cookies are required for restore; without this check an
      // empty call returned {restored: 0} and rendered 'Restored 0 cookies.', which
      // reads as success and would leave the caller believing the login was restored.
      if (!Array.isArray(args.cookies) || args.cookies.length === 0) {
        throw new Error('dsh_browser_auth: action "restore" needs a non-empty "cookies" array (get one from action "flush" on the same profile)')
      }
      const list = args.cookies as unknown[]
      const restored = await browser.restoreAuth(session, list as never)
      return { restored }
    },
  }))

  // ===========================================================================
  // Observation, assertion and batch work (0.5.7).
  //
  // Five capabilities were missing against the other browser plugins in this market: what the
  // console said, which responses arrived, what happened to a JavaScript dialog (an unanswered
  // `confirm()` used to hang a whole call), a way to assert a result instead of eyeballing a
  // screenshot, and a way to run several steps in one call. All of them come from one page-side
  // probe installed through `execute`, so they work identically on the self-hosted window, a driven
  // Chrome/Edge and the desktop sidebar — no host change, no bridge protocol version.
  // ===========================================================================

  tools.push(defineTool({
    name: 'dsh_browser_console',
    description: 'Read what the page has logged (console.log/info/warn/error/debug), newest last, capped at 200 lines. Use it when the screen does not explain a failure: a red toast, a form that silently refuses, a page that "just does nothing". Set clear:true first when you only want what happens next. A page that logs objects shows their JSON.',
    parameters: {
      limit: { type: 'number', description: 'How many lines, newest last (default 20, max 100).' },
      filter: { type: 'string', description: 'Only lines containing this text (case-insensitive).' },
      clear: { type: 'boolean', description: 'Clear the buffer before reading.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { entries: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true } },
      },
      render: (_args, value) => {
        const rows = value.entries as Array<{ level?: string; text?: string }>
        if (rows.length === 0) return [{ type: 'text', text: 'No console lines yet (nothing logged since the page probe was installed).' }]
        return [{ type: 'text', text: rows.map(row => `[${String(row.level)}] ${String(row.text)}`).join('\n') }]
      },
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      await installProbe(browser, session, exec.signal)
      if (args.clear === true) await probe(browser, session, 'clear', ['console'], exec.signal)
      const entries = await probe<ProbeRow[]>(browser, session, 'read', ['console', args.filter ?? '', args.limit ?? 20], exec.signal)
      return { entries }
    },
  }))

  tools.push(defineTool({
    name: 'dsh_browser_network',
    description: 'List the responses the page has received, newest last: method, status, type and address, for fetch, XHR and resource-timing entries. Use it when a page fills itself from the network and the screen does not say why, or to confirm a submit actually reached the server. onlyFailures keeps status 0 (blocked/aborted) and 4xx/5xx. Resource-timing rows carry no status (the browser never exposed it to the page) and show status 0.',
    parameters: {
      limit: { type: 'number', description: 'How many rows, newest last (default 20, max 100).' },
      filter: { type: 'string', description: 'Only rows whose address contains this text.' },
      onlyFailures: { type: 'boolean', description: 'Only rows with status 0, or status >= 400.' },
      clear: { type: 'boolean', description: 'Clear the buffer before reading.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { entries: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true } },
      },
      render: (_args, value) => {
        const rows = value.entries as ProbeRow[]
        if (rows.length === 0) return [{ type: 'text', text: 'No responses recorded yet.' }]
        return [{ type: 'text', text: rows.map(row => `${String(row.method)} ${String(row.status)} ${String(row.kind)} ${String(row.ms)}ms ${String(row.url)}`).join('\n') }]
      },
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      await installProbe(browser, session, exec.signal)
      if (args.clear === true) await probe(browser, session, 'clear', ['network'], exec.signal)
      const rows = await probe<ProbeRow[]>(browser, session, 'read', ['network', args.filter ?? '', args.limit ?? 20], exec.signal)
      const entries = args.onlyFailures === true
        ? rows.filter(row => Number(row.status) === 0 || Number(row.status) >= 400)
        : rows
      return { entries }
    },
  }))

  tools.push(defineTool({
    name: 'dsh_browser_data_sources',
    description: 'Find where the page keeps its data before reading the DOM: embedded state (__NEXT_DATA__, __NUXT_DATA__, window.__INITIAL_STATE__/__APOLLO_STATE__, application/json and ld+json scripts) with size, top-level keys and the largest arrays; the fetch/XHR APIs the page called (method, status, content type); data-like resources it fetched before the probe was installed; and endpoints it declares (preload as=fetch, data-api, data-endpoint). Shapes only, never bodies. Use it before scraping a list, directory, paginated or lazy-loaded data: a JSON source is usually complete where the DOM is not.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          embedded: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
          apis: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
          resources: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
          declared: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatDataSources(value as unknown as DataSources) }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const found = await probeLive<{ url: string; embedded: ProbeRow[]; apis: ProbeRow[]; resources: ProbeRow[]; declared: ProbeRow[] }>(browser, session, 'dataSources', [], exec.signal)
      return { url: found.url, embedded: found.embedded, apis: found.apis, resources: found.resources, declared: found.declared }
    },
  }))

  tools.push(defineTool({
    name: 'dsh_browser_fetch_json',
    description: 'Fetch a URL from inside the page (so it carries the site\'s same-origin cookies) and return its JSON. A non-2xx status or a body that is not JSON is an error naming the status and the start of the body. Use it to read an API found with dsh_browser_data_sources instead of paging through the DOM; GET requests may run in parallel.',
    parameters: {
      url: { type: 'string', required: true, description: 'Absolute, or relative to the current page.' },
      method: { type: 'string', description: 'HTTP method (default GET).' },
      headers: { type: 'object', additionalProperties: true, description: 'Request headers, as string values.' },
      body: { type: 'string', description: 'Request body (e.g. JSON.stringify(payload)).' },
      maxChars: { type: 'number', description: 'Maximum characters of the body shown (default 50000); the returned value always holds the whole body.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'number', required: true },
          url: { type: 'string', required: true },
          bytes: { type: 'number', required: true },
          body: { type: 'string', required: true },
        },
      },
      render: (args, value) => {
        const body = String(value.body)
        const limit = args.maxChars ?? 50_000
        const shown = body.length > limit ? `${body.slice(0, limit)}\n(body truncated at ${limit} of ${body.length} characters — raise maxChars)` : body
        return [{ type: 'text', text: `${String(value.status)} ${String(value.url)} (${String(value.bytes)} bytes)\n${shown}` }]
      },
    },
    timeoutMs,
    isConcurrencySafe: args => isReadMethod(args.method),
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_fetch_json', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const headers: Record<string, string> = {}
      for (const [key, raw] of Object.entries(args.headers ?? {})) headers[key] = String(raw)
      const init = {
        ...args.method !== undefined ? { method: args.method } : {},
        ...Object.keys(headers).length > 0 ? { headers } : {},
        ...args.body !== undefined ? { body: args.body } : {},
      }
      const text = await pageOperationValue(browser, session, { operation: 'fetch', url: args.url, init }, exec.signal)
      const out = JSON.parse(text) as { ok: boolean; status: number; statusText: string; url: string; type: string; body: string }
      const head = out.body.slice(0, 200)
      if (!out.ok) throw new Error(`fetch_json: HTTP ${out.status}${out.statusText ? ` ${out.statusText}` : ''} from ${out.url || args.url}: ${head}`)
      try { JSON.parse(out.body) } catch { throw new Error(`fetch_json: ${out.url || args.url} answered ${out.status} with ${out.type || 'no content type'}, not JSON: ${head}`) }
      return { status: out.status, url: out.url || args.url, bytes: out.body.length, body: out.body }
    },
  }))

  tools.push(defineTool({
    name: 'dsh_browser_dialog',
    description: 'Report JavaScript dialogs (alert/confirm/prompt) the page raised, and choose how they are answered. Dialogs use the native browser UI by default. Setting policy "dismiss" answers alert/prompt with nothing and confirm with false, "accept" answers confirm with true and prompt with its current text. Policy "native" restores the original dialog functions. Reading preserves the current policy; changing it is an action. A dialog raised by the browser itself (beforeunload, HTTP auth) is not covered.',
    parameters: {
      policy: { type: 'string', enum: ['native', 'accept', 'dismiss'], description: 'Answer future dialogs this way.' },
      limit: { type: 'number', description: 'How many recent dialogs to return (default 10).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          policy: { type: 'string', required: true },
          dialogs: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
        },
      },
      render: (_args, value) => {
        const rows = value.dialogs as ProbeRow[]
        const head = `Dialog policy: ${String(value.policy)} (${String(value.policy) === 'accept' ? 'confirm→true, prompt→its text' : 'confirm→false, prompt→null'}).`
        if (rows.length === 0) return [{ type: 'text', text: `${head} No dialogs seen yet.` }]
        return [{ type: 'text', text: [head, ...rows.map(row => `${String(row.kind)} "${String(row.message)}" → ${String(row.answered)}`)] .join('\n') }]
      },
    },
    timeoutMs,
    isConcurrencySafe: () => false, // the policy is task-wide state
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_dialog', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      await installProbe(browser, session, exec.signal)
      const policy = args.policy === undefined
        ? await probe<string>(browser, session, 'dialogStatus', [], exec.signal)
        : await probe<string>(browser, session, 'setDialogPolicy', [args.policy], exec.signal)
      const dialogs = await probe<ProbeRow[]>(browser, session, 'read', ['dialogs', '', args.limit ?? 10], exec.signal)
      return { policy, dialogs }
    },
  }))

  tools.push(defineTool({
    name: 'dsh_browser_wait_for_response',
    description: 'Wait until a response whose address contains `urlContains` has arrived AFTER this call started: optional status (e.g. 200, or 4xx), bounded by timeoutMs. Use it instead of sleeping before a snapshot when a click submits a form or starts a fetch — it returns as soon as the server answered, and says what arrived when it did not. This is the "did the submit reach the server" question that a screenshot cannot answer.',
    parameters: {
      urlContains: { type: 'string', required: true, description: 'Substring of the request address.' },
      status: { type: 'number', description: 'Require this exact status (a non-zero status is required to match).' },
      timeoutMs: { type: 'number', description: 'How long to wait (default 15000, capped by the tool timeout).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          matched: { type: 'boolean', required: true },
          reason: { type: 'string', required: true },
          entry: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => {
        const entry = value.entry as Record<string, unknown> | undefined
        if (!value.matched) return [{ type: 'text', text: `No matching response: ${String(value.reason)}` }]
        return [{ type: 'text', text: `Matched: ${String(entry?.method)} ${String(entry?.status)} ${String(entry?.url)} (${String(entry?.ms)}ms)` }]
      },
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      await installProbe(browser, session, exec.signal)
      const cursor = await probe<{ startedAt: number; sequence: number }>(browser, session, 'networkCursor', [], exec.signal)
      // Batched code holds back the triggering action until the cursor is captured.
      ;(exec as { armed?: () => void }).armed?.()
      const budget = Math.min(args.timeoutMs ?? 15_000, maxWaitMs)
      const found = await poll(async () => {
        const current = await probe<{ startedAt: number; sequence: number }>(browser, session, 'networkCursor', [], exec.signal)
        if (current.startedAt !== cursor.startedAt) throw new Error('the page changed while waiting for a response; start a new wait on the current page')
        const rows = await probe<ProbeRow[]>(browser, session, 'read', ['network', args.urlContains, 100], exec.signal)
        const fresh = rows.filter(row => Number(row.sequence) > cursor.sequence && Number(row.status) > 0)
        const exact = args.status === undefined ? fresh : fresh.filter(row => Number(row.status) === args.status)
        return exact.length > 0 ? exact[exact.length - 1] : undefined
      }, budget)
      if (found === undefined) {
        const rows = await probe<ProbeRow[]>(browser, session, 'read', ['network', args.urlContains, 60], exec.signal)
        const seen = rows.length === 0 ? 'nothing matched the address' : `${rows.length} older row(s) matched but none arrived after this call started`
        return { matched: false, reason: `${seen} within ${Math.round(budget / 1000)}s` }
      }
      return { matched: true, reason: 'response arrived', entry: found }
    },
  }))

  tools.push(defineTool({
    name: 'dsh_browser_assert',
    description: 'Assert facts about the page in one call and get a pass/fail per assertion with the evidence: a CSS selector exists, the body text contains something, the URL contains something, or a JavaScript expression is truthy. Use it to verify a step actually worked — "clicked" and "the form accepted it" are different claims — and before retrying anything that might have already taken effect.',
    parameters: {
      selector: { type: 'string', description: 'CSS selector that must match an element.' },
      text: { type: 'string', description: 'Text that must appear in the page body.' },
      url: { type: 'string', description: 'Substring the URL must contain.' },
      js: { type: 'string', description: 'Expression that must be truthy, e.g. document.querySelector("#ok") !== null.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pass: { type: 'boolean', required: true },
          checks: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
        },
      },
      render: (_args, value) => {
        const rows = value.checks as ProbeRow[]
        const lines = rows.map(row => `${row.pass === true ? 'PASS' : 'FAIL'} ${String(row.kind)}: ${String(row.expected)} → ${String(row.actual)}`)
        return [{ type: 'text', text: `${value.pass === true ? 'All checks passed.' : 'A check failed.'}\n${lines.join('\n')}` }]
      },
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      await installProbe(browser, session, exec.signal)
      const spec = {
        ...args.selector !== undefined ? { selector: args.selector } : {},
        ...args.text !== undefined ? { text: args.text } : {},
        ...args.url !== undefined ? { url: args.url } : {},
        ...args.js !== undefined ? { js: args.js } : {},
      }
      if (Object.keys(spec).length === 0) throw new Error('dsh_browser_assert: give at least one of selector, text, url or js')
      return await runChecks(browser, session, spec, exec.signal)
    },
  }))

  tools.push(defineTool({
    name: 'dsh_browser_doctor',
    description: 'Report the state of this task\'s browser: page URL, which tools the task restricted away, whether the page probe is installed, and what it has recorded (console lines, responses, dialogs, and how "settled" the page looks). Use it when something behaves oddly and the cause is not visible in the page — before guessing, or before telling the user the browser is broken.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { report: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: String(value.report) }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const task = taskKey(exec)
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      await installProbe(browser, session, exec.signal)
      const url = await pageOperationValue(browser, session, { operation: 'url' }, exec.signal).then(text => text.replace(/^"|"$/g, ''))
      const settle = await probe<{ pending?: number; quietMs?: number; readyState?: string }>(browser, session, 'settle', [], exec.signal)
      const consoleRows = await probe<unknown[]>(browser, session, 'read', ['console', '', 100], exec.signal)
      const networkRows = await probe<unknown[]>(browser, session, 'read', ['network', '', 100], exec.signal)
      const dialogRows = await probe<ProbeRow[]>(browser, session, 'read', ['dialogs', '', 5], exec.signal)
      const restricted = state.restrictedByTask.get(task)
      const lines = [
        `session ${session}`,
        `url ${url || '(unknown)'}`,
        `page ${String(settle?.readyState ?? '?')}, ${String(settle?.pending ?? 0)} request(s) in flight, quiet for ${String(settle?.quietMs ?? 0)}ms`,
        `probe installed (console ${consoleRows.length}/100, network ${networkRows.length}/100, dialogs ${dialogRows.length}/5)`,
        restricted === undefined ? 'restricted: no (this task restricted nothing)' : `restricted: ${restricted.length === 0 ? 'everything' : restricted.join(', ')}`,
        state.configRestrictedTo === undefined ? 'deployment allow-list: none' : `deployment allow-list: ${state.configRestrictedTo.join(', ')}`,
      ]
      return { report: lines.join('\n') }
    },
  }))

  tools.push(defineTool({
    name: 'dsh_browser_help',
    description: 'Look up how to use this browser: a short topic index (locate, wait, batch, dialogs, network, verify, recovery, limits) or one topic\'s text. Use it instead of guessing when a call failed for a reason the error message explains only briefly.',
    parameters: {
      topic: { type: 'string', description: 'One topic name; omit for the index.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: String(value.text) }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args) {
      const topics: Record<string, string> = {
        locate: 'Prefer dsh_browser_a11y (roles, names, states) or dsh_browser_snapshot (numbered elements), then click with {target:{by:"text"|css|xpath, value}}. Elements carry a stable CSS selector, so a click re-resolves the element instead of trusting an index that a re-render invalidates.',
        wait: 'dsh_browser_wait waits for load + an optional URL/selector. dsh_browser_wait_for_response waits for a server answer (that is the "did it submit" wait). dsh_browser_console/network then explain what the page did.',
        batch: 'dsh_browser_do runs several steps in one call: open/tap/field/type/key/scroll/sleep_ms/wait_text/wait_gone/wait_url/wait_idle/wait_js/eval/check. It stops at the first step that cannot proceed and reports which one; a tap whose target is covered by a cookie banner dismisses the banner first.',
        dialogs: 'JavaScript dialogs are answered automatically (default: dismiss). dsh_browser_dialog reports them and can switch to "accept". A dialog from the browser itself (beforeunload, HTTP auth) is not covered — expect a stalled call there and reload.',
        network: 'dsh_browser_network lists fetch/XHR/resource rows. Status 0 means the page never saw a status (aborted, blocked, or a resource-timing row). Only fetch/XHR rows carry a real status.',
        verify: 'dsh_browser_assert asserts selector/text/url/js and returns evidence per assertion. Prefer it over reading a screenshot: "clicked" and "the form accepted it" are different claims, and a retry of an unverified submit can double it.',
        recovery: 'dsh_browser_reset_session closes this task\'s browser session without touching others. dsh_browser_refresh reloads the page. If a carrier was lost, the page context is gone: re-read the page before continuing, and never re-submit something whose result you did not verify.',
        limits: 'There is no CDP escape hatch and no network interception: the probe sees what the page sees. Downloads go through dsh_browser_download and a directory admission gate. Executing page JavaScript is a settings switch the model cannot lift.',
        deliver: 'The browser saves a file and returns an absolute path; sending it to Feishu drive, Baidu Netdisk or any MCP-connected storage is a separate tool call with that path. Report where it sits locally AND what the upload tool answered, never just one. If the upload tool is missing or fails, keep the local file and say so — do not retry somewhere else silently.',
      }
      if (args.topic === undefined) {
        return { text: `Topics: ${Object.keys(topics).join(', ')}\nAsk for one with topic=<name>.` }
      }
      const text = topics[args.topic]
      if (text === undefined) throw new Error(`dsh_browser_help: unknown topic "${args.topic}" (${Object.keys(topics).join(', ')})`)
      return { text }
    },
  }))

  tools.push(defineTool({
    name: 'dsh_browser_do',
    description: 'Run several steps in ONE call and report one compact result: "click search, type a query, press Enter, wait for results" is one call instead of five. Steps run in order and stop at the first that cannot proceed. Each step is an object with exactly one key: open {url} | tap {target} | field {target, text} | type {text} | key {key} | scroll {deltaY} | sleep_ms {ms} | wait_text {text} | wait_gone {text} | wait_url {url} | wait_idle {} | wait_js {script, intervalMs?} | eval {script} | check {selector|text|url|js}. A tap whose target is covered by a cookie banner or modal dismisses it first. Waits know when the page has settled and return as soon as the condition holds.',
    parameters: {
      steps: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true, description: 'Steps, in order (max 40).' },
      timeoutMs: { type: 'number', description: 'Budget for the whole batch (default 60000, capped by the tool timeout).' },
      autoDismiss: { type: 'boolean', description: 'Clear a covering banner before a tap (default true).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          completed: { type: 'number', required: true },
          total: { type: 'number', required: true },
          ok: { type: 'boolean', required: true },
          stoppedAt: { type: 'number' },
          reason: { type: 'string' },
          sideEffectMayHaveHappened: { type: 'boolean' },
          log: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
        },
      },
      render: (_args, value) => {
        const rows = value.log as ProbeRow[]
        const head = value.ok === true
          ? `${String(value.completed)}/${String(value.total)} steps done.`
          : `Stopped at step ${String(value.stoppedAt)} (${String(value.completed)}/${String(value.total)} done): ${String(value.reason)}`
        const warning = value.ok === false && value.sideEffectMayHaveHappened === true
          ? '\nA step that can change the page already ran: the site may have acted on it. Read the site\'s own record before retrying — do not repeat it on the assumption that it failed.'
          : ''
        return [{ type: 'text', text: [head + warning, ...rows.map(row => `  ${String(row.index)} ${String(row.kind)}: ${String(row.detail)}`)].join('\n') }]
      },
    },
    timeoutMs,
    isConcurrencySafe: () => false, // drives the page; exclusive within a task
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_do', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const steps = Array.isArray(args.steps) ? args.steps as ProbeRow[] : []
      if (steps.length === 0) throw new Error('dsh_browser_do: "steps" must be a non-empty array')
      if (steps.length > 40) throw new Error('dsh_browser_do: at most 40 steps per call — split the work')
      await installProbe(browser, session, exec.signal)
      const autoDismiss = args.autoDismiss !== false
      const budget = Math.min(args.timeoutMs ?? timeoutMs, maxWaitMs)
      const deadline = Date.now() + budget
      const log: Array<{ index: number; kind: string; detail: string; value?: string }> = []
      // Set once a step that can change server state has run. A failure after that point must not
      // read like a failure before it: measured on the first real benchmark run, where a batch died
      // after the form had already been submitted and the message said nothing about it.
      let dispatched = false
      const dispatchable = new Set(['tap', 'key', 'eval'])
      const kinds = ['open', 'tap', 'field', 'type', 'key', 'scroll', 'sleep_ms', 'wait_text', 'wait_gone', 'wait_url', 'wait_idle', 'wait_js', 'eval', 'check']

      /** Resolve a target: a string is visible text; an object passes through. */
      const asTarget = (value: unknown): { by: 'css' | 'text' | 'xpath'; value: string } | undefined => {
        if (typeof value === 'string' && value !== '') return { by: 'text', value }
        if (value !== null && typeof value === 'object') {
          const raw = value as { by?: unknown; value?: unknown }
          if (typeof raw.value === 'string' && raw.value !== '') {
            const by = raw.by === 'css' || raw.by === 'xpath' || raw.by === 'text' ? raw.by : 'text'
            return { by, value: raw.value }
          }
        }
        return undefined
      }

      for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index] ?? {}
        const keys = Object.keys(step).filter(key => kinds.includes(key))
        if (keys.length !== 1) {
          return { ok: false, completed: index, total: steps.length, stoppedAt: index + 1, reason: `step ${index + 1} must have exactly one of: ${kinds.join(', ')}`, log }
        }
        const kind = keys[0] as string
        const value = step[kind]
        if (Date.now() > deadline) {
          return { ok: false, completed: index, total: steps.length, stoppedAt: index + 1, reason: `budget of ${Math.round(budget / 1000)}s exhausted`, log }
        }
        try {
          let detail = 'ok'
          if (kind === 'open') {
            const url = typeof value === 'string' ? value : (value as { url?: unknown })?.url
            if (typeof url !== 'string') throw new Error('open needs a URL string or {url}')
            await browser.openUrl(session, { url }, exec.signal)
            detail = url
          } else if (kind === 'tap') {
            const target = asTarget((value as { target?: unknown })?.target ?? value)
            if (target === undefined) throw new Error('tap needs a target (text, or {by, value})')
            if (autoDismiss) {
              const rect = await probeLive<{ x?: number; y?: number; described?: string } | null>(browser, session, 'find', [{ [target.by]: target.value }], exec.signal)
              if (rect && typeof rect.x === 'number' && typeof rect.y === 'number') {
                const cover = await probeLive<{ covers?: string | null; dismiss?: { label?: string; x?: number; y?: number } | null }>(browser, session, 'overlayAt', [rect.x, rect.y], exec.signal)
                if (cover?.dismiss && typeof cover.dismiss.x === 'number' && typeof cover.dismiss.y === 'number') {
                  await browser.click(session, { x: cover.dismiss.x, y: cover.dismiss.y }, exec.signal)
                  detail = `dismissed "${String(cover.dismiss.label)}" first`
                  await pause(150)
                } else if (cover?.covers !== null && cover?.covers !== undefined && cover.covers !== rect.described) {
                  // Measured on the fixture's human gate: a hidden form left the tap hitting `<html>`,
                  // the step reported "ok", and nothing was submitted. A click that cannot land is a
                  // FAILURE, not a note — a silent no-op is the worst result this tool can return.
                  throw new Error(`the target is not reachable: ${String(cover.covers)} is at that point, not ${String(rect.described)} (hidden, or covered by an overlay that cannot be dismissed)`)
                }
              }
            }
            await browser.click(session, { target }, exec.signal)
          } else if (kind === 'field') {
            const spec = value as { target?: unknown; text?: unknown }
            const target = asTarget(spec?.target)
            if (target === undefined || typeof spec?.text !== 'string') throw new Error('field needs {target, text}')
            await browser.setValue(session, { target, value: spec.text }, exec.signal)
            detail = `${target.value} ← ${spec.text.slice(0, 40)}`
          } else if (kind === 'type') {
            const text = typeof value === 'string' ? value : (value as { text?: unknown })?.text
            if (typeof text !== 'string') throw new Error('type needs a text string or {text}')
            await browser.type(session, { text }, exec.signal)
            detail = text.slice(0, 40)
          } else if (kind === 'key') {
            const key = typeof value === 'string' ? value : (value as { key?: unknown })?.key
            if (typeof key !== 'string') throw new Error('key needs a key name or {key}')
            await browser.key(session, { key: key as never }, exec.signal)
            detail = key
          } else if (kind === 'scroll') {
            const deltaY = typeof value === 'number' ? value : Number((value as { deltaY?: unknown })?.deltaY ?? Number.NaN)
            if (!Number.isFinite(deltaY)) throw new Error('scroll needs a number or {deltaY}')
            await browser.scroll(session, { deltaY }, exec.signal)
            detail = String(deltaY)
          } else if (kind === 'sleep_ms') {
            const requestedMs = typeof value === 'number' ? value : (value as { ms?: unknown })?.ms
            if (typeof requestedMs !== 'number' || !Number.isFinite(requestedMs) || requestedMs < 0) throw new Error('sleep_ms needs a non-negative number or {ms}')
            const ms = Math.min(requestedMs, 10_000)
            await pause(ms)
            detail = `${ms}ms`
          } else if (kind === 'wait_text' || kind === 'wait_gone') {
            const want = typeof value === 'string' ? value : (value as { text?: unknown })?.text
            if (typeof want !== 'string') throw new Error('wait_text/wait_gone need text or {text}')
            const found = await poll(async () => {
              const present = (await pageOperationValue(browser, session, { operation: 'text', text: want }, exec.signal)) === 'true'
              return (kind === 'wait_text' ? present : !present) ? true : undefined
            }, Math.max(1_000, Math.min(deadline - Date.now(), 30_000)))
            if (found === undefined) throw new Error(`timed out waiting for "${want}" to be ${kind === 'wait_text' ? 'present' : 'gone'}`)
            detail = want
          } else if (kind === 'wait_url') {
            const want = typeof value === 'string' ? value : (value as { url?: unknown })?.url
            if (typeof want !== 'string') throw new Error('wait_url needs a URL fragment or {url}')
            const budget = Math.max(1_000, Math.min(deadline - Date.now(), 30_000))
            const hit = await poll(async () => {
              const href = (await pageOperationValue(browser, session, { operation: 'url' }, exec.signal)).replace(/^"|"$/g, '')
              return href.includes(want) ? href : undefined
            }, budget)
            if (hit === undefined) throw new Error(`timed out waiting for the URL to contain "${want}"`)
            detail = hit
          } else if (kind === 'wait_idle') {
            const idle = await poll(async () => {
              const settle = await probeLive<{ pending?: number; quietMs?: number; readyState?: string }>(browser, session, 'settle', [], exec.signal)
              const quiet = Number(settle?.quietMs ?? 0)
              return Number(settle?.pending ?? 0) === 0 && quiet >= 300 ? settle : undefined
            }, Math.max(1_000, Math.min(deadline - Date.now(), 30_000)))
            if (idle === undefined) throw new Error('timed out waiting for the page to go quiet')
            detail = `quiet for ${String(idle.quietMs)}ms`
          } else if (kind === 'wait_js') {
            const spec = typeof value === 'string' ? { script: value } : value as { script?: unknown; intervalMs?: unknown }
            if (typeof spec?.script !== 'string') throw new Error('wait_js needs a script string or {script, intervalMs}')
            const script = spec.script
            const interval = Math.min(Math.max(Number(spec.intervalMs ?? 200) || 200, 50), 5_000)
            let last = 'nothing yet'
            const started = Date.now()
            const hit = await poll(async () => {
              let raw: string
              try { raw = await pageValue(browser, session, script, exec.signal) } catch (error) {
                last = error instanceof Error ? error.message : String(error)
                return undefined
              }
              last = raw
              let parsed: unknown
              try { parsed = JSON.parse(raw) } catch { parsed = raw }
              return parsed ? raw : undefined
            }, Math.max(0, deadline - Date.now()), interval)
            if (hit === undefined) throw new Error(`timed out after ${Date.now() - started}ms waiting for the script to return a truthy value; last result: ${last.slice(0, 200)}`)
            log.push({ index: index + 1, kind, detail: hit.slice(0, 80), value: hit })
            continue
          } else if (kind === 'eval') {
            const script = typeof value === 'string' ? value : (value as { script?: unknown })?.script
            if (typeof script !== 'string') throw new Error('eval needs a script string or {script}')
            const text = await pageValue(browser, session, script, exec.signal)
            detail = text.slice(0, 80)
          } else if (kind === 'check') {
            const result = await runChecks(browser, session, value as { selector?: string; text?: string; url?: string; js?: string }, exec.signal)
            if (!result.pass) {
              const failed = result.checks.filter(check => !check.pass).map(check => `${check.kind}: ${check.expected} → ${check.actual}`)
              throw new Error(`check failed (${failed.join('; ')})`)
            }
            detail = `${result.checks.length} check(s) passed`
          }
          if (dispatchable.has(kind)) dispatched = true
          log.push({ index: index + 1, kind, detail })
        } catch (error) {
          return {
            ok: false,
            completed: index,
            total: steps.length,
            stoppedAt: index + 1,
            reason: error instanceof Error ? error.message : String(error),
            sideEffectMayHaveHappened: dispatched,
            log: [...log, { index: index + 1, kind, detail: `failed: ${error instanceof Error ? error.message : String(error)}` }],
          }
        }
      }
      return { ok: true, completed: steps.length, total: steps.length, log }
    },
  }))

  return tools
}

const isReadMethod = (method: unknown): boolean => method === undefined || /^(GET|HEAD)$/i.test(String(method))

/** What dsh_browser_data_sources finds; rows are the probe's own, kept loose. */
export interface DataSources {
  readonly url: string
  readonly embedded: readonly { name: string; bytes: number; parsed?: boolean; keys?: readonly string[]; arrays?: readonly { path: string; length: number }[] }[]
  readonly apis: readonly { method: string; url: string; status: number; type?: string; calls?: number }[]
  readonly resources: readonly { url: string; initiator?: string; bytes?: number }[]
  readonly declared: readonly { from: string; url: string }[]
}

/** The compact text form: one line per source, so the answer stays around 1-2 KB. */
export function formatDataSources(found: DataSources): string {
  const kb = (bytes: number | undefined): string => bytes === undefined || bytes <= 0 ? '' : bytes < 1024 ? ` ${bytes} B` : ` ${(bytes / 1024).toFixed(1)} KB`
  const lines: string[] = []
  if (found.embedded.length > 0) {
    lines.push('Embedded state:')
    for (const item of found.embedded) {
      const keys = item.keys !== undefined && item.keys.length > 0 ? ` keys: ${item.keys.join(', ')}` : item.parsed === false ? ' (not JSON)' : ''
      const arrays = item.arrays !== undefined && item.arrays.length > 0 ? `; arrays: ${item.arrays.map(row => `${row.path} (${row.length})`).join(', ')}` : ''
      lines.push(`  ${item.name}${kb(item.bytes)}${keys}${arrays}`)
    }
  }
  if (found.apis.length > 0) {
    lines.push('APIs the page called:')
    for (const row of found.apis) lines.push(`  ${row.method} ${row.status}${row.type ? ` ${row.type}` : ''}${row.calls !== undefined && row.calls > 1 ? ` ×${row.calls}` : ''} ${row.url}`)
  }
  if (found.resources.length > 0) {
    lines.push('Data-like resources (resource timing, includes requests before the probe):')
    for (const row of found.resources) lines.push(`  ${row.initiator ?? ''}${kb(row.bytes)} ${row.url}`.replace(/^ {2} /, '  '))
  }
  if (found.declared.length > 0) {
    lines.push('Declared endpoints:')
    for (const row of found.declared) lines.push(`  ${row.from} ${row.url}`)
  }
  return lines.length === 0
    ? `No embedded state, JSON APIs or declared endpoints found on ${found.url}; read the DOM.`
    : lines.join('\n')
}
