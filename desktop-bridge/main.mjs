import { start as startBridge, stop } from './plugin-browser-bridge.js'

/** DSH Desktop main extension. The host owns startup and shutdown. */
export function start(api) {
  startBridge(api)
  return stop
}
