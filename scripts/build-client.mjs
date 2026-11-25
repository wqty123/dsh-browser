/**
 * Build the DSH 0.2.3 client bundle (`lib/client.js`) as a single closure factory:
 *   window.__ModuleLoader__.load({
 *     id: "dsh-builtin-browser",
 *     factory: (require) => { ... return module.exports; },
 *     meta: () => ({ stylesheets: { "<path>": { text: (context) => "..." } } }),
 *   });
 *
 * CSS Modules (`*.module.css`) and global stylesheets (e.g. `katex/dist/katex.min.css`)
 * are compiled with lightningcss (`pattern: '[hash]_[local]'`, `minify: true`) and handed
 * off through `meta().stylesheets` instead of self-injecting `<style>` tags at runtime.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transform } from 'lightningcss'

const require = createRequire(import.meta.url)
const PACKAGE_DIR = process.cwd()
const MANIFEST = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8').replace(/^\uFEFF/, ''))
const PLUGIN_ID = MANIFEST.name
const ENTRY = resolvePath(PACKAGE_DIR, 'src/client/index.ts')
const OUT_FILE = resolvePath(PACKAGE_DIR, 'lib/client.js')

const MODULES_PREFIX = '\0dsh-css:'
const GLOBAL_PREFIX = '\0dsh-global-css:'
const INLINE_PREFIX = '\0dsh-inline-css:'
const VIRTUAL_SUFFIX = '.mjs'
const INLINE_QUERY = '?inline'
const NODE_BUILTIN = /^node:/

const BASELINE_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  /^@deepseek-ai\/cordis(\/|$)/,
  /^@deepseek-ai\/dsh-client-store(\/|$)/,
  /^@deepseek-ai\/dsh-client-ui-slots(\/|$)/,
  /^@deepseek-ai\/dsh-client-ui-primitives(\/|$)/,
  /^@deepseek-ai\/dsh-client-ui-dockkit(\/|$)/,
]

const INLINE_SAFE = /^(?:@deepseek-ai\/dsh-(?:file-reference|fs-patch|session|llm|tools|brand|error|official-bundles|deque|output-retention|typert-protocol|util-crypto|util-text-search|util-time|util-values|util-workspace-path)(?:\/|$)|@deepseek-ai\/dsh-util-file-drag$|@deepseek-ai\/dsh-token-meter\/client$|@deepseek-ai\/dsh-commands\/builtin$|@deepseek-ai\/dsh-native-command\/types$|@deepseek-ai\/dsh-host-open-in-app\/shared$|@deepseek-ai\/dsh-plugin-manager\/registry$|@deepseek-ai\/dsh-plugin-market-index\/source$|@deepseek-ai\/dsh-agent-preset-registry\/display$|@deepseek-ai\/dsh-api-workspace-controller\/default-workspace$|@deepseek-ai\/dsh-api-session-controller\/client\/directories$|@deepseek-ai\/dsh-spill-policy\/notice$|@deepseek-ai\/(?:cosmokit|schemastery)(?:\/|$)|@deepseek-ai\/cordis-plugin-timer$)/

const CSS_ASSET_MIME = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function buildExternals() {
  const peerPatterns = Object.keys(MANIFEST.peerDependencies ?? {})
    .sort()
    .map(name => new RegExp(`^${escapeRegExp(name)}(?:/|$)`))
  const explicit = Array.isArray(MANIFEST.dsh?.client?.external) ? MANIFEST.dsh.client.external : []
  return [...BASELINE_EXTERNALS, ...peerPatterns, ...explicit]
}

function isExternal(id, externals) {
  if (NODE_BUILTIN.test(id)) return false
  if (INLINE_SAFE.test(id)) return false
  return externals.some(rule => (typeof rule === 'string' ? id === rule : rule.test(id)))
}

function pathBelow(root, file) {
  const rel = relative(root, file)
  return rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? undefined : rel
}

function stylesheetKey(fileId) {
  const realFile = realpathSync(fileId)
  const local = pathBelow(realpathSync(PACKAGE_DIR), realFile)
  if (local !== undefined) return local.split(sep).join('/')
  let dir = dirname(realFile)
  while (dirname(dir) !== dir) {
    const pkgPath = join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      if (typeof pkg.name === 'string') {
        return `node_modules/${pkg.name}/${relative(dir, realFile).split(sep).join('/')}`
      }
    }
    dir = dirname(dir)
  }
  return realFile.split(sep).join('/')
}

function resolveStylesheet(source, importer) {
  if (!source.startsWith('.') && !source.startsWith('/') && !isAbsolute(source)) {
    return createRequire(importer ?? join(PACKAGE_DIR, 'package.json')).resolve(source)
  }
  return importer === undefined ? resolvePath(PACKAGE_DIR, source) : resolvePath(dirname(importer), source)
}

async function urlReplacements(cssBuffer, from) {
  const specifiers = new Set()
  transform({
    filename: from,
    code: cssBuffer,
    errorRecovery: true,
    visitor: {
      Url(url) {
        const value = url.url
        if (value && !value.startsWith('data:') && !/^(?:https?:)?\/\//u.test(value) && !value.startsWith('#') && !value.startsWith('/')) {
          specifiers.add(value)
        }
      },
    },
  })
  const replacements = new Map()
  for (const specifier of specifiers) {
    const clean = specifier.split(/[?#]/u)[0]
    const file = resolvePath(dirname(from), clean)
    let bytes
    try {
      bytes = await readFile(file)
    } catch {
      continue
    }
    const ext = (file.split('.').pop() ?? '').toLowerCase()
    const mime = CSS_ASSET_MIME[ext] ?? 'application/octet-stream'
    replacements.set(specifier, `data:${mime};base64,${bytes.toString('base64')}`)
  }
  return replacements
}

function urlVisitor(replacements) {
  if (replacements.size === 0) return undefined
  return {
    Url(url) {
      const next = replacements.get(url.url)
      return next === undefined ? undefined : { ...url, url: next }
    },
  }
}

async function loadRolldown() {
  try {
    return await import('rolldown')
  } catch {
    return await import(pathToFileURL(createRequire(require.resolve('tsdown')).resolve('rolldown')).href)
  }
}

async function buildClient() {
  const { rolldown } = await loadRolldown()
  const mode = process.env.NODE_ENV ?? 'production'
  const externals = buildExternals()
  const styles = new Map()

  const build = await rolldown({
    input: ENTRY,
    cwd: PACKAGE_DIR,
    platform: 'browser',
    resolve: {
      conditionNames: [
        mode === 'development' ? 'development' : 'production',
        'browser', 'import', 'module', 'default',
      ],
    },
    transform: {
      define: {
        'process.env.NODE_ENV': JSON.stringify(mode),
        'import.meta.env.MODE': JSON.stringify(mode),
        'import.meta.env': JSON.stringify({ MODE: mode }),
        'import.meta': '({})',
        'process.env': '({})',
      },
    },
    external: id => isExternal(id, externals),
    treeshake: { moduleSideEffects: 'no-external' },
    plugins: [
      {
        name: 'dsh-css-modules-meta',
        resolveId: {
          order: 'pre',
          handler(source, importer) {
            if (!source.endsWith('.module.css')) return null
            return MODULES_PREFIX + resolveStylesheet(source, importer) + VIRTUAL_SUFFIX
          },
        },
        async load(virtualId) {
          if (!virtualId.startsWith(MODULES_PREFIX)) return null
          const fileId = virtualId.slice(MODULES_PREFIX.length, -VIRTUAL_SUFFIX.length)
          const source = await readFile(fileId)
          const replacements = await urlReplacements(source, fileId)
          const visitor = urlVisitor(replacements)
          const { code, exports: cssExports } = transform({
            filename: fileId,
            code: source,
            cssModules: { pattern: '[hash]_[local]' },
            minify: true,
            errorRecovery: true,
            ...(visitor === undefined ? {} : { visitor }),
          })
          const classMap = {}
          for (const [local, entry] of Object.entries(cssExports ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
            classMap[local] = entry.name
          }
          styles.set(virtualId, { path: stylesheetKey(fileId), css: code.toString() })
          return { code: `export default ${JSON.stringify(classMap)};`, moduleSideEffects: true }
        },
      },
      {
        name: 'dsh-css-text-inline',
        resolveId: {
          order: 'pre',
          handler(source, importer) {
            if (!source.endsWith(`.css${INLINE_QUERY}`)) return null
            const file = source.slice(0, -INLINE_QUERY.length)
            return INLINE_PREFIX + resolveStylesheet(file, importer) + VIRTUAL_SUFFIX
          },
        },
        async load(virtualId) {
          if (!virtualId.startsWith(INLINE_PREFIX)) return null
          const fileId = virtualId.slice(INLINE_PREFIX.length, -VIRTUAL_SUFFIX.length)
          const source = await readFile(fileId)
          const replacements = await urlReplacements(source, fileId)
          const visitor = urlVisitor(replacements)
          const { code } = transform({
            filename: fileId,
            code: source,
            minify: true,
            errorRecovery: true,
            ...(visitor === undefined ? {} : { visitor }),
          })
          return `export default ${JSON.stringify(code.toString())};`
        },
      },
      {
        name: 'dsh-css-global-meta',
        resolveId: {
          order: 'pre',
          handler(source, importer) {
            if (!source.endsWith('.css') || source.endsWith('.module.css')) return null
            return GLOBAL_PREFIX + resolveStylesheet(source, importer) + VIRTUAL_SUFFIX
          },
        },
        async load(virtualId) {
          if (!virtualId.startsWith(GLOBAL_PREFIX)) return null
          const fileId = virtualId.slice(GLOBAL_PREFIX.length, -VIRTUAL_SUFFIX.length)
          const source = await readFile(fileId)
          const replacements = await urlReplacements(source, fileId)
          const visitor = urlVisitor(replacements)
          const { code } = transform({
            filename: fileId,
            code: source,
            minify: true,
            errorRecovery: true,
            ...(visitor === undefined ? {} : { visitor }),
          })
          styles.set(virtualId, { path: stylesheetKey(fileId), css: code.toString() })
          return { code: 'export {};', moduleSideEffects: true }
        },
      },
    ],
  })

  try {
    const { output } = await build.generate({
      format: 'cjs',
      codeSplitting: false,
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    })
    const chunk = output.find(item => item.type === 'chunk')
    if (chunk === undefined || chunk.type !== 'chunk') {
      throw new Error(`[build-client] rolldown produced no chunk for ${PLUGIN_ID}`)
    }
    const resources = new Map()
    for (const moduleId of Object.keys(chunk.modules)) {
      const style = styles.get(moduleId)
      if (style !== undefined) resources.set(style.path, style)
    }
    const entries = [...resources.values()]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map(style => `${JSON.stringify(style.path)}: { text: (context) => ${JSON.stringify(style.css)} }`)
      .join(',')
    const metaSnippet = entries.length === 0 ? '' : `, meta: () => ({ stylesheets: {${entries}} })`
    const finalCode = `${chunk.code}\nreturn module.exports; }${metaSnippet} });\n`
    await mkdir(dirname(OUT_FILE), { recursive: true })
    await writeFile(OUT_FILE, finalCode, 'utf8')
    console.log(`[build-client] 已生成 lib/client.js（${resources.size} 份样式表已挂入 meta().stylesheets）`)
  } finally {
    await build.close()
  }
}

await buildClient()
