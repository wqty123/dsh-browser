/**
 * 侧栏 guest 代理的路由注册。
 *
 * 这条路由原先只在 `browser-electron` 行里注册。web 端没有可用的 Electron 二进制时那行会被关掉，
 * 结果侧栏 iframe 请求 `/dsh-builtin-browser/browser-view/guest` 直接 404 —— 表现为「搜索后白屏」。
 * 代理与载体无关，注册放到根行，任何载体组合下侧栏都能打开页面。
 * @module dsh-builtin-browser/web-guest
 */
import type { Context } from '@deepseek-ai/cordis'
import { overlayScript } from './browser-reference/entry.ts'
import { GUEST_ROUTE, handleGuest } from './browser-electron/guest-route.ts'

/**
 * 浮条安装脚本；链接和表单由 guest runtime 统一处理。
 * @returns 注入到每个代理 HTML 末尾的 `<script>`。
 */
function overlayTag(): string {
  const source = overlayScript().replace(/<\/script/giu, '<\\/script')
  return `<script data-dsh-ref-overlay-inline="1">(function(){\n${source}\n})()</script>`
}

/**
 * 在宿主侧注册 guest 代理路由（需要 `webServer`；没有该服务的环境安静跳过）。
 * @param ctx - 插件容器。
 */
export function registerWebGuest(ctx: Context): void {
  const inject = (ctx as unknown as {
    inject?: (names: readonly string[], callback: (host: {
      readonly webServer: { register(route: { kind: string; path: string; handler: (request: unknown, response: unknown) => void }, label?: string): () => void }
      effect(callback: () => () => void, label?: string): void
    }) => void) => void
  }).inject
  if (typeof inject !== 'function') return
  inject(['webServer'], (host) => {
    host.effect(() => host.webServer.register({
      kind: 'exact',
      path: GUEST_ROUTE,
      handler: (request, response) => handleGuest(request as never, response as never, overlayTag(), ''),
    }, 'dsh-builtin-browser: web guest proxy (root row)'))
  })
}
