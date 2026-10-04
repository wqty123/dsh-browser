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

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { VisitedPage } from '../browser/types.js'
import { writeFileAtomic } from './settings-store.js'

export type { VisitedPage }

/** Retention limits; whichever is hit first starts trimming. */
export interface HistoryLimits {
  /** Maximum retained entries. Default 5000. */
  readonly maxEntries?: number
  /** Maximum age in days. Default 90. */
  readonly maxAgeDays?: number
}

/** Default entry cap — mirrors the documented retention rule. */
const DEFAULT_MAX_ENTRIES = 5_000
/** Default age cap in days. */
const DEFAULT_MAX_AGE_DAYS = 90
/** Rewrite the file only once it has grown this far past the cap. */
const PRUNE_SLACK = 500

/**
 * Absolute path of the browsing-history file, beside the browser profile so the
 * record shares the login state's persistence rules.
 * @returns the history file path.
 */
export function visitedHistoryPath(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'dsh-builtin-browser-host', 'history.jsonl')
}

/**
 * Append-only browsing history with bounded retention. Every method tolerates a
 * missing or damaged file: recording a visit must never fail a navigation, and
 * a corrupted line must never hide the rest of the history.
 */
export class HistoryStore {
  /**
   * File size at which the next rewrite happens.
   *
   * Advanced after each rewrite so the cost is paid once per PRUNE_SLACK appends
   * rather than on every append: asking "is it over the cap?" was true from the first
   * over-cap write onwards, which is what made every later navigation rewrite the file.
   */
  private pruneThreshold: number
  /**
   * Appends since the last rewrite.
   *
   * prune() runs after every navigation, and the answer is almost always "nothing to
   * do" — but working that out from the file costs a full parse. Counting instead makes
   * the common case a comparison.
   */
  private appendedSincePrune = 0
  private maxEntries: number
  private maxAgeMs: number

  /**
   * @param file - absolute path of the JSONL history file.
   * @param limits - retention overrides (entry count and age).
   */
  constructor(
    private readonly file: string = visitedHistoryPath(),
    limits: HistoryLimits = {},
  ) {
    this.maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.maxAgeMs = (limits.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS) * 24 * 60 * 60 * 1000
    // The first rewrite is due once the file has grown the slack past the cap.
    this.pruneThreshold = this.maxEntries + this.slack()
  }

  /**
   * Re-read the retention limits.
   *
   * They are settings, and settings change while the plugin runs — a panel that let the
   * operator edit them while nothing read the new values made the control a lie. Entry count
   * and age are the pair the interface presents, so they are updated together.
   * @param limits - the current retention overrides.
   */
  updateLimits(limits: HistoryLimits): void {
    this.maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.maxAgeMs = (limits.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS) * 24 * 60 * 60 * 1000
    // Recomputed rather than left alone: a smaller cap means the next rewrite is sooner.
    this.pruneThreshold = Math.max(this.pruneThreshold, this.maxEntries + this.slack())
  }

  /** Whether the history file exists yet (diagnostics and tests). */
  exists(): boolean {
    return existsSync(this.file)
  }

  /**
   * Record one visit. Failures are swallowed by design: history is a
   * convenience, and losing an entry must never break the tool call that
   * produced it.
   * @param page - the visited page.
   */
  append(page: VisitedPage): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      appendFileSync(this.file, `${JSON.stringify(page)}\n`)
    } catch {
      // Best-effort: history is not worth failing a navigation over.
    }
    this.appendedSincePrune++
  }

  /**
   * Read visits, newest first. Unparseable lines are skipped; entries older
   * than the age limit are filtered out but left on disk until the next prune.
   * @param options - optional result cap plus three filters: `domain` (hostname),
   *   `query` (substring of the URL or title) and `session` (the task that visited
   *   it). Filters compose, so "the pages THIS task opened on that host" is one call.
   * @returns the matching visits, newest first.
   */
  list(options: { readonly limit?: number; readonly domain?: string; readonly query?: string; readonly session?: string } = {}): VisitedPage[] {
    const all = this.readAll()
    const cutoff = Date.now() - this.maxAgeMs
    const domain = options.domain?.toLowerCase()
    const query = options.query?.toLowerCase()
    const session = options.session
    const matches = all.filter(page => {
      if (page.at < cutoff) return false
      if (session !== undefined && page.session !== session) return false
      if (query !== undefined) {
        const haystack = `${page.url}\n${page.title ?? ''}`.toLowerCase()
        if (!haystack.includes(query)) return false
      }
      if (domain === undefined) return true
      try {
        return new URL(page.url).hostname.toLowerCase().includes(domain)
      } catch {
        return page.url.toLowerCase().includes(domain)
      }
    })
    matches.reverse()
    return options.limit === undefined ? matches : matches.slice(0, Math.max(0, options.limit))
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
  private slack(): number {
    return Math.min(PRUNE_SLACK, Math.max(1, Math.floor(this.maxEntries / 2)))
  }

  prune(): void {
    // Cheap first: past the cap but without enough new entries to justify a rewrite.
    // Reading the file to reach this conclusion was the remaining per-navigation cost.
    if (this.appendedSincePrune === 0) return
    const all = this.readAll()
    const cutoff = Date.now() - this.maxAgeMs
    const fresh = all.filter(page => page.at >= cutoff)
    const kept = fresh.length > this.maxEntries ? fresh.slice(fresh.length - this.maxEntries) : fresh
    // Every early exit has to retire the count it just spent, or the gate above stops gating.
    // It counted appends so that the common "nothing to do" case is a comparison; leaving the
    // counter set on the two paths that DO read the file meant it was never zero again, so
    // every navigation paid the full parse this was written to avoid.
    if (kept.length === all.length) {
      this.appendedSincePrune = 0
      return
    }
    // Only rewrite once the file has grown PRUNE_SLACK past what we last wrote. Asking
    // "is the file over the cap?" instead was true from the first over-cap append
    // onwards, so every single navigation after that rewrote the whole file.
    if (all.length < this.pruneThreshold) {
      // Deliberately NOT reset here: the count is what tracks progress toward the threshold,
      // so clearing it would postpone the rewrite indefinitely. The read is the price of
      // staying under the threshold, and the threshold is what bounds how often that happens.
      return
    }
    try {
      const body = kept.map(page => `${JSON.stringify(page)}\n`).join('')
      // Atomic, like the settings document. A plain writeFileSync truncates first, and this is
      // the whole history in one call: a TerminateProcess mid-write — the browser host is
      // killed exactly that way on Windows — left a partial file, and the reader drops a
      // half-written TAIL rather than the middle, so everything after the tear was lost.
      writeFileAtomic(this.file, body)
      // The file now holds only what was kept, so the next rewrite is due once
      // PRUNE_SLACK more entries have been appended.
      this.pruneThreshold = kept.length + this.slack()
      this.appendedSincePrune = 0
    } catch {
      // Best-effort: an unpruned file still reads correctly, and the atomic write leaves the
      // previous one in place when it fails.
    }
  }

  /** Parse the whole file, skipping blank and damaged lines. */
  private readAll(): VisitedPage[] {
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch {
      return []
    }
    const pages: VisitedPage[] = []
    // Strip a BOM first: trim() does not remove U+FEFF (it is not whitespace in
    // ECMAScript), so a file written by Notepad or PowerShell made the first line fail to
    // parse and be discarded as corrupt — silently losing one visit, or the whole file when
    // it holds one. settings-store strips one for the same reason.
    for (const line of raw.replace(/^\uFEFF/, '').split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        const parsed = JSON.parse(trimmed) as Partial<VisitedPage>
        if (typeof parsed.at !== 'number' || typeof parsed.url !== 'string') continue
        pages.push({
          at: parsed.at,
          url: parsed.url,
          ...typeof parsed.title === 'string' && parsed.title !== '' ? { title: parsed.title } : {},
          ...typeof parsed.session === 'string' && parsed.session !== '' ? { session: parsed.session } : {},
        })
      } catch {
        // A damaged line (typically a truncated tail) must not hide the rest.
        continue
      }
    }
    return pages
  }
}
