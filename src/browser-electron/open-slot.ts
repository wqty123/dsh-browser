/**
 * The last page a tool opened, shared by the provider and the HTTP surface.
 *
 * The provider instance that runs a tool and the one that answers routes are not guaranteed to be the
 * same object (a surface can be built per context), so an instance field read back `null`. A module-level
 * slot is what both sides can see — and it is what lets the Web sidebar place a tool-opened page with one
 * call instead of a manual address-bar dance.
 * @module dsh-builtin-browser/browser-electron/open-slot
 */

/**
 * The slot lives on \`globalThis\`: the plugin's lib can be imported by more than one module instance in the
 * same process (tools and the HTTP surface), and module-level state is per instance — which read back as
 * \`null\` even after an open.
 */
const SLOT = '__dshBuiltinBrowserLastOpen'

/**
 * Record an open request.
 * @param url - the page a tool asked to open.
 * @param at - arrival time in epoch milliseconds.
 */
export function setLastOpen(url: string, at: number, owner?: string): void {
  (globalThis as unknown as Record<string, unknown>)[SLOT] = { url, at, ...owner === undefined ? {} : { owner } }
}

/**
 * Read the most recent open request.
 * @returns the request, or undefined when nothing was opened since start.
 */
export function getLastOpen(): { readonly url: string; readonly at: number; readonly owner?: string } | undefined {
  return (globalThis as unknown as Record<string, { url: string; at: number; owner?: string } | undefined>)[SLOT]
}

/**
 * 清空 open 记录（客户端摆放完侧栏标签后回执）。
 *
 * 「最后一次 open」如果一直留着，刷新页面或换一个标签页打开 DSH 时就会被重放，把用户已经关掉的
 * 侧栏与网页重新拉起来。拿到回执即清空，这条记录就变成一次性事件。
 * @param at - 只有记录的到达时间与之一致时才清空；省略则无条件清空。
 * @returns 是否真的清掉了。
 */
export function clearLastOpen(at?: number): boolean {
  const current = getLastOpen()
  if (current === undefined) return false
  if (at !== undefined && current.at !== at) return false
  delete (globalThis as unknown as Record<string, unknown>)[SLOT]
  return true
}
