/** Shared, schema-independent Sidebar Browser start-page preference model. */

/** Settings namespace owned by the start-page Host companion. */
export const BROWSER_STARTPAGE_NAMESPACE = 'browser-startpage'

/** Persisted preference layout version. */
export const BROWSER_STARTPAGE_VERSION = 1

/** Maximum stored shortcut entries. */
export const MAX_STARTPAGE_SHORTCUTS = 48

/** Maximum stored search engines. */
export const MAX_STARTPAGE_ENGINES = 12

/** Maximum stored URL length; shorter than the address-bar bound to keep patches readable. */
export const MAX_STARTPAGE_URL_LENGTH = 2048

/** Maximum shortcut display title length. */
export const MAX_SHORTCUT_TITLE_LENGTH = 80

/** Maximum search-engine display label length. */
export const MAX_ENGINE_LABEL_LENGTH = 48

/** Maximum shortcut icon key length; keys select local glyphs only. */
export const MAX_SHORTCUT_ICON_KEY_LENGTH = 32

/** One user-visible website entry. */
export interface BrowserShortcut {
  readonly id: string
  readonly title: string
  readonly url: string
  readonly iconKey?: string
}

/** One fixed search endpoint; no template syntax is interpreted. */
export interface BrowserSearchEngine {
  readonly id: string
  readonly label: string
  readonly homeUrl: string
  readonly searchUrl: string
  readonly queryParameter: string
  readonly extraParameters?: Readonly<Record<string, string>>
}

/** The complete shared start-page section. Array order is display order. */
export interface BrowserStartPagePreferences {
  readonly version: number
  readonly defaultSearchEngineId: string
  readonly searchEngines: readonly BrowserSearchEngine[]
  readonly shortcuts: readonly BrowserShortcut[]
}

/** Initial default engine. */
export const DEFAULT_SEARCH_ENGINE_ID = 'bing'

/** Initial search endpoints; replaceable by the user. */
export const DEFAULT_SEARCH_ENGINES: readonly BrowserSearchEngine[] = Object.freeze([
  {
    id: 'bing', label: 'Bing', homeUrl: 'https://www.bing.com/',
    searchUrl: 'https://www.bing.com/search', queryParameter: 'q', extraParameters: {},
  },
  {
    id: 'baidu', label: '百度', homeUrl: 'https://www.baidu.com/',
    searchUrl: 'https://www.baidu.com/s', queryParameter: 'wd', extraParameters: {},
  },
])

/** Initial website entries; editable, deletable, and never re-added after removal. */
export const DEFAULT_SHORTCUTS: readonly BrowserShortcut[] = Object.freeze([
  { id: 'bing', title: 'Bing', url: 'https://www.bing.com/', iconKey: 'bing' },
  { id: 'baidu', title: '百度', url: 'https://www.baidu.com/', iconKey: 'baidu' },
  { id: 'deepseek', title: 'DeepSeek', url: 'https://chat.deepseek.com/', iconKey: 'deepseek' },
])

/**
 * Build a detached initial preference section.
 * @returns defaults safe for schema defaults and first-run display.
 */
export function defaultStartPagePreferences(): BrowserStartPagePreferences {
  return {
    version: BROWSER_STARTPAGE_VERSION,
    defaultSearchEngineId: DEFAULT_SEARCH_ENGINE_ID,
    searchEngines: DEFAULT_SEARCH_ENGINES.map(engine => ({ ...engine })),
    shortcuts: DEFAULT_SHORTCUTS.map(shortcut => ({ ...shortcut })),
  }
}

/**
 * Whether a value can be a stable preference identifier.
 * @param value - candidate id.
 * @returns true for lowercase alphanumeric ids with inner dashes.
 */
export function isPreferenceId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,47}$/u.test(value)
}

/**
 * Whether a value can name a URL query parameter.
 * @param value - candidate parameter name.
 * @returns true for a bounded plain name.
 */
export function isQueryParameterName(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_.-]{0,31}$/u.test(value)
}
