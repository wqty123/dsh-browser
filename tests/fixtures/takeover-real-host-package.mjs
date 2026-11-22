import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir, cp, symlink } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

/** Build the entire production client entry; all DSH/React modules come from the real Web host. */
export async function realHostPackage(directory, runtime) {
  const repo = fileURLToPath(new URL('../../', import.meta.url)), require = createRequire(join(repo, 'package.json'))
  const ts = require('typescript')
  const { rolldown } = await import(pathToFileURL(createRequire(require.resolve('tsdown')).resolve('rolldown')).href)
  const bundle = await rolldown({ input: join(repo, 'src/client/index.ts'), platform: 'browser',
    external: id => id.startsWith('@deepseek-ai/') || id === 'react' || id.startsWith('react/'),
    plugins: [{ name: 'production-client-types-and-styles',
      async load(id) {
        if (!id.endsWith('.css')) return
        let css = await readFile(id, 'utf8')
        const prefix = basename(id).replace(/\W/gu, '_') + '_'
        const names = Object.fromEntries([...css.matchAll(/\.([a-zA-Z][\w-]*)/gu)].map(match => [match[1], prefix + match[1]]))
        css = css.replace(/\.([a-zA-Z][\w-]*)/gu, (_, key) => '.' + names[key])
        return { code: `const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.append(style);export default ${JSON.stringify(names)}`, moduleType: 'js' }
      },
      transform(code, id) {
        if (id.endsWith('.tsx')) return ts.transpileModule(code, { compilerOptions: {
          jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
        } }).outputText
      },
    }],
  })
  const { output } = await bundle.generate({ format: 'cjs' }).finally(() => bundle.close())
  const plugin = join(directory, 'plugin'), driver = join(directory, 'driver')
  await mkdir(join(plugin, 'dist'), { recursive: true })
  await mkdir(driver, { recursive: true })
  await cp(join(repo, 'lib'), join(plugin, 'lib'), { recursive: true })
  await symlink(join(runtime, 'node_modules'), join(directory, 'node_modules'), 'junction')
  const manifest = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'))
  manifest.exports = manifest.publishConfig.exports
  await writeFile(join(plugin, 'package.json'), JSON.stringify(manifest))
  await writeFile(join(plugin, 'dist/client.cjs'), `window.__ModuleLoader__.load({id:'dsh-builtin-browser',factory:require=>{var module={exports:{}};var exports=module.exports;${output.find(chunk => chunk.type === 'chunk').code}\nreturn module.exports}})`)
  await cp(new URL('./takeover-real-host-driver.mjs', import.meta.url), join(driver, 'index.mjs'))
  await writeFile(join(driver, 'package.json'), JSON.stringify({ name: 'takeover-real-host-driver', type: 'module',
    exports: { '.': './index.mjs', './client': './client.cjs' }, dsh: { client: { platform: 'web', inject: [
      '@deepseek-ai/dsh-client-ui-workspace', '@deepseek-ai/dsh-client-ui-sidebar-right', '@deepseek-ai/dsh-client-locale',
    ] } },
  }))
  await writeFile(join(driver, 'client.cjs'), `window.__ModuleLoader__.load({id:'takeover-real-host-driver',factory:()=>({inject:['uiWorkspace','sidebarRight','locale'],apply(ctx){window.__takeoverHost=ctx}})})`)
  const patch = join(directory, 'overlay.json')
  await writeFile(patch, JSON.stringify([{ id: 'ui-sidebar-browser', disabled: true }, { insert: [
    { id: 'dsh-builtin-browser', name: join(plugin, 'lib/index.js') },
    { id: 'browser', name: join(plugin, 'lib/browser/runtime.js') },
    { id: 'browser-electron', name: join(plugin, 'lib/browser-electron/entry.js') },
    { id: 'tool-browser', name: join(plugin, 'lib/tool-browser/index.js') },
    { id: 'browser-startpage', name: join(plugin, 'lib/startpage.js') },
    { id: 'takeover-real-host-driver', name: join(driver, 'index.mjs') },
  ] }]))
  const runtimeRequire = createRequire(join(runtime, 'package.json'))
  return { patch, cli: join(dirname(runtimeRequire.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js') }
}
