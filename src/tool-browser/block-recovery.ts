/**
 * The tool-facing half of anti-bot handling: one output schema and one projection for a blocked
 * page's verdict, so every tool that reports a challenge reports the same fields — what blocked
 * it, what to do, and the public routes to the same information.
 * @module dsh-browser/tool-browser/block-recovery
 */

import { fallbackRoutes, recoveryAdvice, type FallbackRoute } from '../browser/anti-bot.ts'
import type { BrowserChallenge } from '../browser/types.ts'

/** A verdict as tools return it. */
export interface ChallengeReport {
  blocked: boolean
  kind?: string
  reason?: string
  recovery?: NonNullable<BrowserChallenge['recovery']>
  status?: number
  /** Set when the open already made its one paced retry in a fresh session. */
  retried?: boolean
  advice?: string
  fallbacks?: FallbackRoute[]
}

/** Output schema shared by dsh_browser_open, dsh_browser_snapshot and dsh_browser_challenge. */
export const CHALLENGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    blocked: { type: 'boolean', required: true },
    kind: { type: 'string' },
    reason: { type: 'string' },
    recovery: { type: 'string', enum: ['takeover', 'wait', 'retry', 'environment'] },
    status: { type: 'number' },
    retried: { type: 'boolean' },
    advice: { type: 'string' },
    fallbacks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, enum: ['api', 'search', 'archive'] },
          url: { type: 'string', required: true },
          note: { type: 'string', required: true },
        },
      },
    },
  },
} as const

/**
 * Project a verdict for a tool result: a clean page stays `{ blocked: false }`; a blocked one gains
 * the advice for its kind and the fallback routes for its URL.
 * @param challenge - the provider's verdict.
 * @param url - the page it is about.
 * @param retried - whether the open already retried once.
 * @returns the report.
 */
export function reportChallenge(challenge: BrowserChallenge, url: string, retried = false): ChallengeReport {
  if (challenge.blocked !== true) return { blocked: false }
  const fallbacks = fallbackRoutes(url)
  return {
    blocked: true,
    ...challenge.kind !== undefined ? { kind: challenge.kind } : {},
    ...challenge.reason !== undefined ? { reason: challenge.reason } : {},
    ...challenge.recovery !== undefined ? { recovery: challenge.recovery } : {},
    ...typeof challenge.status === 'number' ? { status: challenge.status } : {},
    ...retried ? { retried: true } : {},
    advice: recoveryAdvice(challenge),
    ...fallbacks.length > 0 ? { fallbacks } : {},
  }
}

/**
 * The banner a rendered result ends with when the page is blocked.
 * @param report - the tool's challenge report.
 * @returns the banner text, or '' for a clean page.
 */
export function challengeBanner(report: ChallengeReport | undefined): string {
  if (report?.blocked !== true) return ''
  const head = `CHALLENGE (${report.kind ?? 'blocked'}${report.status !== undefined ? `, HTTP ${report.status}` : ''}): ${report.reason ?? 'human-verification'}.`
  const retried = report.retried === true ? ' Already retried once in a fresh session after a pause.' : ''
  const routes = (report.fallbacks ?? []).map(route => `\n  - ${route.kind}: ${route.url} (${route.note})`).join('')
  return `\n\n${head}${retried} ${report.advice ?? recoveryAdvice({ blocked: true })}${routes === '' ? '' : `\nFallback routes:${routes}`}`
}
