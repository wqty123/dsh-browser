/** Static Browser tab type and guide declaration. */
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { GuideArtworkBrowser } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SIDEBAR_BROWSER_LOCALE_NS } from './locales.ts'

/** Browser tab kind. */
export const BROWSER_KIND = 'browser'

/**
 * Plugin-owned Browser implementation identity and keyed Slot dispatch key.
 * Distinct from DSH's built-in `@deepseek-ai/dsh-client-ui-sidebar-browser` so both
 * can coexist when a user profile re-enables the built-in row (issue #107).
 */
export const BROWSER_ID = 'dsh-builtin-browser'

/** Build the Browser type with locale-live copy. */
export function browserDefinition(t: TranslateNS<typeof SIDEBAR_BROWSER_LOCALE_NS>): SidebarRightTabDefinition {
  return {
    id: BROWSER_ID,
    kind: BROWSER_KIND,
    // 单标签：`multiple: true` 会让宿主在每次 `openTabIn` 时铸一个新的 content id，
    // 于是「打开百度 → 搜索数独」变成新开一个标签、上一页被丢弃（用户实测报的就是这个）。
    // 浏览器标签按会话只有一个，新的地址在**原地**导航。
    multiple: false,
    // Extension band natively takes over DSH's `builtin` `browser` kind without throwing,
    // and cleanly yields back to the built-in implementation if this plugin is removed.
    priority: 'extension',
    title: () => t('type.label'),
    guide: [{
      id: 'new', commandId: 'browser.new' as ShortcutCommandId, order: 30, title: () => t('guide.title'),
      description: () => t('guide.description'), icon: GuideArtworkBrowser,
    }],
  }
}
