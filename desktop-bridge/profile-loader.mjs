import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const profile = join(home, 'profiles', 'desktop')
let entry
try {
  const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  if (!Object.hasOwn(manifest.dependencies ?? {}, 'dsh-builtin-browser')) throw new Error('not a direct profile dependency')
  const directory = realpathSync(join(profile, 'node_modules', 'dsh-builtin-browser'))
  entry = realpathSync(join(directory, 'desktop-bridge', 'plugin-browser-bridge.js'))
  const child = relative(directory, entry)
  if (!child || isAbsolute(child) || child === '..' || child.startsWith('../') || child.startsWith('..\\')) {
    throw new Error('bridge entry resolves outside its package')
  }
} catch (cause) {
  throw Object.assign(new Error('The installed desktop profile browser bridge is unavailable', { cause }), {
    name: 'DSH_BRIDGE_PACKAGE_UNAVAILABLE', code: 'DSH_BRIDGE_PACKAGE_UNAVAILABLE',
  })
}

const bridge = await import(pathToFileURL(entry).href)
export const start = bridge.start
export const stop = bridge.stop
