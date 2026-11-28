/**
 * 设置页分节：装配从旧插件机械移植来的设置面板。
 *
 * 旧面板以 `window.__ModuleLoader__.load({id, factory})` 的形式发布，工厂里用 `require("react")`
 * 取 React。本仓库的客户端半有两种运行形态——dev 下是由 vite 直接加载的原生 ESM（**没有** `require`），
 * 发布产物是 tsdown 打的 CJS 工厂。所以不能依赖环境里恰好有 `require`：这里显式注入一个只认
 * `react` 的 require 实现，两种形态行为一致。
 *
 * （踩过的坑：直接引用环境 `require` 时，dev 下会在 apply 里抛 TypeError，导致**同一 apply 里后续**
 * 的侧栏标签注册一起失效——界面表现为「浏览器入口和设置页同时消失」。）
 *
 * @module dsh-builtin-browser/client/settings
 */
import type { Context } from '@deepseek-ai/cordis'
import * as React from 'react'
import { loadSettingsPanel } from './panel.ts'
import { claimSettingsMount, markSettingsMounted } from './mount-guard.ts'

/** 旧面板在运行期需要的模块；它只 require('react') 一个。 */
function panelRequire(id: string): unknown {
  if (id === 'react') return React
  throw new Error(`settings panel: unsupported module ${JSON.stringify(id)}`)
}

/**
 * 注册设置分节；失败只影响这一个分节，不牵连同一次 apply 里的其它注册。
 * @param ctx - 客户端上下文（`slots` 与 `locale` 由面板自己使用）。
 */
export function applySettingsSection(ctx: Context): void {
  // The host keeps the slot registration from the first apply, and HMR replaces this module in
  // place, so a re-apply would register the same `settings.section` id twice — the host then fails
  // the whole client registration and the panel disappears (issue #132). The flag is per page and
  // is set only after a successful mount, so a genuinely failed mount still retries.
  const scope = globalThis as unknown as Record<string, unknown>
  if (!claimSettingsMount(scope)) return
  try {
    loadSettingsPanel(panelRequire).apply(ctx as never)
    markSettingsMounted(scope)
  } catch (error) {
    console.warn('[dsh-builtin-browser] settings section failed to mount', error)
  }
}
