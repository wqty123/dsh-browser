// The client half as it ships: `lib/client.js`, produced by `node scripts/build.mjs`.
//
// Tests read the built bundle instead of a checked-in copy, so they cannot drift from what DSH loads.
// The bundler keeps one `// <source path>` comment ahead of every module it inlines; those markers let
// a test pick out one module's compiled code without re-implementing the build.
import { existsSync, readFileSync } from 'node:fs'

export const CLIENT_BUNDLE = new URL('../../lib/client.js', import.meta.url)

let cached

export function clientBundle() {
  if (cached !== undefined) return cached
  if (!existsSync(CLIENT_BUNDLE)) throw new Error('lib/client.js is missing: run `node scripts/build.mjs` before the client tests')
  cached = readFileSync(CLIENT_BUNDLE, 'utf8')
  return cached
}

/** The compiled code of each inlined module, keyed by its source path. */
export function bundledModules(source = clientBundle()) {
  const modules = new Map()
  const markers = [...source.matchAll(/^\t*\/\/ ((?:assets|src)\/[\w./-]+\.(?:mjs|js|ts|tsx))$/gm)]
  markers.forEach((marker, index) => {
    const end = index + 1 < markers.length ? markers[index + 1].index : source.length
    modules.set(marker[1], source.slice(marker.index, end))
  })
  return modules
}

export function bundledModule(path, source = clientBundle()) {
  const code = bundledModules(source).get(path)
  if (code === undefined) throw new Error(`lib/client.js no longer inlines ${path}`)
  return code
}

/** Modules the settings panel reads at module scope, in bundle order. */
const PANEL_MODULES = [
  'assets/browser-policy.mjs',
  'assets/browser-messages.mjs',
  'assets/browser-panel-locales.mjs',
  'src/compat/host-features.ts',
  'src/client/settings/panel.ts',
]

/**
 * The built settings panel wrapped as a ModuleLoader bundle of its own: `factory(require)` returns
 * the panel's `{ name, inject, apply }`, with `require` being the only thing a test supplies.
 */
export function settingsPanelBundle() {
  const code = PANEL_MODULES.map(path => bundledModule(path)).join('\n')
  return `window.__ModuleLoader__.load({ factory(require) {\n${code}\nreturn loadSettingsPanel(require);\n} })`
}
