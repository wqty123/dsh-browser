import { readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

export function typescriptSourceLoader() {
  const sourceRoot = new URL('../src/', import.meta.url).href
  return registerHooks({
    load(url, context, nextLoad) {
      if (url.startsWith(sourceRoot) && url.endsWith('.ts')) {
        return {
          format: 'module',
          source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform', sourceUrl: url }),
          shortCircuit: true,
        }
      }
      return nextLoad(url, context)
    },
  })
}
