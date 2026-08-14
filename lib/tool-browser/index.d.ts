/**
 * Model-facing browser tools over `ctx.browser`: `browser_open`,
 * `browser_snapshot`, `browser_execute`, `browser_content`,
 * `browser_screenshot`, and tab management (`browser_list_tabs`,
 * `browser_switch_tab`, `browser_close_tab`, `browser_reset`).
 *
 * The tool layer owns only the model-facing schema, argument validation, and
 * result formatting — never provider selection or page driving, which belong
 * to the seam. Session lifecycle is owned here at the plugin level: the
 * first `browser_open` (or any tool when no session exists) opens a session;
 * later tools reuse it. Per-agent isolation is a follow-up.
 * @module @deepseek-ai/dsh-tool-browser
 */
import type { Context } from '@deepseek-ai/cordis';
import type { BrowserSessionId } from '../browser/types.ts';
/** Plugin name used by loader diagnostics. */
export declare const name = "tool-browser";
/** The tool registry, browser seam, and system-prompt registry this tool layer consumes. */
export declare const inject: string[];
/** Plugin config: tool timeouts and session defaults. */
export interface Config {
    /** Cooperative tool-call budget in ms. Default 60000. */
    readonly timeoutMs?: number;
    /** Whether to offer tab-management tools. Default true. */
    readonly tabTools?: boolean;
}
/** Register all browser tools with `ctx.tools`. */
export declare function apply(ctx: Context, config?: Config): void;
/** Test hook: clear the plugin-level session (used by tests and on reset). */
export declare const internals: {
    readonly session: BrowserSessionId | undefined;
    clearSession(): void;
};
