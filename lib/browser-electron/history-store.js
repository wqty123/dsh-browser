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
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
/** Default entry cap — mirrors the documented retention rule. */
const DEFAULT_MAX_ENTRIES = 5_000;
/** Default age cap in days. */
const DEFAULT_MAX_AGE_DAYS = 90;
/** Rewrite the file only once it has grown this far past the cap. */
const PRUNE_SLACK = 500;
/**
 * Absolute path of the browsing-history file, beside the browser profile so the
 * record shares the login state's persistence rules.
 * @returns the history file path.
 */
export function visitedHistoryPath() {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    return join(home, 'dsh-builtin-browser-host', 'history.jsonl');
}
/**
 * Append-only browsing history with bounded retention. Every method tolerates a
 * missing or damaged file: recording a visit must never fail a navigation, and
 * a corrupted line must never hide the rest of the history.
 */
export class HistoryStore {
    file;
    /**
     * File size at which the next rewrite happens.
     *
     * Advanced after each rewrite so the cost is paid once per PRUNE_SLACK appends
     * rather than on every append: asking "is it over the cap?" was true from the first
     * over-cap write onwards, which is what made every later navigation rewrite the file.
     */
    pruneThreshold;
    /**
     * Appends since the last rewrite.
     *
     * prune() runs after every navigation, and the answer is almost always "nothing to
     * do" — but working that out from the file costs a full parse. Counting instead makes
     * the common case a comparison.
     */
    appendedSincePrune = 0;
    maxEntries;
    maxAgeMs;
    /**
     * @param file - absolute path of the JSONL history file.
     * @param limits - retention overrides (entry count and age).
     */
    constructor(file = visitedHistoryPath(), limits = {}) {
        this.file = file;
        this.maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
        // The first rewrite is due once the file has grown PRUNE_SLACK past the cap.
        this.pruneThreshold = this.maxEntries + this.slack();
        this.maxAgeMs = (limits.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS) * 24 * 60 * 60 * 1000;
    }
    /** Whether the history file exists yet (diagnostics and tests). */
    exists() {
        return existsSync(this.file);
    }
    /**
     * Record one visit. Failures are swallowed by design: history is a
     * convenience, and losing an entry must never break the tool call that
     * produced it.
     * @param page - the visited page.
     */
    append(page) {
        try {
            mkdirSync(dirname(this.file), { recursive: true });
            appendFileSync(this.file, `${JSON.stringify(page)}\n`);
        }
        catch {
            // Best-effort: history is not worth failing a navigation over.
        }
        this.appendedSincePrune++;
    }
    /**
     * Read visits, newest first. Unparseable lines are skipped; entries older
     * than the age limit are filtered out but left on disk until the next prune.
     * @param options - optional result cap plus three filters: `domain` (hostname),
     *   `query` (substring of the URL or title) and `session` (the task that visited
     *   it). Filters compose, so "the pages THIS task opened on that host" is one call.
     * @returns the matching visits, newest first.
     */
    list(options = {}) {
        const all = this.readAll();
        const cutoff = Date.now() - this.maxAgeMs;
        const domain = options.domain?.toLowerCase();
        const query = options.query?.toLowerCase();
        const session = options.session;
        const matches = all.filter(page => {
            if (page.at < cutoff)
                return false;
            if (session !== undefined && page.session !== session)
                return false;
            if (query !== undefined) {
                const haystack = `${page.url}\n${page.title ?? ''}`.toLowerCase();
                if (!haystack.includes(query))
                    return false;
            }
            if (domain === undefined)
                return true;
            try {
                return new URL(page.url).hostname.toLowerCase().includes(domain);
            }
            catch {
                return page.url.toLowerCase().includes(domain);
            }
        });
        matches.reverse();
        return options.limit === undefined ? matches : matches.slice(0, Math.max(0, options.limit));
    }
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
    slack() {
        return Math.min(PRUNE_SLACK, Math.max(1, Math.floor(this.maxEntries / 2)));
    }
    prune() {
        // Cheap first: past the cap but without enough new entries to justify a rewrite.
        // Reading the file to reach this conclusion was the remaining per-navigation cost.
        if (this.appendedSincePrune === 0)
            return;
        const all = this.readAll();
        const cutoff = Date.now() - this.maxAgeMs;
        const fresh = all.filter(page => page.at >= cutoff);
        const kept = fresh.length > this.maxEntries ? fresh.slice(fresh.length - this.maxEntries) : fresh;
        // Only rewrite when something actually fell off, and only once the excess
        // is worth a full rewrite.
        if (kept.length === all.length)
            return;
        // Only rewrite once the file has grown PRUNE_SLACK past what we last wrote. Asking
        // "is the file over the cap?" instead was true from the first over-cap append
        // onwards, so every single navigation after that rewrote the whole file.
        if (all.length < this.pruneThreshold)
            return;
        try {
            const body = kept.map(page => `${JSON.stringify(page)}\n`).join('');
            writeFileSync(this.file, body);
            // The file now holds only what was kept, so the next rewrite is due once
            // PRUNE_SLACK more entries have been appended.
            this.pruneThreshold = kept.length + this.slack();
            this.appendedSincePrune = 0;
        }
        catch {
            // Best-effort: an unpruned file still reads correctly.
        }
    }
    /** Parse the whole file, skipping blank and damaged lines. */
    readAll() {
        let raw;
        try {
            raw = readFileSync(this.file, 'utf8');
        }
        catch {
            return [];
        }
        const pages = [];
        // Strip a BOM first: trim() does not remove U+FEFF (it is not whitespace in
        // ECMAScript), so a file written by Notepad or PowerShell made the first line fail to
        // parse and be discarded as corrupt — silently losing one visit, or the whole file when
        // it holds one. settings-store strips one for the same reason.
        for (const line of raw.replace(/^\uFEFF/, '').split('\n')) {
            const trimmed = line.trim();
            if (trimmed === '')
                continue;
            try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed.at !== 'number' || typeof parsed.url !== 'string')
                    continue;
                pages.push({
                    at: parsed.at,
                    url: parsed.url,
                    ...typeof parsed.title === 'string' && parsed.title !== '' ? { title: parsed.title } : {},
                    ...typeof parsed.session === 'string' && parsed.session !== '' ? { session: parsed.session } : {},
                });
            }
            catch {
                // A damaged line (typically a truncated tail) must not hide the rest.
                continue;
            }
        }
        return pages;
    }
}
