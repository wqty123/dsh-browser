import { start as startBridge, stop } from './plugin-browser-bridge.js'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

/** DSH Desktop main extension. The host owns startup and shutdown. */
export function start(api) {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const build = createHash('sha256').update(readFileSync(new URL('./plugin-browser-bridge.js', import.meta.url))).digest('hex')
  startBridge({ ...api, bridgeVersion: version, bridgeBuild: build })
  return stop
}
