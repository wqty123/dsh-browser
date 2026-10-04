/**
 * Persistent browsing history: which pages the shared browser actually visited,
 * kept independently from any session's operation log (`browser_history`) and
 * from the browser process's lifetime.
 *
 * It lives beside the browser profile (`$DSH_HOME/dsh-builtin-browser-host/
 * history.jsonl`), so it follows the same persistence rules as the login state:
 * closing the interface releases the process, never the record.
 *
 * Format: one JSON object per line, append-only. Appending stays cheap for a
 * long session, and a half-written tail (crash, power loss) is dropped on read
 * instead of poisoning the whole file.
 * @module dsh-browser/browser-electron/history-store
 */
import type { VisitedPage } from '../browser/types.js';
export type { VisitedPage };
/** Retention limits; whichever is hit first starts trimming. */
export interface HistoryLimits {
    /** Maximum retained entries. Default 5000. */
    readonly maxEntries?: number;
    /** Maximum age in days. Default 90. */
    readonly maxAgeDays?: number;
}
/**
 * Absolute path of the browsing-history file, beside the browser profile so the
 * record shares the login state's persistence rules.
 * @returns the history file path.
 */
export declare function visitedHistoryPath(): string;
/**
 * Append-only browsing history with bounded retention. Every method tolerates a
 * missing or damaged file: recording a visit must never fail a navigation, and
 * a corrupted line must never hide the rest of the history.
 */
export declare class HistoryStore {
    private readonly file;
    /**
     * File size at which the next rewrite happens.
     *
     * Advanced after each rewrite so the cost is paid once per PRUNE_SLACK appends
     * rather than on every append: asking "is it over the cap?" was true from the first
     * over-cap write onwards, which is what made every later navigation rewrite the file.
     */
    private pruneThreshold;
    /**
     * Appends since the last rewrite.
     *
     * prune() runs after every navigation, and the answer is almost always "nothing to
     * do" — but working that out from the file costs a full parse. Counting instead makes
     * the common case a comparison.
     */
    private appendedSincePrune;
    private maxEntries;
    private maxAgeMs;
    /**
     * @param file - absolute path of the JSONL history file.
     * @param limits - retention overrides (entry count and age).
     */
    constructor(file?: string, limits?: HistoryLimits);
    /**
     * Re-read the retention limits.
     *
     * They are settings, and settings change while the plugin runs — a panel that let the
     * operator edit them while nothing read the new values made the control a lie. Entry count
     * and age are the pair the interface presents, so they are updated together.
     * @param limits - the current retention overrides.
     */
    updateLimits(limits: HistoryLimits): void;
    /** Whether the history file exists yet (diagnostics and tests). */
    exists(): boolean;
    /**
     * Record one visit. Failures are swallowed by design: history is a
     * convenience, and losing an entry must never break the tool call that
     * produced it.
     * @param page - the visited page.
     */
    append(page: VisitedPage): void;
    /**
     * Read visits, newest first. Unparseable lines are skipped; entries older
     * than the age limit are filtered out but left on disk until the next prune.
     * @param options - optional result cap plus three filters: `domain` (hostname),
     *   `query` (substring of the URL or title) and `session` (the task that visited
     *   it). Filters compose, so "the pages THIS task opened on that host" is one call.
     * @returns the matching visits, newest first.
     */
    list(options?: {
        readonly limit?: number;
        readonly domain?: string;
        readonly query?: string;
        readonly session?: string;
    }): VisitedPage[];
    /**
     * Enforce retention: drop entries past the age limit, then the oldest beyond
     * the count cap. Cheap no-op until the file grows past the cap, so callers can
     * run it after every append.
     */
    /**
     * How far past the cap the file may grow before it is rewritten.
     *
     * Scaled to the cap rather than fixed: a fixed 500 was meaningless when the cap is
     * small (a caller asking for three entries would never reach 503), and the slack is
     * there to batch rewrites, not to overrule the caller's bound.
     * @returns the number of extra entries tolerated before a rewrite.
     */
    private slack;
    prune(): void;
    /** Parse the whole file, skipping blank and damaged lines. */
    private readAll;
}
