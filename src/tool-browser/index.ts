/**
 * Model-facing browser tools over `ctx.browser`, assembled: config, the prompt guides, safe
 * registration, the `core` surface's loader and the code tool. The tools live in `tools-*.ts`,
 * their shared per-apply state in `state.ts` and the page-probe client in `probe-client.ts`.
 *
 * Session lifecycle is owned at the plugin level: each calling task (a DSH session) gets its own
 * browser session, so concurrent tasks never fight over tabs, history, or navigation state.
 * @module dsh-browser/tool-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import { BrowserTakeovers, installTakeovers } from './takeover.ts'
import { TAKEOVER_TOOL } from '../takeover-protocol.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { BrowserToolError, toBrowserToolError } from './errors.ts'
import { CODE_PROMPT, CODE_TOOL, createCodeTool, type CatalogTool, type PagePulse } from './code-tool.ts'
import { pageOperationValue } from './probe-client.ts'
import { SettingsStore } from '../browser-electron/settings-store.ts'
import { browserSessionHandle, resolveTabHandle } from '../browser/handles.ts'
import { readSurface, createState, liveStates, READ_ONLY_TOOLS, taskKey, type ToolScope, maxWaitFor, MAX_FILL_FIELDS, REGISTRATION_ORDER } from './state.ts'
import { navigationTools } from './tools-navigation.ts'
import { TOOL_DEFAULT_TIMEOUT_MS } from '../../assets/browser-policy.mjs'
import { observationTools } from './tools-observation.ts'
import { interactionTools } from './tools-interaction.ts'
import { debugTools } from './tools-debug.ts'
import { referenceTools } from './tools-reference.ts'
import { ptcRuntimeActive, registerTool } from '../compat/host-features.ts'

export { READ_ONLY_TOOLS, internals } from './state.ts'

// One line at registration: tool handlers are registered once per host start, and a recomposition does
// not re-register them. Printing the resolved surface here is the only reliable way to tell WHICH build a
// live host is actually running, instead of inferring it from behaviour.
try { console.log('[tool-browser] registered, surface=' + readSurface()) } catch { /* logging only */ }

/** Plugin name used by loader diagnostics. */
export const name = 'tool-browser'
/** The tool registry, browser seam, and system-prompt registry this tool layer consumes. */
export const inject = ['tools', 'browser', 'systemPrompt']

/** Plugin config: tool timeouts and session defaults. */
export interface Config {
  /** Cooperative tool-call budget in ms. Default 60000. */
  readonly timeoutMs?: number
  /** Whether to offer tab-management tools. Default true. */
  readonly tabTools?: boolean
  /** Optional initial allow-list of browser tool names; other tools are refused. */
  readonly allowedActions?: readonly string[]
  /**
   * What the model sees. "core" (default): core browser tools, dsh_browser_load_tools and
   * dsh_browser_code (which steps aside under PTC). "code": one dsh_browser_code tool whose
   * script calls every browser action as a helper, plus dsh_browser_request_takeover. "tools":
   * every action as its own tool.
   */
  readonly surface?: 'core' | 'code' | 'tools'
}

/** Tool loaded on demand: registers a group of browser tools for the rest of the run. */
export const LOAD_TOOL = 'dsh_browser_load_tools'

/** Tools the model sees from the start on the default `core` surface. */
export const CORE_TOOLS: ReadonlySet<string> = new Set([
  'dsh_browser_open', 'dsh_browser_snapshot', 'dsh_browser_a11y', 'dsh_browser_click', 'dsh_browser_type',
  'dsh_browser_key', 'dsh_browser_scroll', 'dsh_browser_select', 'dsh_browser_fill', 'dsh_browser_wait',
  'dsh_browser_content', 'dsh_browser_find', 'dsh_browser_scrape', 'dsh_browser_screenshot',
  'dsh_browser_execute', 'dsh_browser_do', 'dsh_browser_state', 'dsh_browser_challenge',
  'dsh_browser_list_tabs', 'dsh_browser_switch_tab', 'dsh_browser_close_tab', 'dsh_browser_back',
  'dsh_browser_reference_capture', 'dsh_browser_reference_reveal', 'dsh_browser_reference_list',
  'dsh_browser_request_takeover', 'dsh_browser_help',
])

/**
 * The rest of the catalog, loaded by group with dsh_browser_load_tools. A loaded tool is never
 * unregistered, so the tool list only grows and the request prefix stays cacheable. Any tool not
 * named here or in CORE_TOOLS belongs to `more`.
 */
export const TOOL_GROUPS: Readonly<Record<string, readonly string[]>> = {
  forms: ['dsh_browser_check', 'dsh_browser_clear', 'dsh_browser_set_value', 'dsh_browser_get_value', 'dsh_browser_upload', 'dsh_browser_drag', 'dsh_browser_hover', 'dsh_browser_dialog', 'dsh_browser_click_sequence'],
  navigation: ['dsh_browser_forward', 'dsh_browser_refresh', 'dsh_browser_history', 'dsh_browser_replay', 'dsh_browser_visited', 'dsh_browser_download'],
  debug: ['dsh_browser_console', 'dsh_browser_network', 'dsh_browser_wait_for_response', 'dsh_browser_data_sources', 'dsh_browser_fetch_json', 'dsh_browser_assert', 'dsh_browser_doctor'],
  session: ['dsh_browser_session', 'dsh_browser_reset', 'dsh_browser_reset_session', 'dsh_browser_restrict', 'dsh_browser_auth', 'dsh_browser_shortcuts'],
  more: [],
}

/**
 * Minimal static routing hint for the `core` surface. Detailed tool guidance lives in each tool's
 * description, runtime CHALLENGE banners, and SKILL.md so unrelated conversations do not pay for
 * a long global manual or inherit cross-plugin behavior rules.
 */
const CORE_PROMPT = 'Use dsh_browser_* tools to drive the built-in browser (per-task isolated sessions). For multi-step or multi-page work, batch calls in dsh_browser_code (or run_code when PTC is active) and load extra groups on demand with dsh_browser_load_tools; follow any CHALLENGE banner recovery advice.'

/** Minimal static routing hint for the `tools` surface. */
const TOOLS_PROMPT = 'Use dsh_browser_* tools to drive the built-in browser (per-task isolated sessions). Prefer dsh_browser_a11y or dsh_browser_snapshot to locate targets, dsh_browser_do for multi-step runs, and follow any CHALLENGE banner recovery advice.'

/** Register all browser tools with `ctx.tools`. */
export function apply(ctx: Context, config: Config = {}): void {
  const timeoutMs = config.timeoutMs ?? TOOL_DEFAULT_TIMEOUT_MS
  const surface = config.surface ?? 'core'
  const maxWaitMs = maxWaitFor(timeoutMs)
  const maxFillFields = MAX_FILL_FIELDS
  // Per-context state: sessions, in-flight opens, and the restriction are
  // scoped to THIS plugin apply, so parallel contexts never share sessions
  // or leak restrictions into each other.
  const state = createState()
  const takeovers = new BrowserTakeovers()
  installTakeovers(ctx, takeovers)
  liveStates.add(state)
  ctx.effect(() => () => { liveStates.delete(state) })
  // Re-apply resets the restriction: an omitted allowedActions lifts it.
  state.configRestrictedTo = config.allowedActions !== undefined ? [...config.allowedActions] : undefined

  ctx.systemPrompt.section({
    name: 'tool:dsh-browser-reference-presentation',
    order: 151,
    text: 'Browser references are already displayed as interactive capsules. The capsules provide source navigation. Do not repeat browser-reference markers, dsh-browser-ref: URIs, source URLs, or source/citation links in replies; answer using the quoted content instead.',
  })

  ctx.systemPrompt.section({
    name: 'tool:dsh-builtin-browser',
    // Tool guidance band is 100-199; 150 keeps clear of the common 110/120
    // tool sections so ordering does not depend on plugin load sequence.
    order: 150,
    text: surface === 'code'
      ? CODE_PROMPT
      : surface === 'core'
      ? CORE_PROMPT
      : TOOLS_PROMPT,
  })

  /**
   * Register one tool, turning a name collision into a warning instead of a dead apply.
   *
   * Registering the tools in sequence without this is how ONE taken name becomes thirty-two
   * missing ones: the throw aborts the rest of the apply, and what the user sees is a plugin that
   * half-exists. That is precisely the shape of the failure reported against a sibling plugin,
   * where the first spec collided and all six vanished behind a `console.warn` a desktop user
   * never sees.
   *
   * A name this plugin cannot have is worth a sentence in the log, not the toolset.
   * @param definition - the tool to register.
   */
  // One store for this apply: it caches by mtime, so reading it per download is a stat, not a parse.
  const settingsStore = new SettingsStore()

  const catalog = new Map<string, CatalogTool>()
  const loaded = new Set<string>()
  const registerSafely = (definition: ReturnType<typeof defineTool>): void => {
    try {
      const execute = definition.execute.bind(definition)
      const name = definition.name
      definition = { ...definition, execute: async (args, exec) => {
        const owner = taskKey(exec)
        if (name !== TAKEOVER_TOOL && takeovers.blocks(owner)
          && (!READ_ONLY_TOOLS.has(name) || ['dsh_browser_reset', 'dsh_browser_reset_session', 'dsh_browser_reference_reveal'].includes(name))) {
          const requested = (args as { tabId?: string }).tabId
          let tab = requested
          if (requested?.startsWith('dsh-tab:')) {
            const session = state.sessionsByTask.get(owner)
            if (session) tab = resolveTabHandle(browserSessionHandle(owner, session), requested).tab
          }
          if (tab === undefined || takeovers.blocks(owner, tab)) {
            throw new BrowserToolError('Browser tab is awaiting human takeover. Agent browser actions are refused until the human confirms completion or skips the request.', 'BROWSER_TAKEOVER_PENDING')
          }
        }
        try {
          return await execute(args, exec)
        } catch (error) {
          throw toBrowserToolError(error, (exec as { signal?: AbortSignal } | undefined)?.signal)
        }
      } }
      catalog.set(definition.name, definition as unknown as CatalogTool)
      if (surface === 'tools' || definition.name === TAKEOVER_TOOL || (surface === 'core' && CORE_TOOLS.has(definition.name))) {
        ctx.tools.register(definition)
        loaded.add(definition.name)
      }
    } catch (error) {
      ctx.logger?.warn?.(
        `dsh-builtin-browser: could not register ${definition.name} (${String(error)}). Another `
        + 'plugin has probably taken that name — browser tool names are a shared namespace. The '
        + 'rest of this plugin\'s tools are unaffected.',
      )
    }
  }

  const scope: ToolScope = { ctx, config, state, takeovers, settingsStore, timeoutMs, maxWaitMs, maxFillFields, surface }
  const definitions = new Map([
    ...debugTools(scope), ...navigationTools(scope), ...observationTools(scope),
    ...interactionTools(scope), ...referenceTools(scope),
  ].map(definition => [definition.name, definition] as const))
  for (const toolName of REGISTRATION_ORDER) {
    const definition = definitions.get(toolName)
    if (definition !== undefined) registerSafely(definition)
  }

  if (surface !== 'tools') {
    try {
      // Reads the page the action left behind without starting a session or installing the probe.
      const pulse = async (exec: never): Promise<PagePulse | undefined> => {
        const browser = ctx.get('browser')
        const session = state.sessionsByTask.get(taskKey(exec))
        if (browser === undefined || session === undefined) return undefined
        try {
          const raw = JSON.parse(await pageOperationValue(browser, session, { operation: 'pulse' }, (exec as { signal?: AbortSignal }).signal)) as Partial<PagePulse> | null
          if (typeof raw?.title !== 'string') return undefined
          return {
            title: raw.title,
            alerts: Array.isArray(raw.alerts) ? raw.alerts.filter(text => typeof text === 'string') : [],
            dialogs: Array.isArray(raw.dialogs) ? raw.dialogs.filter(row => typeof row?.at === 'number' && typeof row.kind === 'string') : [],
            probe: Number(raw.probe) || 0,
          }
        } catch {
          return undefined
        }
      }
      const code = createCodeTool(catalog, pulse)
      // On the code surface it is the only browser tool, so it stays even under PTC; on `core`,
      // DSH's PTC run_code already batches every tool, so the code tool steps aside.
      registerTool(ctx.tools, code.tool, surface === 'core' ? (context?: { readonly agent?: unknown }) => !ptcRuntimeActive(ctx, context) : undefined)
      ctx.effect(() => code.dispose)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-builtin-browser: could not register ${CODE_TOOL} (${String(error)}).`)
    }
  }
  if (surface === 'core') {
    const grouped = new Set(Object.values(TOOL_GROUPS).flat())
    const members = (group: string): string[] => group === 'more'
      ? [...catalog.keys()].filter(name => !CORE_TOOLS.has(name) && !grouped.has(name)).sort()
      : (TOOL_GROUPS[group] ?? []).filter(name => catalog.has(name))
    try {
      const loader = defineTool({
        name: LOAD_TOOL,
        description: `Load more browser tools by group; they stay available for the rest of the run. Groups: ${Object.entries(TOOL_GROUPS).map(([group, names]) => `${group} (${group === 'more' ? 'every other browser tool' : names.map(name => name.slice('dsh_browser_'.length)).join(', ')})`).join('; ')}. dsh_browser_code can already call every tool without loading it.`,
        parameters: {
          groups: { type: 'array', items: { type: 'string', enum: Object.keys(TOOL_GROUPS) }, required: true, description: 'Groups to load.' },
        },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: {
            loaded: { type: 'array', items: { type: 'string' }, required: true },
            available: { type: 'array', items: { type: 'string' }, required: true },
          } },
          render: (_args, value) => [{ type: 'text', text: value.loaded.length > 0 ? `Loaded: ${value.loaded.join(', ')}.` : `Already loaded: ${value.available.join(', ')}.` }],
        },
        isConcurrencySafe: () => false,
        async execute(args) {
          const groups = Array.isArray(args.groups) ? args.groups.map(String) : []
          const unknown = groups.filter(group => !(group in TOOL_GROUPS))
          if (groups.length === 0 || unknown.length > 0) throw new BrowserToolError(`unknown tool group(s): ${unknown.join(', ') || '(none given)'}; groups are ${Object.keys(TOOL_GROUPS).join(', ')}`, 'BROWSER_UNKNOWN_TOOL_GROUP')
          const names = [...new Set(groups.flatMap(members))]
          const fresh: string[] = []
          for (const name of names) {
            const definition = catalog.get(name)
            if (definition === undefined || loaded.has(name)) continue
            ctx.tools.register(definition as unknown as ReturnType<typeof defineTool>)
            loaded.add(name)
            fresh.push(name)
          }
          return { loaded: fresh, available: names }
        },
      })
      ctx.tools.register(loader)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-builtin-browser: could not register ${LOAD_TOOL} (${String(error)}).`)
    }
  }
}
