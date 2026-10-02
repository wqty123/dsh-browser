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

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { VisitedPage } from '../browser/types.js'

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
  private readonly maxEntries: number
  private readonly maxAgeMs: number

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
  prune(): void {
    const all = this.readAll()
    const cutoff = Date.now() - this.maxAgeMs
    const fresh = all.filter(page => page.at >= cutoff)
    const kept = fresh.length > this.maxEntries ? fresh.slice(fresh.length - this.maxEntries) : fresh
    // Only rewrite when something actually fell off, and only once the excess
    // is worth a full rewrite.
    if (kept.length === all.length) return
    if (all.length - kept.length < PRUNE_SLACK && fresh.length <= this.maxEntries) return
    try {
      const body = kept.map(page => `${JSON.stringify(page)}\n`).join('')
      writeFileSync(this.file, body)
    } catch {
      // Best-effort: an unpruned file still reads correctly.
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
