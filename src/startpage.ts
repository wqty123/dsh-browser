/** Host registration for shared Sidebar Browser start-page preferences. */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import {
  BROWSER_STARTPAGE_VERSION, DEFAULT_SEARCH_ENGINE_ID, DEFAULT_SEARCH_ENGINES, DEFAULT_SHORTCUTS,
  MAX_ENGINE_LABEL_LENGTH, MAX_SHORTCUT_ICON_KEY_LENGTH,
  MAX_SHORTCUT_TITLE_LENGTH, MAX_STARTPAGE_ENGINES, MAX_STARTPAGE_SHORTCUTS,
  MAX_STARTPAGE_URL_LENGTH,
} from './startpage-settings.ts'
import type { BrowserSearchEngine, BrowserShortcut } from './startpage-settings.ts'

const identifier = z.string().pattern(/^[a-z0-9][a-z0-9-]{0,47}$/u).required()
const httpUrl = z.string().max(MAX_STARTPAGE_URL_LENGTH).pattern(/^https?:\/\/\S+$/u).required()

const shortcutSchema = z.object({
  id: identifier,
  title: z.string().max(MAX_SHORTCUT_TITLE_LENGTH).required(),
  url: httpUrl,
  iconKey: z.string().max(MAX_SHORTCUT_ICON_KEY_LENGTH).default(''),
})

const searchEngineSchema = z.object({
  id: identifier,
  label: z.string().max(MAX_ENGINE_LABEL_LENGTH).required(),
  homeUrl: httpUrl,
  searchUrl: httpUrl,
  queryParameter: z.string().pattern(/^[A-Za-z][A-Za-z0-9_.-]{0,31}$/u).required(),
  extraParameters: z.dict(z.string().max(200)).default({}),
})

/** Live start-page preferences projected to every client of this Host. */
export interface Config {
  /** Persisted layout version. */
  version: Volatile<number>
  /** Selected search engine id. */
  defaultSearchEngineId: Volatile<string>
  /** Search endpoints in display order. */
  searchEngines: Volatile<BrowserSearchEngine[]>
  /** Website entries in display order. */
  shortcuts: Volatile<BrowserShortcut[]>
}

const DEFAULT_ENGINE_OBJECTS = DEFAULT_SEARCH_ENGINES.map(engine => ({ ...engine, extraParameters: { ...engine.extraParameters } }))
const DEFAULT_SHORTCUT_OBJECTS = DEFAULT_SHORTCUTS.map(shortcut => ({ ...shortcut }))

/**
 * Volatile-only config: preference writes update values without remounting the browser.
 *
 * 显式标注类型：schemastery 的 `z.object(...)` 推导类型在本仓库的声明生成里会引入无法命名的
 * `Dict` 引用（`TS2883`），导致 `target/dts` 里缺少本文件的 `.d.ts`，进而被发布前检查判为
 * 「声明缺失」。标注 `z<Config>` 只影响类型，运行期对象一字未改。
 */
export const Config: z<Config> = z.object({
  version: z.number().default(BROWSER_STARTPAGE_VERSION).volatile(),
  defaultSearchEngineId: z.string().default(DEFAULT_SEARCH_ENGINE_ID).volatile(),
  searchEngines: z.array(searchEngineSchema).max(MAX_STARTPAGE_ENGINES)
    .default(DEFAULT_ENGINE_OBJECTS).volatile(),
  shortcuts: z.array(shortcutSchema).max(MAX_STARTPAGE_SHORTCUTS)
    .default(DEFAULT_SHORTCUT_OBJECTS).volatile(),
}) as z<Config>

/**
 * Keep preference writes live instead of reloading the owning entry.
 * @param ctx - the start-page Host companion's context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber), 'browser-startpage: live preferences')
  })
}
