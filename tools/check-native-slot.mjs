import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, copyFile, writeFile, readFile, symlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

const root = resolve(import.meta.dirname, '..')
const source = process.env.DSH_SOURCE_ROOT
const archive = process.env.DSH_BROWSER_TEST_ARCHIVE
const evidence = process.env.NATIVE_SLOT_EVIDENCE
const host = process.env.NATIVE_SLOT_HOST
if (!source || !archive || !evidence || !host) throw new Error('Set DSH_SOURCE_ROOT, DSH_BROWSER_TEST_ARCHIVE, NATIVE_SLOT_HOST and NATIVE_SLOT_EVIDENCE')
await mkdir(evidence, { recursive: true })
await mkdir(resolve(evidence, 'plugin'), { recursive: true })
execFileSync('tar', ['-xf', archive, '--strip-components=1', '-C', resolve(evidence, 'plugin')])
await symlink(resolve(root, 'node_modules'), resolve(evidence, 'plugin/node_modules'), 'dir').catch(error => { if (error.code !== 'EEXIST') throw error })
for (const name of ['main.js', 'preload-app.cjs']) {
  await copyFile(resolve(host, name), resolve(evidence, name))
}
await writeFile(resolve(evidence, 'client.js'), process.env.NATIVE_SLOT_CLIENT
  ? await readFile(process.env.NATIVE_SLOT_CLIENT)
  : gunzipSync(await readFile(resolve(root, 'tests/fixtures/dsh-host-patch/client.after.js.gz'))))
const require = createRequire(resolve(root, 'package.json'))
const clientRequire = createRequire(resolve(source, 'packages/client/ui-sidebar-right/package.json'))
const { build } = await import(require.resolve('tsdown'))
const { clientBundle } = await import(pathToFileURL(resolve(process.env.DSH_RELEASE_SOURCE ?? source, 'packages/client/tsdown.client.ts')))
const configs = await clientBundle(root, [])({ env: {} })
const cssPlugins = configs.find(config => config.name?.endsWith('/client')).plugins.filter(plugin => plugin.name?.startsWith('dsh-css-'))
await build({ config: false, entry: { renderer: resolve(root, 'tools/fixtures/native-slot-renderer.ts') },
  platform: 'browser', format: 'iife', target: 'chrome130', outDir: evidence, clean: false,
  deps: { alwaysBundle: [/.*/], onlyBundle: false }, plugins: cssPlugins, tsconfig: resolve(source, 'tsconfig.base.json'),
  alias: Object.fromEntries(['react/jsx-runtime', 'react-dom/client', 'react-dom', 'react'].map(id => [id, clientRequire.resolve(id)])),
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"MODE":"production"}' },
  outputOptions: { entryFileNames: 'renderer.js' },
})
await new Promise((resolvePromise, reject) => {
  const child = spawn('dbus-run-session', ['--', 'xvfb-run', '-a',
    `${source}/apps/desktop/node_modules/electron/dist/electron`, '--no-sandbox', '--force-device-scale-factor=1.25',
    fileURLToPath(new URL('./fixtures/native-slot-acceptance.cjs', import.meta.url))], {
    stdio: 'inherit', env: { ...process.env, NATIVE_SLOT_NODE: process.execPath, DSH_HOME: resolve(evidence, 'home') },
  })
  child.once('error', reject)
  child.once('exit', code => code === 0 ? resolvePromise() : reject(new Error(`Scaled native Electron exit ${code}`)))
})
