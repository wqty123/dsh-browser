/** Pure start-page preference projection and draft validation. */
import { parseBrowserAddress } from '../browser/url.ts'
import type { BrowserTarget } from '../browser/url.ts'
import { buildSearchTarget, resolveAddressInput } from '../browser/omnibox.ts'
import type { OmniboxRefusal, SearchEngine } from '../browser/omnibox.ts'
import {
  DEFAULT_SEARCH_ENGINE_ID, MAX_ENGINE_LABEL_LENGTH,
  MAX_SHORTCUT_ICON_KEY_LENGTH, MAX_SHORTCUT_TITLE_LENGTH, MAX_STARTPAGE_ENGINES, MAX_STARTPAGE_SHORTCUTS,
  defaultStartPagePreferences, isPreferenceId, isQueryParameterName,
} from '../../startpage-settings.ts'
import type { BrowserSearchEngine, BrowserShortcut, BrowserStartPagePreferences } from '../../startpage-settings.ts'

/** Maximum extra search parameters accepted on one engine. */
export const MAX_ENGINE_EXTRA_PARAMETERS = 8

/** Maximum length of one extra search parameter value. */
export const MAX_ENGINE_PARAMETER_VALUE_LENGTH = 200

/** One shortcut as the start page renders and navigates it. */
export interface StartPageShortcutView {
  readonly id: string
  readonly title: string
  readonly url: string
  readonly iconKey: string
  /** Validated target; undefined when the stored address is unusable. */
  readonly target: BrowserTarget | undefined
}

/** One search engine as the address bar and engine menu use it. */
export interface StartPageEngineView {
  readonly id: string
  readonly label: string
  readonly homeUrl: string
  readonly searchUrl: string
  readonly queryParameter: string
  readonly extraParameters: Readonly<Record<string, string>>
  /** Whether the endpoint and parameters can produce a validated search address. */
  readonly valid: boolean
}

/** Domain-level projection of the shared preference section. */
export interface StartPageData {
  readonly defaultSearchEngineId: string
  readonly engines: readonly StartPageEngineView[]
  readonly shortcuts: readonly StartPageShortcutView[]
}

/** A user-editable shortcut form value. */
export interface ShortcutDraft {
  readonly title: string
  readonly url: string
  /** Empty or absent selects the destination's local mark. */
  readonly iconKey?: string
}

/** A user-editable search-engine form value. */
export interface SearchEngineDraft {
  readonly label: string
  readonly homeUrl: string
  readonly searchUrl: string
  readonly queryParameter: string
  readonly extraParameters?: Readonly<Record<string, string>>
}

/** Every refusal a start-page edit can report. */
export type StartPageFailure =
  | OmniboxRefusal
  | 'title' | 'label' | 'icon' | 'parameter' | 'parameters'
  | 'limit' | 'missing' | 'readonly' | 'unavailable' | 'conflict' | 'failed'

/** Successful draft normalization. */
export type DraftResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: StartPageFailure }

/**
 * Project stored preferences onto the start page, dropping structurally
 * unusable entries while keeping unusable addresses visible for repair.
 * @param value - schema-resolved section, or undefined before first load.
 * @param applicationOrigin - current DSH origin refused by address admission.
 * @returns display and navigation data in stored order.
 */
export function normalizeStartPage(value: BrowserStartPagePreferences | undefined,
  applicationOrigin: string): StartPageData {
  const section = value ?? defaultStartPagePreferences()
  const engines = normalizeEngines(section.searchEngines, applicationOrigin)
  return {
    defaultSearchEngineId: typeof section.defaultSearchEngineId === 'string' && section.defaultSearchEngineId !== ''
      ? section.defaultSearchEngineId
      : DEFAULT_SEARCH_ENGINE_ID,
    engines,
    shortcuts: normalizeShortcuts(section.shortcuts, applicationOrigin),
  }
}

/** @returns valid engines in the shape the manual resolver consumes. */
export function searchEnginePreferences(data: StartPageData): readonly SearchEngine[] {
  return data.engines.flatMap(engine => engine.valid ? [{
    id: engine.id,
    label: engine.label,
    homeUrl: engine.homeUrl,
    searchUrl: engine.searchUrl,
    queryParameter: engine.queryParameter,
    extraParameters: engine.extraParameters,
  }] : [])
}

/**
 * Validate one shortcut form value against the strict address branch.
 * @param draft - typed name and address.
 * @param applicationOrigin - current DSH origin refused by address admission.
 * @returns the normalized shortcut fields or the field to correct.
 */
export function normalizeShortcutDraft(draft: ShortcutDraft,
  applicationOrigin: string): DraftResult<Omit<BrowserShortcut, 'id'>> {
  const address = resolveAddressInput(draft.url, applicationOrigin)
  if (!address.ok) return { ok: false, reason: address.reason }
  const typed = draft.title.trim()
  if (typed.length > MAX_SHORTCUT_TITLE_LENGTH) return { ok: false, reason: 'title' }
  const iconKey = (draft.iconKey ?? '').trim()
  if (iconKey.length > MAX_SHORTCUT_ICON_KEY_LENGTH || !/^[a-z0-9-]*$/u.test(iconKey)) {
    return { ok: false, reason: 'icon' }
  }
  const value = { title: typed === '' ? address.target.title : typed, url: address.target.url, iconKey }
  return { ok: true, value }
}

/**
 * Validate one search-engine form value; endpoints and parameters are fixed data.
 * @param draft - typed endpoint and query parameter.
 * @param applicationOrigin - current DSH origin refused by address admission.
 * @returns normalized engine fields or the field to correct.
 */
export function normalizeSearchEngineDraft(draft: SearchEngineDraft,
  applicationOrigin: string): DraftResult<Omit<BrowserSearchEngine, 'id'>> {
  const label = draft.label.trim()
  if (label === '' || label.length > MAX_ENGINE_LABEL_LENGTH) return { ok: false, reason: 'label' }
  if (!isQueryParameterName(draft.queryParameter)) return { ok: false, reason: 'parameter' }
  const home = resolveAddressInput(draft.homeUrl, applicationOrigin)
  if (!home.ok) return { ok: false, reason: home.reason }
  const search = resolveAddressInput(draft.searchUrl, applicationOrigin)
  if (!search.ok) return { ok: false, reason: search.reason }
  const extra = draft.extraParameters ?? {}
  const entries = Object.entries(extra)
  if (entries.length > MAX_ENGINE_EXTRA_PARAMETERS) return { ok: false, reason: 'parameters' }
  for (const [name, value] of entries) {
    if (!isQueryParameterName(name) || value.length > MAX_ENGINE_PARAMETER_VALUE_LENGTH) {
      return { ok: false, reason: 'parameters' }
    }
  }
  return {
    ok: true,
    value: {
      label,
      homeUrl: home.target.url,
      searchUrl: search.target.url,
      queryParameter: draft.queryParameter,
      extraParameters: { ...extra },
    },
  }
}

/**
 * Reorder stored shortcuts by id without losing entries another client added.
 * @param entries - current stored entries.
 * @param orderedIds - ids in the requested order.
 * @returns the next array; unchanged entries keep their stored position.
 */
export function reorderShortcuts(entries: readonly BrowserShortcut[],
  orderedIds: readonly string[]): readonly BrowserShortcut[] {
  const used = new Set<number>()
  const next: BrowserShortcut[] = []
  for (const id of orderedIds) {
    const index = entries.findIndex((entry, offset) => entry.id === id && !used.has(offset))
    if (index === -1) continue
    used.add(index)
    next.push(entries[index]!)
  }
  entries.forEach((entry, index) => { if (!used.has(index)) next.push(entry) })
  return next
}

/** @returns whether two id sequences describe the same stored order. */
export function sameShortcutOrder(left: readonly BrowserShortcut[],
  right: readonly BrowserShortcut[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry.id === right[index]?.id)
}

/** @returns a fresh id that is not already stored. */
export function nextShortcutId(existing: readonly BrowserShortcut[], createId: () => string): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = createId()
    if (isPreferenceId(id) && !existing.some(entry => entry.id === id)) return id
  }
  return `s-${String(Date.now())}`
}

/** @returns a fresh engine id that is not already stored. */
export function nextEngineId(existing: readonly BrowserSearchEngine[], createId: () => string): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = createId()
    if (isPreferenceId(id) && !existing.some(entry => entry.id === id)) return id
  }
  return `e-${String(Date.now())}`
}

/** @returns the stored shortcut index for an id, or -1. */
export function shortcutIndex(entries: readonly BrowserShortcut[], id: string): number {
  return entries.findIndex(entry => entry.id === id)
}

/** @returns the stored engine index for an id, or -1. */
export function engineIndex(entries: readonly BrowserSearchEngine[], id: string): number {
  return entries.findIndex(entry => entry.id === id)
}

function normalizeEngines(value: unknown, applicationOrigin: string): readonly StartPageEngineView[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const engines: StartPageEngineView[] = []
  for (const raw of value) {
    if (engines.length >= MAX_STARTPAGE_ENGINES) break
    if (typeof raw !== 'object' || raw === null) continue
    const record = raw as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id : ''
    if (!isPreferenceId(id) || seen.has(id)) continue
    seen.add(id)
    const homeUrl = typeof record.homeUrl === 'string' ? record.homeUrl : ''
    const searchUrl = typeof record.searchUrl === 'string' ? record.searchUrl : ''
    const queryParameter = typeof record.queryParameter === 'string' ? record.queryParameter : ''
    const extraParameters = normalizeExtraParameters(record.extraParameters)
    const label = typeof record.label === 'string' && record.label.trim() !== '' ? record.label : id
    const engine: StartPageEngineView = {
      id, label, homeUrl, searchUrl, queryParameter, extraParameters: extraParameters ?? {},
      valid: extraParameters !== undefined && queryParameter !== ''
        && parseBrowserAddress(homeUrl, applicationOrigin).ok
        && buildSearchTarget({ id, label, homeUrl, searchUrl, queryParameter, extraParameters }, 'dsh', applicationOrigin) !== undefined,
    }
    engines.push(engine)
  }
  return engines
}

function normalizeExtraParameters(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const result: Record<string, string> = {}
  for (const [name, entry] of Object.entries(value)) {
    if (!isQueryParameterName(name) || typeof entry !== 'string' || entry.length > MAX_ENGINE_PARAMETER_VALUE_LENGTH) return undefined
    result[name] = entry
  }
  return Object.keys(result).length > MAX_ENGINE_EXTRA_PARAMETERS ? undefined : result
}

function normalizeShortcuts(value: unknown, applicationOrigin: string): readonly StartPageShortcutView[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const shortcuts: StartPageShortcutView[] = []
  for (const raw of value) {
    if (shortcuts.length >= MAX_STARTPAGE_SHORTCUTS) break
    if (typeof raw !== 'object' || raw === null) continue
    const record = raw as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id : ''
    if (!isPreferenceId(id) || seen.has(id)) continue
    seen.add(id)
    const url = typeof record.url === 'string' ? record.url : ''
    const parsed = parseBrowserAddress(url, applicationOrigin)
    const target = parsed.ok ? parsed.target : undefined
    const storedTitle = typeof record.title === 'string' ? record.title.trim() : ''
    shortcuts.push({
      id,
      url,
      target,
      title: (storedTitle === '' ? target?.title ?? url : storedTitle).slice(0, MAX_SHORTCUT_TITLE_LENGTH),
      iconKey: typeof record.iconKey === 'string' ? record.iconKey : '',
    })
  }
  return shortcuts
}
