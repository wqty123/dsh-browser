/**
 * Structured failures of the dsh_browser_* tools.
 *
 * DSH records `error: { name, code }` on `tool/result` only for a thrown `HarnessError`, and PTC
 * programs see the same class, so every browser tool failure leaves as one.
 * @module dsh-browser/tool-browser/errors
 */
import { HarnessError } from '@deepseek-ai/dsh-error'

export type BrowserToolErrorCode =
  | 'BROWSER_TAKEOVER_PENDING'
  | 'BROWSER_UNKNOWN_TOOL_GROUP'
  | 'BROWSER_TOOL_FAILED'
  | (string & {})

/** A browser tool failure with a stable code; the message is what the model sees. */
export class BrowserToolError extends HarnessError {
  declare readonly code: BrowserToolErrorCode
  constructor(message: string, code: BrowserToolErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'BrowserToolError'
  }
}

/**
 * The error a browser tool rethrows: HarnessErrors and cancellations unchanged, anything else with
 * the same message, the original as `cause`, and its own string `code` (e.g.
 * `BROWSER_BRIDGE_VERSION_MISMATCH`) or `BROWSER_TOOL_FAILED`.
 * @param error - what the tool threw.
 * @param signal - the call's abort signal, if any.
 */
export function toBrowserToolError(error: unknown, signal?: AbortSignal): unknown {
  if (error instanceof HarnessError) return error
  if (signal?.aborted === true) return error
  if (error instanceof Error && error.name === 'AbortError') return error
  const message = error instanceof Error ? error.message : String(error)
  const own = (error as { code?: unknown } | null)?.code
  const code = typeof own === 'string' && own !== '' ? own : 'BROWSER_TOOL_FAILED'
  return new BrowserToolError(message, code, { cause: error })
}
