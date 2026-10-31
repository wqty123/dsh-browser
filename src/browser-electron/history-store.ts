/**
 * Persistent browsing history: which pages the shared browser actually visited,
 * kept independently from any session's operation log (`dsh_browser_history`) and
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
  /** Entry count at which another batched rewrite is due. */
  private pruneThreshold: number
  /** Number of entries at the last full read, unknown until the first prune. */
  private knownEntries: number | undefined
  /** Successful appends since the last full read. */
  private appendedSincePrune = 0
  /** Earliest retained visit's expiry; time can require a prune without any new visit. */
  private nextExpiryAt = Infinity
  /** Changing retention invalidates both the count and the age calculation. */
  private limitsChanged = false
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
    const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES
    const maxAgeMs = (limits.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS) * 24 * 60 * 60 * 1000
    if (maxEntries === this.maxEntries && maxAgeMs === this.maxAgeMs) return
    this.maxEntries = maxEntries
    this.maxAgeMs = maxAgeMs
    this.pruneThreshold = this.maxEntries + this.slack()
    this.limitsChanged = true
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
      this.appendedSincePrune++
      this.nextExpiryAt = Math.min(this.nextExpiryAt, page.at + this.maxAgeMs + 1)
    } catch {
      // Best-effort: history is not worth failing a navigation over.
    }
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
    // The on-disk count may include the small batch slack; that is a write optimization,
    // not permission to expose visits beyond the operator's retained-entry limit.
    const cutoff = Date.now() - this.maxAgeMs
    const fresh = this.readAll().filter(page => page.at >= cutoff)
    const all = fresh.length > this.maxEntries ? fresh.slice(-this.maxEntries) : fresh
    const domain = options.domain?.toLowerCase()
    const query = options.query?.toLowerCase()
    const session = options.session
    const matches = all.filter(page => {
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
    // Ordinary navigations compare counters and a timestamp only. Read once on startup,
    // when a batch fills, when limits change, or when an existing visit actually expires.
    const now = Date.now()
    if (this.knownEntries !== undefined && !this.limitsChanged
      && this.knownEntries + this.appendedSincePrune < this.pruneThreshold
      && now < this.nextExpiryAt) return
    const all = this.readAll()
    const cutoff = now - this.maxAgeMs
    const fresh = all.filter(page => page.at >= cutoff)
    const kept = fresh.length > this.maxEntries ? fresh.slice(fresh.length - this.maxEntries) : fresh
    try {
      if (kept.length !== all.length) {
        writeFileAtomic(this.file, kept.map(page => `${JSON.stringify(page)}\n`).join(''))
      }
      this.knownEntries = kept.length
      this.appendedSincePrune = 0
      this.limitsChanged = false
      this.nextExpiryAt = kept.reduce((earliest, page) => Math.min(earliest, page.at + this.maxAgeMs + 1), Infinity)
    } catch {
      // Best-effort: an unpruned file still reads correctly, and the atomic write leaves the
      // previous one in place when it fails. Keep the next prune eligible to retry.
      this.limitsChanged = true
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
