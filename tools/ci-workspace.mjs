#!/usr/bin/env node
// CI-only: assemble a minimal pnpm workspace around this package so `scripts/build.mjs` runs the same
// tsdown + `@local/tsdown-plugin-cordis` chain as the dsh-plugin monorepo, without that monorepo.
//
//   node tools/ci-workspace.mjs <dsh-plugin checkout> <workspace dir>
//
// The checkout is the public morlay/dsh-plugin at a pinned commit. Only the build plugin and its two
// workspace dependencies are copied (their devDependencies on upstream workspace packages are
// test-only and dropped). `workspace:^` SDK ranges resolve to the published DSH release in
// DSH_VERSION, the line the package is verified against. Nothing is published from this workspace.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [pluginRepo, workspace] = process.argv.slice(2).map(path => resolve(path))
if (!pluginRepo || !workspace) {
  console.error('usage: node tools/ci-workspace.mjs <dsh-plugin checkout> <workspace dir>')
  process.exit(2)
}

const DSH_VERSION = process.env.DSH_VERSION ?? '0.2.2-rc.3'
// Not versioned with the DSH packages: the ranges @deepseek-ai/dsh-tools of each DSH line declares.
const OWN_RANGES_BY_LINE = {
  '0.2.2': { '@deepseek-ai/cordis': '~4.1.0', '@deepseek-ai/schemastery': '~3.19.0' },
  '0.2.3': { '@deepseek-ai/cordis': '~4.2.0-alpha.1', '@deepseek-ai/schemastery': '~3.20.0-alpha.1' },
}
const OWN_RANGES = OWN_RANGES_BY_LINE[DSH_VERSION.split('-')[0]]
if (!OWN_RANGES) {
  console.error(`[ci-workspace] no cordis/schemastery ranges known for DSH ${DSH_VERSION}`)
  process.exit(2)
}

const self = dirname(dirname(fileURLToPath(import.meta.url)))
const readJson = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)

mkdirSync(workspace, { recursive: true })

for (const local of ['devpackages/tsdown-plugin-cordis', 'devpackages/dts-prepare', 'packages/tooling/dsh-cordis-assets']) {
  const target = join(workspace, local)
  cpSync(join(pluginRepo, local), target, { recursive: true, filter: source => !source.includes('__tests__') })
  const manifest = readJson(join(target, 'package.json'))
  for (const [name, range] of Object.entries(manifest.devDependencies ?? {})) {
    if (range.startsWith('workspace:')) delete manifest.devDependencies[name]
  }
  writeJson(join(target, 'package.json'), manifest)
}
// The declaration pass (`@local/dts-prepare`) extends the monorepo's shared tsconfig.
mkdirSync(join(workspace, 'devpackages/devkit'), { recursive: true })
cpSync(join(pluginRepo, 'devpackages/devkit/tsconfig.json'), join(workspace, 'devpackages/devkit/tsconfig.json'))

const root = readJson(join(pluginRepo, 'package.json'))
const pick = names => Object.fromEntries(names.map(name => [name, root.devDependencies[name]]))
const ROOT_DEV_DEPENDENCIES = {
  '@local/dts-prepare': 'workspace:*',
  '@local/tsdown-plugin-cordis': 'workspace:*',
  ...pick(['@types/node', '@types/react', '@types/react-dom', 'react', 'react-dom', 'rolldown', 'tsdown', 'typescript']),
  tsx: '^4.20.0',
}
writeJson(join(workspace, 'package.json'), {
  name: 'dsh-browser-ci',
  private: true,
  type: 'module',
  packageManager: 'pnpm@11.7.0',
  devDependencies: ROOT_DEV_DEPENDENCIES,
})

const pkgDir = join(workspace, 'packages/web', basename(self))
cpSync(self, pkgDir, {
  recursive: true,
  filter: source => !/[\\/](\.git|node_modules|lib|dist|target)$/.test(source.slice(self.length)),
})
const manifest = readJson(join(pkgDir, 'package.json'))
// Peers keep their `workspace:^` (the manifest tests read it); a published devDependency satisfies
// each one, as the host checkout does in the monorepo.
for (const field of ['dependencies', 'devDependencies']) {
  for (const [name, range] of Object.entries(manifest[field] ?? {})) {
    if (range.startsWith('workspace:')) manifest[field][name] = OWN_RANGES[name] ?? DSH_VERSION
  }
}
for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
  if (range.startsWith('workspace:')) {
    manifest.devDependencies = { ...manifest.devDependencies, [name]: OWN_RANGES[name] ?? DSH_VERSION }
  }
}
// The pack tests stage a copy of the package beside its own node_modules, so the build tools the
// monorepo root provides must be linked there too.
for (const tool of ['@local/tsdown-plugin-cordis', 'rolldown', 'tsdown', 'tsx']) {
  manifest.devDependencies[tool] = ROOT_DEV_DEPENDENCIES[tool]
}
writeJson(join(pkgDir, 'package.json'), manifest)

// The monorepo's version pins (its `overrides`), minus links into its vendored upstream checkout.
const overrides = Object.entries(readWorkspaceOverrides(join(pluginRepo, 'pnpm-workspace.yaml')))
  .filter(([, version]) => !version.startsWith('link:'))
  .map(([name, version]) => `  ${JSON.stringify(name)}: ${JSON.stringify(version)}`)
writeFileSync(join(workspace, 'pnpm-workspace.yaml'), [
  'packages:',
  '  - devpackages/*',
  '  - packages/*/*',
  'linkWorkspacePackages: true',
  'autoInstallPeers: true',
  // Published DSH packages that import what they list only as devDependencies (bundled in DSH).
  'packageExtensions:',
  '  "@deepseek-ai/dsh-client-store":',
  '    dependencies:',
  '      zustand: "~4.5.7"',
  '      immer: "^10.1.1"',
  'allowBuilds:',
  '  electron: false',
  '  esbuild: true',
  'overrides:',
  ...overrides,
  '',
].join('\n'))
/**
 * The flat `overrides:` map of a pnpm-workspace.yaml (quoted or bare keys and values).
 * @param path - the workspace file.
 * @returns package name → version.
 */
function readWorkspaceOverrides(path) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  const start = lines.indexOf('overrides:')
  const entries = {}
  for (const line of start < 0 ? [] : lines.slice(start + 1)) {
    if (/^\s+#/.test(line)) continue
    const match = /^\s+("?)([^"]+)\1:\s*"?([^"#]+?)"?\s*$/.exec(line)
    if (!match) break
    entries[match[2]] = match[3]
  }
  return entries
}

console.log(`[ci-workspace] ${pkgDir} (DSH ${DSH_VERSION}, build plugin from ${pluginRepo})`)
