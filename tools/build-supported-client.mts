import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const source = process.env.DSH_SOURCE_ROOT
if (!source) throw new Error('Set DSH_SOURCE_ROOT to the supported rc.3/rc.5 DSH source checkout')
const preset = resolve(source, 'packages/client/tsdown.client.ts')
if (!(await readFile(preset, 'utf8')).includes('tag.dataset.pluginCss')) {
  throw new Error('This DSH preset does not install factory-owned CSS supported by rc.3/rc.5; use the release source checkout')
}
const require = createRequire(resolve(source, 'package.json'))
const { build } = await import(pathToFileURL(require.resolve('tsdown')).href)
const { clientBundle } = await import(pathToFileURL(preset).href)
const directory = resolve(import.meta.dirname, '..')
const configs = await clientBundle(directory, [])({ env: {} })
const client = configs.find((config: { name?: string }) => config.name?.endsWith('/client'))
if (!client) throw new Error('No client bundle configuration')
await build({ ...client, config: false, cwd: directory, outDir: 'dist',
  outputOptions: { ...client.outputOptions, entryFileNames: 'client.cjs' } })
