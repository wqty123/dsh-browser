/**
 * Runtime feature probes for the DSH host, in one place.
 *
 * Host lines are not comparable by version string (the official 0.2.3-alpha.2 and a community
 * shell's 0.14.0 share nothing), so every check here asks the running host what it offers instead.
 * Dependency-free on purpose: both the Node host half and the browser client half import it.
 * @module dsh-browser/compat/host-features
 */
import type { DesktopBrowserBridge, DesktopBrowserChildTabs, DesktopNativeChildTabs, DesktopNativeViews } from '../types.ts'

interface ServiceLookup { readonly get?: (name: string) => unknown }
interface ToolRegistry { readonly register: (tool: never, options?: never) => unknown }

/**
 * Whether DSH's PTC executor is active, so `run_code` already batches every tool.
 * @param ctx - the plugin context.
 * @returns true when the `ptcRuntime` service is present.
 */
export function ptcRuntimeActive(ctx: unknown): boolean {
  try { return (ctx as ServiceLookup).get?.('ptcRuntime') !== undefined } catch { return false }
}

/**
 * Register a tool, visible only while `when` holds.
 *
 * Registration options arrived with DSH 0.2.2; an older registry ignores the second argument and
 * keeps the tool always visible, which is the safe fallback for every caller here.
 * @param registry - `ctx.tools`.
 * @param tool - the tool definition.
 * @param when - visibility predicate; omitted registers unconditionally.
 * @returns whatever the registry returns.
 */
export function registerTool(registry: ToolRegistry, tool: unknown, when?: () => boolean): unknown {
  const register = registry.register as (tool: unknown, options?: { when: () => boolean }) => unknown
  return when === undefined ? register.call(registry, tool) : register.call(registry, tool, { when })
}

interface DesktopCarrier { readonly protocolVersion?: unknown; readonly browser?: DesktopBrowserBridge }

/**
 * The renderer's narrow desktop browser bridge (`window.dshDesktop`, protocol 1).
 * @param scope - the global object; injectable for tests.
 * @returns the bridge, or undefined outside a desktop shell that speaks protocol 1.
 */
export function desktopBrowserBridge(scope: object = globalThis): DesktopBrowserBridge | undefined {
  const carrier = (scope as { dshDesktop?: DesktopCarrier | null }).dshDesktop
  return carrier !== null && typeof carrier === 'object' && carrier.protocolVersion === 1 ? carrier.browser : undefined
}

/**
 * Native views (protocol 1) of the desktop bridge.
 * @param scope - the global object, or the bridge itself.
 * @returns the native views API, or undefined when the shell does not offer protocol 1.
 */
export function nativeViews(scope: object = globalThis): DesktopNativeViews | undefined {
  const views = (scope as { browser?: { nativeViews?: DesktopNativeViews } }).browser?.nativeViews
    ?? (scope as { dshDesktop?: { browser?: { nativeViews?: DesktopNativeViews } } | null }).dshDesktop?.browser?.nativeViews
    ?? (scope as { nativeViews?: DesktopNativeViews }).nativeViews
  return views?.protocolVersion === 1 ? views : undefined
}

/**
 * URL-only child tab requests (protocol 1).
 * @param bridge - the desktop browser bridge.
 * @returns the API, or undefined when the shell offers another protocol or none.
 */
export function urlChildTabs(bridge: Pick<DesktopBrowserBridge, 'childTabs'> | undefined): DesktopBrowserChildTabs | undefined {
  const tabs = bridge?.childTabs
  return tabs?.protocolVersion === 1 ? tabs : undefined
}

/**
 * Native opener child tabs (protocol 2).
 * @param bridge - the desktop browser bridge.
 * @returns the API, or undefined when the shell offers another protocol or none.
 */
export function nativeChildTabs(bridge: Pick<DesktopBrowserBridge, 'childTabs'> | undefined): DesktopNativeChildTabs | undefined {
  const tabs = bridge?.childTabs
  return tabs?.protocolVersion === 2 ? tabs : undefined
}
