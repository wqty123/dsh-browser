/**
 * Interaction tools: click, type, key, scroll, forms, drag, hover, upload, download and delivery.
 * @module dsh-browser/tool-browser/tools-interaction
 */

import { statSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertAllowed, type ExecAgent, agentOf, taskKey, ensureSession, type ToolScope, type ToolDefinition } from './state.ts'
import { effectProperties, pageFingerprint, observedEffect, effectText, pageOperationValue, installProbe, probe, pause, type ProbeRow } from './probe-client.ts'

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/**
 * Read a target's `index`, refusing the values that cannot mean anything.
 *
 * The index is looked up in the page (`els[index] ?? null`), so a negative one — `-1`, the
 * common "give me the last one" shorthand — matches nothing. The page script then treated
 * that as "not on the page yet" and polled for its whole 10s budget before reporting
 * "element not found", which reads like a slow page rather than a bad argument. Refusing it
 * here names the real problem immediately.
 * @param target - the caller's target, or undefined when there is none.
 * @returns the index, or undefined to let the page default to 0.
 */
export function targetIndex(target: { readonly index?: unknown } | undefined): number | undefined {
  const index = target?.index
  if (index === undefined) return undefined
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
    throw new Error(`target.index must be a non-negative integer (got ${JSON.stringify(index)}); it is a 0-based position among the matches, and negative values such as -1 match nothing — pass the position you want, or narrow the selector`)
  }
  return index
}

/** Coerce a tool-provided string value back to boolean/number only when lossless. */
export function parseFillValue(v: string | undefined): string | number | boolean {
  if (v === 'true') return true
  if (v === 'false') return false
  // Deliberately NOT coerced to a number. The description says numbers are accepted in
  // string form, and callers pass account numbers, postcodes and zero-padded ids through
  // here: "007" became "7" and "1e3" became "1000", which silently rewrote the value they
  // meant to type. A numeric-looking string is a string; the DOM decides how to store it.
  return v ?? ''
}

/**
 * Define this module's tools for one apply.
 * @param scope - the apply's context, settings and per-apply state.
 * @returns the tool definitions, for the entry to register.
 */
export function interactionTools(scope: ToolScope): ToolDefinition[] {
  const { ctx, state, settingsStore, timeoutMs, maxFillFields } = scope
  const tools: ToolDefinition[] = []

  tools.push(defineTool({
    name: 'dsh_browser_execute',
    description: 'Execute JavaScript in the shared-browser page context. This is the primary way to interact with page elements: focus, fill inputs (use the native value setter for framework-controlled inputs, then dispatch an input event), click buttons (element.click() or a constructed MouseEvent). Returns the evaluation result by value, or the exception text.',
    parameters: {
      script: { type: 'string', required: true, description: 'The JavaScript expression to evaluate in the page context.' },
      args: { type: 'array', items: { type: 'string' }, description: 'Optional arguments injected into the script scope as arguments[0..n].' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          value: { type: 'string' },
          exception: { type: 'string' },
        },
      },
      // A return value is whatever the page produced, and `document.body.outerHTML` measured
      // 157,350 characters — ~39-52k tokens from one call. Bounded, with the cut stated so the
      // caller knows to narrow the expression rather than the value being silently short.
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: `Exception: ${value.exception}` }]
        const rendered = String(value.value ?? '')
        const cap = 50_000
        const text = rendered.length > cap
          ? `Result: ${rendered.slice(0, cap)}\n(result truncated at ${cap} of ${rendered.length} characters — return a smaller value, or write it with dsh_browser_execute + a variable)`
          : `Result: ${rendered}`
        return [{ type: 'text', text }]
      },
    },
    timeoutMs,
    isConcurrencySafe: () => false, // page JS can be stateful
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_execute', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const result = await browser.execute(session, {
        script: args.script,
        args: args.args ?? [],
      }, exec.signal)
      if (result.ok) {
        const raw = result.value
        const value = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null)
        return { ok: true, value }
      }
      return { ok: false, exception: result.exception }
    },
  }))

  tools.push(defineTool({
    name: 'dsh_browser_click',
    description: 'Click in the shared browser. Prefer target {by: css|text|xpath, value, index?}: the element is located from the DOM, scrolled into view, and clicked at its centre — no image input needed, and the only form that works without vision. Alternatively x/y viewport coordinates, meaningful only after a vision model located the element on a dsh_browser_screenshot; refused under the non-visual strategy. Provide exactly one of target or x/y.',
    parameters: {
      target: {
        type: 'object',
        additionalProperties: false,
        properties: {
          by: { type: 'string', enum: ['css', 'text', 'xpath'], description: 'Locator kind (default css). text matches an element\'s own visible text, exact first then contains.' },
          value: { type: 'string', required: true, description: 'The CSS selector, visible text, or XPath expression.' },
          index: { type: 'number', description: '0-based index of the match (default 0).' },
        },
        description: 'Locate the element semantically and click it (css/text/xpath).',
      },
      x: { type: 'number', description: 'Viewport x coordinate (CSS px), taken from a dsh_browser_screenshot read by a vision model. Prefer a semantic target — it works without image input.' },
      y: { type: 'number', description: 'Viewport y coordinate (CSS px), taken from the same screenshot as x.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { clicked: { type: 'boolean', required: true }, ...effectProperties } },
      render: (_args, value) => [{ type: 'text', text: value.clicked ? 'Clicked.' + effectText(value) : 'Click failed.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_click', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const target = args.target as { by?: string; value?: string; index?: number } | undefined
      // A target whose value is empty is a caller mistake, not a request to fall back.
      // Degrading silently sent typed text to whatever held focus — possibly a password
      // field — or dropped the semantic target in favour of coordinates.
      if (target !== undefined && typeof target.value === 'string' && target.value === '') {
        throw new Error('target.value is empty; pass a css selector, visible text or XPath, or omit target entirely to use x/y')
      }
      const index = targetIndex(target)
      const before = await pageFingerprint(browser, session)
      if (target !== undefined && typeof target.value === 'string' && target.value !== '') {
        await browser.click(session, {
          target: {
            by: (target.by === 'text' || target.by === 'xpath' ? target.by : 'css') as 'css' | 'text' | 'xpath',
            value: target.value,
            ...index !== undefined ? { index } : {},
          },
        }, exec.signal)
      } else {
        if (typeof args.x !== 'number' || typeof args.y !== 'number') {
          throw new Error('dsh_browser_click: provide a target (css/text/xpath) or x/y coordinates')
        }
        await browser.click(session, { x: args.x, y: args.y }, exec.signal)
      }
      return { clicked: true, ...await observedEffect(browser, session, before) }
    },
  }))

  tools.push(defineTool({
    name: 'dsh_browser_click_sequence',
    description: 'Click many points in order, in one call. Use this instead of repeated dsh_browser_click when a page needs a run of coordinate clicks — a canvas board, a map, a drawing surface. Each point is clicked with the same real input sequence the single click uses; between points the call waits intervalMs (default 40 ms), which is what stops a page from reading two presses as a double click. Stops at the first point that fails and says where, so a run that half-landed is reported rather than looking complete.',
    parameters: {
      points: {
        type: 'array',
        required: true,
        description: 'Points to click, in order, in viewport CSS pixels — the same space dsh_browser_screenshot reports.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            x: { type: 'number', required: true, description: 'Viewport x in CSS px.' },
            y: { type: 'number', required: true, description: 'Viewport y in CSS px.' },
          },
        },
      },
      intervalMs: { type: 'number', description: 'Milliseconds between points (default 40).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          clicked: { type: 'number', required: true, description: 'How many points landed.' },
          ...effectProperties,
          failedAt: { type: 'number', description: 'Index of the point that failed, when one did.' },
          error: { type: 'string', description: 'Why that point failed.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.failedAt === undefined
          ? `Clicked ${String(value.clicked)} point(s).` + effectText(value)
          : `Clicked ${String(value.clicked)} point(s), then stopped at index ${String(value.failedAt)}: ${String(value.error ?? 'unknown')}`,
      }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_click_sequence', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const points = Array.isArray(args.points) ? args.points : []
      const intervalMs = typeof args.intervalMs === 'number' ? args.intervalMs : undefined
      const before = await pageFingerprint(browser, session)
      const result = await browser.clickSequence(session, { points, ...intervalMs === undefined ? {} : { intervalMs } })
      return { ...result, ...await observedEffect(browser, session, before) }
    },
  }))

  tools.push(defineTool({
    name: 'dsh_browser_type',
    description: 'Type text into the focused element of the shared browser, or into a located element (pass target {by: css|text|xpath, value, index?} to focus it first). Text is inserted at the focus via CDP Input.insertText. For setting whole field values (and React-controlled inputs) prefer dsh_browser_set_value; use dsh_browser_key for Enter/Tab/arrows.',
    parameters: {
      text: { type: 'string', required: true, description: 'The text to insert.' },
      target: {
        type: 'object',
        additionalProperties: false,
        properties: {
          by: { type: 'string', enum: ['css', 'text', 'xpath'], description: 'Locator kind (default css).' },
          value: { type: 'string', required: true, description: 'The CSS selector, visible text, or XPath expression.' },
          index: { type: 'number', description: '0-based index of the match (default 0).' },
        },
        description: 'Focus this element first, then type (css/text/xpath).',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { typed: { type: 'boolean', required: true }, ...effectProperties } },
      render: (_args, value) => [{ type: 'text', text: value.typed ? `Typed ${String(_args.text).length} chars.` + effectText(value) : 'Type failed.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_type', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const target = args.target as { by?: string; value?: string; index?: number } | undefined
      // A target whose value is empty is a caller mistake, not a request to fall back.
      // Degrading silently sent typed text to whatever held focus — possibly a password
      // field — or dropped the semantic target in favour of coordinates.
      if (target !== undefined && typeof target.value === 'string' && target.value === '') {
        throw new Error('target.value is empty; pass a css selector, visible text or XPath, or omit target entirely to use x/y')
      }
      const index = targetIndex(target)
      const before = await pageFingerprint(browser, session)
      if (target !== undefined && typeof target.value === 'string' && target.value !== '') {
        await browser.type(session, {
          text: args.text,
          target: {
            by: (target.by === 'text' || target.by === 'xpath' ? target.by : 'css') as 'css' | 'text' | 'xpath',
            value: target.value,
            ...index !== undefined ? { index } : {},
          },
        }, exec.signal)
      } else {
        await browser.type(session, { text: args.text }, exec.signal)
      }
      return { typed: true, ...await observedEffect(browser, session, before) }
    },
  }))

  tools.push(defineTool({
    name: 'dsh_browser_scroll',
    description: 'Scroll the shared-browser page: by pixel deltas (deltaX/deltaY), to a CSS selector\'s element, or to the top/bottom. Use to reveal below-the-fold content before snapshotting or clicking.',
    parameters: {
      deltaX: { type: 'number', description: 'Horizontal scroll delta in CSS pixels.' },
      deltaY: { type: 'number', description: 'Vertical scroll delta in CSS pixels.' },
      selector: { type: 'string', description: 'Scroll the element matching this CSS selector into view.' },
      toTop: { type: 'boolean', description: 'Scroll to the top of the page.' },
      toBottom: { type: 'boolean', description: 'Scroll to the bottom of the page.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { scrolled: { type: 'boolean', required: true }, ...effectProperties } },
      render: (_args, value) => [{ type: 'text', text: value.scrolled ? 'Scrolled.' + effectText(value) : 'Scroll failed.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false, // mutates page scroll state; exclusive within a task
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_scroll', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const before = await pageFingerprint(browser, session)
      await browser.scroll(session, {
        ...args.deltaX !== undefined ? { deltaX: args.deltaX } : {},
        ...args.deltaY !== undefined ? { deltaY: args.deltaY } : {},
        ...args.selector !== undefined ? { selector: args.selector } : {},
        ...args.toTop === true ? { toTop: true } : {},
        ...args.toBottom === true ? { toBottom: true } : {},
      }, exec.signal)
      return { scrolled: true, ...await observedEffect(browser, session, before) }
    },
  }))

  tools.push(defineTool({
    name: 'dsh_browser_key',
    description: 'Press one named key in the shared-browser page (Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space). Use after focusing an input to submit a chat box (Enter), move focus (Tab), or navigate a list (arrows).',
    parameters: {
      key: { type: 'string', required: true, enum: ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space'], description: 'The key to press.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { pressed: { type: 'boolean', required: true }, ...effectProperties } },
      render: (_args, value) => [{ type: 'text', text: value.pressed ? `Pressed ${String(_args.key)}.` + effectText(value) : 'Key press failed.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false, // mutates page state; exclusive within a task
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_key', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const before = await pageFingerprint(browser, session)
      await browser.key(session, { key: args.key }, exec.signal)
      return { pressed: true, ...await observedEffect(browser, session, before) }
    },
  }))

  tools.push(defineTool({
    name: 'dsh_browser_fill',
    description: 'Fill a form in one batch: each field takes a CSS selector or name/label/placeholder text plus its value (boolean for checkbox/radio; option value or visible text for selects and radio groups). The native setter plus input/change events fire, so React/Vue controlled inputs update. Optionally submit the form. Prefer this over hand-written dsh_browser_execute; per-field failures are reported instead of throwing.',
    parameters: {
      fields: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            selector: { type: 'string', description: 'CSS selector; when present, candidates are scoped to it.' },
            name: { type: 'string', description: 'Match by the field\'s name attribute.' },
            label: { type: 'string', description: 'Match by associated <label> text or aria-label.' },
            placeholder: { type: 'string', description: 'Match by placeholder text.' },
            kind: { type: 'string', enum: ['text', 'textarea', 'checkbox', 'radio', 'select'], description: 'Field kind; defaults to text.' },
            value: { type: 'string', required: true, description: 'Value to set (string form; booleans/numbers accepted as strings). Required: omitting it would be read as "set empty", which unchecks a checkbox and clears a text field while still reporting success.' },
          },
        },
      },
      submit: { type: 'boolean', description: 'Submit the containing form after filling (default false).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fields: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ok: { type: 'boolean', required: true },
                target: { type: 'string', required: true },
                method: { type: 'string' },
                error: { type: 'string' },
              },
            },
          },
          submitted: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: (() => {
          const fields = value.fields as { ok: boolean; target: string; method?: string; error?: string }[]
          const failed = fields.filter(f => !f.ok)
          const lines = fields.map(f => `${f.ok ? 'OK' : 'FAIL'} ${f.target}${f.ok ? ` (${f.method ?? 'input'})` : `: ${f.error ?? 'unknown error'}`}`)
          const head = failed.length === 0
            ? `Filled ${fields.length}/${fields.length} fields${value.submitted ? ' and submitted the form' : ''}.`
            : `Filled ${fields.length - failed.length}/${fields.length} fields; ${failed.length} failed:`
          return head + '\n' + lines.join('\n')
        })(),
      }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_fill', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const requested = args.fields ?? []
      if (requested.length > maxFillFields) {
        throw new Error(`dsh_browser_fill: ${requested.length} fields in one call exceeds the ${maxFillFields}-field limit; split it into several calls so each one can report per-field results instead of timing out as a batch`)
      }
      const fields = requested.map((f: { selector?: string; name?: string; label?: string; placeholder?: string; kind?: string; value?: string }) => {
        // A missing value is a caller mistake, not a request to clear the field. Turning
        // it into '' silently unchecks a checkbox or empties a text input while the tool
        // still reports success, so it fails loudly. The schema marks value required, but
        // a call can still arrive without it.
        if (f.value === undefined) {
          const matcher = f.selector ?? f.name ?? f.label ?? f.placeholder ?? '(no matcher)'
          throw new Error(`dsh_browser_fill: field "${matcher}" has no "value"; pass one (use "false" to uncheck, or "" to clear deliberately)`)
        }
        return {
          ...f.selector !== undefined ? { selector: f.selector } : {},
          ...f.name !== undefined ? { name: f.name } : {},
          ...f.label !== undefined ? { label: f.label } : {},
          ...f.placeholder !== undefined ? { placeholder: f.placeholder } : {},
          ...f.kind !== undefined ? { kind: f.kind as 'text' | 'textarea' | 'checkbox' | 'radio' | 'select' } : {},
          value: parseFillValue(f.value),
        }
      })
      const result = await browser.fillForm(session, {
        fields,
        ...args.submit === true ? { submit: true } : {},
      }, exec.signal)
      return {
        fields: result.fields.map(f => ({ ok: f.ok, target: f.target, ...f.method !== undefined ? { method: f.method } : {}, ...f.error !== undefined ? { error: f.error } : {} })),
        submitted: result.submitted,
      }
    },
  }))

  // ---------------------------------------------------------------------------
  // Single-control form primitives, all target-based (css/text/xpath).
  // ---------------------------------------------------------------------------
  const targetParam = {
    type: 'object' as const,
    required: true as const,
    additionalProperties: false as const,
    properties: {
      by: { type: 'string' as const, enum: ['css', 'text', 'xpath'], description: 'Locator kind (default css). text matches an element\'s own visible text, exact first then contains.' },
      value: { type: 'string' as const, required: true as const, description: 'The CSS selector, visible text, or XPath expression.' },
      index: { type: 'number' as const, description: '0-based index of the match (default 0).' },
    },
    description: 'Locate the element (css/text/xpath).',
  }

  tools.push(defineTool({
    name: 'dsh_browser_set_value',
    description: 'Set the value of ONE input/textarea/select/contenteditable, located by css/text/xpath. Uses the native setter plus input/change events, so React/Vue controlled inputs update correctly. For selects pass the option value or visible text. For a whole form at once prefer dsh_browser_fill.',
    parameters: {
      target: targetParam,
      value: { type: 'string', required: true, description: 'The value to set (string form; numbers/booleans accepted).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          method: { type: 'string', required: true, description: 'How the value was applied: input/textarea/select/contenteditable.' },
          value: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Set via ${value.method}.` }],
    },
    timeoutMs,
    isConcurrencySafe: () => false, // mutates a field; exclusive within a task
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_set_value', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const target = args.target as { by?: string; value: string; index?: number }
      const result = await browser.setValue(session, {
        target: {
          by: (target.by === 'text' || target.by === 'xpath' ? target.by : 'css') as 'css' | 'text' | 'xpath',
          value: target.value,
          ...target.index !== undefined ? { index: target.index } : {},
        },
        value: parseFillValue(args.value),
      }, exec.signal)
      return { method: result.method, value: result.value }
    },
  }))

  tools.push(defineTool({
    name: 'dsh_browser_check',
    description: 'Check (or uncheck, with checked=false) a checkbox or radio button, located by css/text/xpath.',
    parameters: {
      target: targetParam,
      checked: { type: 'boolean', description: 'Desired state (default true = check).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { checked: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.checked ? 'Checked.' : 'Unchecked.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false, // mutates a field; exclusive within a task
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_check', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const target = args.target as { by?: string; value: string; index?: number }
      const result = await browser.check(session, {
        target: {
          by: (target.by === 'text' || target.by === 'xpath' ? target.by : 'css') as 'css' | 'text' | 'xpath',
          value: target.value,
          ...target.index !== undefined ? { index: target.index } : {},
        },
        ...args.checked !== undefined ? { checked: args.checked } : {},
      }, exec.signal)
      return { checked: result.checked }
    },
  }))

  tools.push(defineTool({
    name: 'dsh_browser_select',
    description: 'Select one option of a <select>, located by css/text/xpath — by option value, visible text, or 0-based index (provide exactly one).',
    parameters: {
      target: targetParam,
      optionValue: { type: 'string', description: 'Match the option by its value attribute.' },
      optionText: { type: 'string', description: 'Match the option by its visible text.' },
      optionIndex: { type: 'number', description: 'Match the option by its 0-based index.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          value: { type: 'string', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Selected "${value.text}".` }],
    },
    timeoutMs,
    isConcurrencySafe: () => false, // mutates a field; exclusive within a task
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_select', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const target = args.target as { by?: string; value: string; index?: number }
      const result = await browser.selectOption(session, {
        target: {
          by: (target.by === 'text' || target.by === 'xpath' ? target.by : 'css') as 'css' | 'text' | 'xpath',
          value: target.value,
          ...target.index !== undefined ? { index: target.index } : {},
        },
        ...args.optionValue !== undefined ? { optionValue: args.optionValue } : {},
        ...args.optionText !== undefined ? { optionText: args.optionText } : {},
        ...args.optionIndex !== undefined ? { optionIndex: args.optionIndex } : {},
      }, exec.signal)
      return { value: result.value, text: result.text }
    },
  }))

  tools.push(defineTool({
    name: 'dsh_browser_clear',
    description: 'Clear an input/textarea/contenteditable, or uncheck a checkbox/radio, located by css/text/xpath.',
    parameters: {
      target: targetParam,
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { cleared: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.cleared ? 'Cleared.' : 'Failed.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false, // mutates a field; exclusive within a task
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_clear', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const target = args.target as { by?: string; value: string; index?: number }
      await browser.clearField(session, {
        target: {
          by: (target.by === 'text' || target.by === 'xpath' ? target.by : 'css') as 'css' | 'text' | 'xpath',
          value: target.value,
          ...target.index !== undefined ? { index: target.index } : {},
        },
      }, exec.signal)
      return { cleared: true }
    },
  }))

  tools.push(defineTool({
    name: 'dsh_browser_get_value',
    description: 'Read the current value of one input/textarea/select/contenteditable, located by css/text/xpath. Use to VERIFY that a fill worked (e.g. before submitting).',
    parameters: {
      target: targetParam,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          value: { type: 'string' },
          checked: { type: 'boolean', description: 'For checkbox/radio.' },
          selectedText: { type: 'string', description: 'For <select>.', },
        },
      },
      render: (_args, value) => [{ type: 'text', text: (() => {
        if (value.checked !== undefined) return `checked=${value.checked}`
        if (value.selectedText !== undefined) return `selected: ${value.selectedText}`
        return `value: ${value.value ?? '(none)'}`
      })() }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_get_value', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const target = args.target as { by?: string; value: string; index?: number }
      const result = await browser.getValue(session, {
        target: {
          by: (target.by === 'text' || target.by === 'xpath' ? target.by : 'css') as 'css' | 'text' | 'xpath',
          value: target.value,
          ...target.index !== undefined ? { index: target.index } : {},
        },
      }, exec.signal)
      return {
        ...result.value !== null ? { value: result.value } : {},
        ...result.checked !== undefined ? { checked: result.checked } : {},
        ...result.selectedText !== undefined ? { selectedText: result.selectedText } : {},
      }
    },
  }))

  tools.push(defineTool({
    name: 'dsh_browser_download',
    description: 'Download a URL to a local file, keeping the browser session\'s cookies and login state. Use for fetching files behind authentication or from the current page context. Available on the self-hosted browser; the desktop shell delegates downloads to the real browser UI.',
    parameters: {
      url: { type: 'string', required: true, description: 'The URL to download.' },
      savePath: { type: 'string', required: true, description: 'Absolute path of the file to write. Must resolve inside the configured downloadDir (default: the system Downloads folder, localized names such as ~/下载 included); an existing file is never overwritten.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          handoff: { type: 'object', additionalProperties: true },
          remoteError: { type: 'string' },
          remoteResult: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => {
        const lines = [`Downloaded to ${value.path}.`]
        if (value.handoff !== undefined) lines.push(`Handed to ${String((value.handoff as Record<string, unknown>).tool)}: ${String((value.handoff as Record<string, unknown>).result ?? 'ok')}`)
        if (value.remoteError !== undefined) lines.push(`The local file is intact; the remote side did not take it: ${String(value.remoteError)}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_download', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const result = await browser.download(session, { url: args.url, savePath: args.savePath }, exec.signal)
      // Delivery is an attribute of the download: empty tool = the old behaviour, byte for byte.
      const plan = deliveryPlan(args.url as string, result.path)
      if (plan === undefined) return { path: result.path }
      let remoteValue: JsonValue | undefined
      try {
        const tools = (ctx as unknown as { get?: (name: string) => {
          execute?: (input: unknown) => Promise<unknown>
          setExecutor?: unknown
        } | undefined }).get?.('tools')
        if (tools?.execute === undefined) throw new Error('the tools service is not available on this surface')
        if (plan.tool === 'dsh_browser_download') throw new Error('the delivery tool must be a different tool from dsh_browser_download')
        exec.signal.throwIfAborted()
        const callId = 'handoff-' + globalThis.crypto.randomUUID()
        // DSH's executor service accepts raw batches. Earlier runtimes accept one parsed call.
        // Select the API before dispatch so a retry can never upload the same file twice.
        const batched = typeof tools.setExecutor === 'function'
        const answer = await tools.execute(batched ? {
          calls: [{ type: 'tool-call', id: callId, name: plan.tool, arguments: JSON.stringify(plan.args) }],
          agent: exec.agent,
          toolSet: (exec as typeof exec & { readonly toolSet?: unknown }).toolSet,
          signal: exec.signal,
        } : {
          callId,
          rootCallId: exec.rootCallId,
          parent: exec.token,
          name: plan.tool,
          arguments: plan.args,
          agent: exec.agent,
          signal: exec.signal,
        })
        let outcome = answer
        let concluded = false
        if (batched) {
          const batch = answer as { results?: { callId?: string; result?: unknown }[]; additionalContexts?: unknown[]; concluded?: boolean } | null
          if (!Array.isArray(batch?.results) || batch.results.length !== 1 || batch.results[0]?.callId !== callId) {
            throw new Error('the delivery executor returned no matching tool result')
          }
          for (const context of batch.additionalContexts ?? []) {
            exec.deferContext(context as Parameters<typeof exec.deferContext>[0])
          }
          concluded = batch.concluded === true
          outcome = batch.results[0].result
        }
        const settled = outcome as { value?: JsonValue; additionalContexts?: unknown[]; concludesTurn?: boolean } | null
        remoteValue = settled?.value
        const summary = summariseToolResult(outcome)
        if (!batched) {
          for (const context of settled?.additionalContexts ?? []) {
            exec.deferContext(context as Parameters<typeof exec.deferContext>[0])
          }
          concluded = settled?.concludesTurn === true
        }
        if (concluded) exec.concludeTurn()
        return { path: result.path, handoff: { tool: plan.tool, result: summary, value: remoteValue ?? null } }
      } catch (error) {
        exec.signal.throwIfAborted()
        const reason = error instanceof Error ? error.message : String(error)
        if (plan.onFail === 'stop') throw new Error(`dsh_browser_download: saved to ${result.path} locally, but the handoff to "${plan.tool}" failed: ${reason}`)
        return {
          path: result.path,
          remoteError: plan.tool + ': ' + reason,
          ...remoteValue === undefined ? {} : { remoteResult: { tool: plan.tool, value: remoteValue } },
        }
      }
    },
  }))

  /**
   * What to do with a saved file, from the settings document.
   *
   * Read here rather than threaded through the provider on purpose: delivery is a property of how
   * this deployment saves files, not of which browser carries the page, so every carrier gets it
   * for free and no seam grows a method for it.
   *
   * @param url - the downloaded address, used to pick a per-site override by host.
   * @param path - the absolute local path just written.
   * @returns the plan, or undefined when nothing is configured (the old behaviour).
   */
  function deliveryPlan(url: string, path: string): { tool: string; args: Record<string, string>; onFail: 'keep-local' | 'stop' } | undefined {
    let settings
    try { settings = settingsStore.get() } catch { return undefined }
    const delivery = settings.delivery
    if (delivery === undefined) return undefined
    let host = ''
    try { host = new URL(url).hostname.toLowerCase() } catch { host = '' }
    const override = host === '' ? undefined : (delivery.sites[host] ?? delivery.sites['*'])
    const tool = override ?? delivery.tool
    if (typeof tool !== 'string' || tool.trim() === '') return undefined
    const name = path.split(/[\\/]/).pop() ?? path
    const size = (() => { try { return String(statSync(path).size) } catch { return '' } })()
    const args: Record<string, string> = {}
    for (const [key, value] of Object.entries(delivery.args)) {
      args[key] = String(value).split('{path}').join(path).split('{name}').join(name).split('{size}').join(size)
    }
    if (Object.keys(args).length === 0) args.file_path = path
    return { tool: tool.trim(), args, onFail: delivery.onFail }
  }

  /** Check the canonical outcome before describing a completed delivery. */
  function summariseToolResult(answer: unknown): string {
    const outcome = answer as { isError?: boolean; value?: unknown; error?: { message?: string }; content?: { text?: string }[] } | null
    if (outcome === null || typeof outcome !== 'object' || typeof outcome.isError !== 'boolean') {
      throw new Error('the delivery executor returned an invalid tool result')
    }
    if (outcome.isError) {
      throw new Error(outcome.error?.message || outcome.content?.map(block => block.text ?? '').join(' ') || 'the delivery tool failed')
    }
    if (!('value' in outcome)) throw new Error('the delivery executor returned an invalid tool result')
    const failure = deliveryFailure(outcome.value)
    if (failure !== undefined) throw new Error(failure)
    const text = typeof outcome.value === 'string' ? outcome.value : JSON.stringify(outcome.value)
    return text.length > 200 ? text.slice(0, 200) + '…' : text
  }

  /** Read explicit failure markers in common MCP structured or JSON text responses. */
  function deliveryFailure(value: unknown): string | undefined {
    const object = (candidate: unknown): Record<string, unknown> | undefined => {
      if (typeof candidate === 'string') {
        try { candidate = JSON.parse(candidate) } catch { return undefined }
      }
      return candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)
        ? candidate as Record<string, unknown> : undefined
    }
    const response = object(value)
    if (response === undefined) return undefined
    const blocks = Array.isArray(response.content) ? response.content : []
    const candidates = [
      response,
      object(response.structuredContent),
      ...blocks.map(block => {
        const content = object(block)
        return content?.type === 'text' ? object(content.text) : undefined
      }),
    ]
    for (const candidate of candidates) {
      if (candidate === undefined) continue
      if (candidate.isError !== true && candidate.ok !== false && candidate.success !== false
        && candidate.status !== 'error' && candidate.status !== 'failed') continue
      const error = object(candidate.error)
      const detail = [candidate.message, candidate.error, error?.message].find(item => typeof item === 'string' && item !== '')
      return typeof detail === 'string' ? detail : 'the delivery tool reported a failed upload'
    }
    return undefined
  }

  tools.push(defineTool({
    name: 'dsh_browser_drag',
    description: 'Drag from one viewport point to another using trusted browser pointer input. Coordinates are CSS pixels from the top-left of the current viewport. Use for sliders, sortable lists, HTML drag-and-drop and canvas drawing. Check the resulting control value or page state after the gesture.',
    parameters: {
      fromX: { type: 'number', required: true, description: 'Start x in viewport CSS pixels.' },
      fromY: { type: 'number', required: true, description: 'Start y in viewport CSS pixels.' },
      toX: { type: 'number', required: true, description: 'End x.' },
      toY: { type: 'number', required: true, description: 'End y.' },
      steps: { type: 'number', description: 'Intermediate moves (default 12, max 60); more steps make a slider follow the path.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reason: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.ok === true ? 'Dragged.' : `Drag failed: ${String(value.reason)}` }],
    },
    timeoutMs,
    isConcurrencySafe: () => false, // a pointer gesture; exclusive within a task
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_drag', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const text = await pageOperationValue(browser, session, {
        operation: 'drag',
        from: { x: args.fromX, y: args.fromY },
        to: { x: args.toX, y: args.toY },
        steps: args.steps ?? 12,
      }, exec.signal)
      const parsed = JSON.parse(text) as { ok?: boolean; reason?: string; moved?: number }
      return { ok: parsed.ok === true, reason: parsed.ok === true ? `moved ${String(parsed.moved)} steps` : String(parsed.reason ?? 'unknown') }
    },
  }))

  tools.push(defineTool({
    name: 'dsh_browser_upload',
    description: 'Put a local file into a file input on the page (attachment, avatar, import form). The path must be a file INSIDE the current workspace, and only the bytes of that one file are read. The file is rebuilt in the page as a File and attached through a DataTransfer, so a form that reads input.files and a drop handler both see it; the change event is fired for you. Oversized files are refused rather than truncated.',
    parameters: {
      target: { type: 'object', required: true, additionalProperties: true, description: 'The input: {by: "css"|"text"|"xpath", value} — a text target is resolved to the element at that point and then to a nested input[type=file].' },
      path: { type: 'string', required: true, description: 'Absolute path of a file inside the workspace.' },
      mime: { type: 'string', description: 'MIME type (default guessed from the extension, else application/octet-stream).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          name: { type: 'string' },
          size: { type: 'number' },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.ok === true ? `Attached ${String(value.name)} (${String(value.size)} bytes).` : `Upload failed: ${String(value.reason)}` }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_upload', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const target = args.target as { by?: unknown; value?: unknown }
      const by = target?.by === 'css' || target?.by === 'xpath' || target?.by === 'text' ? target.by : 'css'
      if (typeof target?.value !== 'string' || target.value === '') throw new Error('dsh_browser_upload: target.value is required')
      const { open, realpath, stat } = await import('node:fs/promises')
      const { resolve, relative, isAbsolute, extname, basename, sep } = await import('node:path')
      if (!isAbsolute(args.path)) throw new Error('dsh_browser_upload: path must be absolute')
      const agent = agentOf(exec) as (ExecAgent & { session?: { header?: { cwd?: string } } }) | undefined
      const directory = (agent?.ctx?.get?.('workingDirectory') ?? ctx.get('workingDirectory')) as {
        ensure(agent: unknown, signal?: AbortSignal): Promise<string>
      } | undefined
      const workspacePath = directory && agent
        ? await directory.ensure(agent, exec.signal)
        : agent?.session?.header?.cwd ?? process.cwd()
      if (!isAbsolute(workspacePath)) throw new Error('dsh_browser_upload: the task workspace must be absolute')
      const workspace = await realpath(workspacePath)
      const resolved = await realpath(resolve(args.path))
      const offset = relative(workspace, resolved)
      if (offset === '..' || offset.startsWith('..' + sep) || isAbsolute(offset)) {
        throw new Error('dsh_browser_upload: refusing to read a file outside the task workspace')
      }
      const expected = await stat(resolved)
      const LIMIT = 20 * 1024 * 1024
      if (!expected.isFile()) throw new Error('dsh_browser_upload: path must name a regular file')
      if (expected.size > LIMIT) throw new Error('dsh_browser_upload: file is over the 20 MB limit')
      const file = await open(resolved, 'r')
      let bytes: Buffer
      try {
        const opened = await file.stat()
        if (opened.dev !== expected.dev || opened.ino !== expected.ino
          || opened.size !== expected.size || !opened.isFile()
          || await realpath(resolve(args.path)) !== resolved) {
          throw new Error('dsh_browser_upload: file changed while opening; retry')
        }
        const chunks: Buffer[] = []
        let length = 0
        for await (const chunk of file.createReadStream({ autoClose: false, start: 0, end: LIMIT, signal: exec.signal })) {
          length += chunk.length
          if (length > LIMIT) throw new Error('dsh_browser_upload: file grew over the 20 MB limit')
          chunks.push(chunk as Buffer)
        }
        const after = await file.stat()
        if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || length !== opened.size
          || await realpath(resolve(args.path)) !== resolved) {
          throw new Error('dsh_browser_upload: file changed while reading; retry')
        }
        bytes = Buffer.concat(chunks, length)
      } finally {
        await file.close()
      }
      const guess: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json', '.zip': 'application/zip' }
      const mime = args.mime ?? guess[extname(resolved).toLowerCase()] ?? 'application/octet-stream'
      await installProbe(browser, session, exec.signal)
      const text = await pageOperationValue(browser, session, {
        operation: 'upload',
        target: { by, value: target.value },
        file: { name: basename(resolved), mime, base64: bytes.toString('base64') },
      }, exec.signal)
      const parsed = JSON.parse(text) as { ok?: boolean; reason?: string; name?: string; size?: number }
      return parsed.ok === true
        ? { ok: true, name: String(parsed.name ?? ''), size: Number(parsed.size ?? 0) }
        : { ok: false, reason: String(parsed.reason ?? 'unknown') }
    },
  }))

  tools.push(defineTool({
    name: 'dsh_browser_hover',
    description: 'Scroll an element into view and move the browser pointer to its centre. Supports CSS hover styles and JavaScript mouseover handlers. Use before reading or clicking a hover menu.',
    parameters: {
      target: { type: 'object', required: true, additionalProperties: true, description: 'The element: {by: "css"|"text"|"xpath", value}.' },
      settleMs: { type: 'number', description: 'How long to let the menu appear before returning (default 150).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { hovered: { type: 'boolean', required: true }, at: { type: 'object', additionalProperties: true } } },
      render: (_args, value) => [{ type: 'text', text: value.hovered === true ? 'Pointer moved over the element.' : 'No element at that target.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertAllowed(state, 'dsh_browser_hover', taskKey(exec))
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, state, taskKey(exec), agentOf(exec))
      const target = args.target as { by?: unknown; value?: unknown }
      const by = target?.by === 'css' || target?.by === 'xpath' || target?.by === 'text' ? target.by : 'css'
      if (typeof target?.value !== 'string' || target.value === '') throw new Error('dsh_browser_hover: target.value is required')
      await installProbe(browser, session, exec.signal)
      const where = await probe<{ x?: number; y?: number; described?: string } | null>(browser, session, 'find', [{ [by]: target.value }, true], exec.signal)
      if (!where || typeof where.x !== 'number' || typeof where.y !== 'number') return { hovered: false, at: {} as ProbeRow }
      const fired = await probe<boolean>(browser, session, 'hoverAt', [where.x, where.y], exec.signal)
      await pause(Math.min(args.settleMs ?? 150, 2_000))
      const at: ProbeRow = { x: where.x, y: where.y, described: String(where.described ?? '') }
      return { hovered: fired === true, at }
    },
  }))

  return tools
}
