/**
 * Page-side probe client: fingerprints, observed effects, the installed probe, polling, and checks.
 * @module dsh-browser/tool-browser/probe-client
 */

import type { Context } from '@deepseek-ai/cordis'
import { pageOperationScript } from './page-probe.ts'
import type { BrowserSessionId, BrowserPageOperationRequest, BrowserProbeMethod } from '../browser/types.ts'

export const effectProperties = {
  verified: { type: 'boolean' as const, description: 'Whether a visible change was observed. Absent when it could not be checked.' },
  note: { type: 'string' as const, description: 'Why the effect is uncertain.' },
}

export async function pageFingerprint(browser: NonNullable<Context['browser']>, session: BrowserSessionId): Promise<string | undefined> {
  try {
    const result = await browser.execute(session, {
      script: `(() => {
        const a = document.activeElement
        return JSON.stringify([
          location.href, document.title,
          a ? [a.tagName, a.id || a.getAttribute('name') || a.className || '',
            typeof a.value === 'string' ? a.value.length : null, a.checked, a.selectedIndex,
            a.selectionStart, a.selectionEnd, a.scrollLeft, a.scrollTop] : null,
          window.scrollX, window.scrollY,
          document.body ? document.body.childElementCount : 0,
          document.body ? document.body.innerHTML.length : 0,
        ])
      })()`,
    })
    return result.ok && typeof result.value === 'string' ? result.value : undefined
  } catch {
    return undefined
  }
}

export async function observedEffect(browser: NonNullable<Context['browser']>, session: BrowserSessionId, before: string | undefined): Promise<{ verified?: boolean; note?: string }> {
  const after = await pageFingerprint(browser, session)
  if (before === undefined || after === undefined) return { note: 'The effect could not be checked.' }
  return before !== after
    ? { verified: true }
    : { verified: false, note: 'No visible change observed; the effect is uncertain.' }
}

export function effectText(value: { verified?: boolean; note?: string }): string {
  return value.verified === true ? ' Visible change observed.' : ` ${value.note ?? 'The effect could not be checked.'}`
}

/** Run a script in the page and return its value as text. */
export async function pageValue(browser: NonNullable<Context['browser']>, session: BrowserSessionId, script: string, signal?: AbortSignal): Promise<string> {
  const result = await browser.execute(session, { script }, signal)
  if (!result.ok) throw new Error(`page script failed: ${result.exception}`)
  const raw = result.value
  return typeof raw === 'string' ? raw : JSON.stringify(raw ?? null)
}

/** Fixed operations keep their inputs as data and preserve arbitrary-script permissions. */
export async function pageOperationValue(browser: NonNullable<Context['browser']>, session: BrowserSessionId, request: BrowserPageOperationRequest, signal?: AbortSignal): Promise<string> {
  const result = typeof browser.pageOperation === 'function'
    ? await browser.pageOperation(session, request, signal)
    : await browser.execute(session, { script: pageOperationScript(request) }, signal)
  if (!result.ok) throw new Error('page operation failed: ' + result.exception)
  return typeof result.value === 'string' ? result.value : JSON.stringify(result.value ?? null)
}

/** Install the fixed probe and report page failures immediately. */
export async function installProbe(browser: NonNullable<Context['browser']>, session: BrowserSessionId, signal?: AbortSignal): Promise<void> {
  await pageOperationValue(browser, session, { operation: 'install' }, signal)
}

/** One probe call, parsed. Throws when the probe is absent or the call failed. */
export async function probe<T = unknown>(
  browser: NonNullable<Context['browser']>,
  session: BrowserSessionId,
  method: BrowserProbeMethod,
  args: readonly unknown[] = [],
  signal?: AbortSignal,
): Promise<T> {
  const text = await pageOperationValue(browser, session, { operation: 'probe', method, args }, signal)
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new Error(`page probe returned unreadable JSON: ${text.slice(0, 120)}`) }
  if (parsed !== null && typeof parsed === 'object' && 'error' in (parsed as Record<string, unknown>)) {
    throw new Error(`page probe: ${String((parsed as Record<string, unknown>).error)}`)
  }
  return parsed as T
}

/**
 * A probe call that survives a navigation inside a batch.
 *
 * Submitting a form replaces the document, and the probe with it, so a later step in the same
 * batch would fail with `probe-not-installed` — measured on the first real benchmark run. One
 * reinstall and one retry is enough: a second failure is a real absence, not a stale context.
 */
export async function probeLive<T = unknown>(
  browser: NonNullable<Context['browser']>,
  session: BrowserSessionId,
  method: BrowserProbeMethod,
  args: readonly unknown[] = [],
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await probe<T>(browser, session, method, args, signal)
  } catch (error) {
    if (!/probe-not-installed|probe-method-missing/.test(String(error))) throw error
    await installProbe(browser, session, signal)
    return await probe<T>(browser, session, method, args, signal)
  }
}

/** Sleep. Long waits are capped by the caller, and the tool timeout still applies. */
export async function pause(ms: number): Promise<void> {
  await new Promise<void>(resolve => { setTimeout(resolve, ms) })
}

/** Poll until the callback returns something, or the budget runs out. */
export async function poll<T>(check: () => Promise<T | undefined>, budgetMs: number, intervalMs = 200): Promise<T | undefined> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const value = await check()
    if (value !== undefined) return value
    const left = deadline - Date.now()
    if (left <= 0) return undefined
    // Timers may fire a millisecond before `Date.now()` reaches the deadline; the pause that
    // reaches it is the last one, so it is followed by exactly one final check.
    if (left <= intervalMs) {
      await pause(left)
      return await check()
    }
    await pause(intervalMs)
  }
}

/**
 * One flat probe row: what a page can hand back through JSON.
 *
 * Concrete rather than `Record<string, unknown>`, because the tool output schema is a JSON value
 * and the compiler (rightly) refuses to promise that an `unknown` is one.
 */
export type ProbeRow = Record<string, string | number | boolean | null>

/**
 * Run one `dsh_browser_check` specification against the page.
 *
 * Shared by the `check` tool and by the `{check: …}` step of `dsh_browser_do`, so a batch asserts
 * exactly what a standalone call asserts.
 */
export async function runChecks(
  browser: NonNullable<Context['browser']>,
  session: BrowserSessionId,
  spec: { readonly selector?: string; readonly text?: string; readonly url?: string; readonly js?: string },
  signal?: AbortSignal,
): Promise<{ pass: boolean; checks: Array<{ kind: string; expected: string; actual: string; pass: boolean }> }> {
  const checks: Array<{ kind: string; expected: string; actual: string; pass: boolean }> = []
  if (spec.selector !== undefined) {
    const found = await probeLive<{ described?: string } | null>(browser, session, 'find', [{ css: spec.selector }], signal)
    checks.push({ kind: 'selector', expected: spec.selector, actual: found === null ? 'not found' : String(found.described ?? 'found'), pass: found !== null })
  }
  if (spec.text !== undefined) {
    const present = await pageOperationValue(browser, session, { operation: 'text', text: spec.text }, signal)
    const ok = present === 'true'
    checks.push({ kind: 'text', expected: spec.text, actual: ok ? 'present' : 'absent', pass: ok })
  }
  if (spec.url !== undefined) {
    const href = await pageOperationValue(browser, session, { operation: 'url' }, signal).then(text => text.replace(/^"|"$/g, ''))
    const ok = href.includes(spec.url)
    checks.push({ kind: 'url', expected: spec.url, actual: href, pass: ok })
  }
  if (spec.js !== undefined) {
    try {
      const value = await pageValue(browser, session, `(() => { try { return JSON.stringify({ ok: !!(${spec.js}) }) } catch (error) { return JSON.stringify({ ok: false, error: String(error) }) } })()`, signal)
      const parsed = JSON.parse(value) as { ok?: boolean; error?: string }
      checks.push({ kind: 'js', expected: spec.js, actual: parsed.ok === true ? 'truthy' : (parsed.error ?? 'falsy'), pass: parsed.ok === true })
    } catch (error) {
      checks.push({ kind: 'js', expected: spec.js, actual: String(error), pass: false })
    }
  }
  return { pass: checks.length > 0 && checks.every(check => check.pass), checks }
}
