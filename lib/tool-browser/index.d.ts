/**
 * Model-facing browser tools over `ctx.browser`: `browser_open`,
 * `browser_snapshot`, `browser_execute`, `browser_content`,
 * `browser_screenshot`, and tab management (`browser_list_tabs`,
 * `browser_switch_tab`, `browser_close_tab`, `browser_reset`).
 *
 * The tool layer owns only the model-facing schema, argument validation, and
 * result formatting — never provider selection or page driving, which belong
 * to the seam. Session lifecycle is owned here at the plugin level: each
 * calling task (a DSH session) gets its own browser session — the first
 * `browser_open` (or any tool when no session exists) opens it, and later
 * tools in the same task reuse it. Concurrent tasks therefore never fight
 * over tabs, history, or navigation state.
 * @module dsh-browser/tool-browser
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
    /** Optional initial allow-list of browser tool names; other tools are refused. */
    readonly allowedActions?: readonly string[];
}
/** Register all browser tools with `ctx.tools`. */
export declare function apply(ctx: Context, config?: Config): void;
/** Test hook: inspect and reset the plugin-level session map (used by tests). */
export declare const internals: {
    /** A copy of the per-task session map (task key -> provider session id). */
    readonly sessions: ReadonlyMap<string, BrowserSessionId>;
    /** Drop one task's mapping without closing the provider session. */
    clearSession(key?: string): void;
};
