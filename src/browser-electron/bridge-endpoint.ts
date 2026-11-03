/**
 * Whether the desktop shell is RUNNING, as opposed to whether its bridge is installed.
 *
 * The two questions are constantly confused, and the confusion is the reason a user on
 * `channel: sidebar` sees "another window opened instead" and cannot tell why:
 *
 * - `bridge-status.ts` reads the INSTALL TREE: does the shell's main entry carry our patch, and is
 *   the archive out of the way. It survives a reboot; it says nothing about a process.
 * - This module reads the ENDPOINT the shell publishes while it runs: a port, a token, a pid and a
 *   refresh stamp. It says nothing about the install tree.
 *
 * "Installed" plus "not running" is the single most common broken state (the desktop app is simply
 * closed), and a readiness report that stops at the install tree calls it ready — then every call
 * dials a port nobody owns. So both readings are taken, and the sidebar carrier is only ready when
 * BOTH are true.
 *
 * Two independent signals, because each alone has a false-positive:
 * - the refresh stamp (the shell rewrites the file every ~15 s, so a stale stamp means a shell that
 *   exited and left its last write behind — a tombstone naming a dead port);
 * - the pid, checked with signal 0 (kills nothing, and works across platforms).
 * @module dsh-browser/browser-electron/bridge-endpoint
 */
import { existsSync, readFileSync, statSync } from 'node:fs'

import { ENDPOINT_STALE_AFTER_MS } from './bridge-connection.js'
import { bridgeEndpointPath } from './desktop-bridge-host.js'

/** What the panel needs to know about the running shell. */
export interface BridgeEndpointState {
  /** Whether a published endpoint file exists at all. */
  readonly present: boolean
  /** Whether the shell behind it looks alive right now: a fresh stamp AND a live pid. */
  readonly alive: boolean
  /** One line, already user-facing. */
  readonly detail: string
  /** When the shell said it last refreshed the file, ISO, when the file carries a stamp. */
  readonly updatedAt?: string
}

/**
 * Whether a pid is alive, without signalling it.
 *
 * Signal 0 performs the permission and existence checks and delivers nothing. `EPERM` means the
 * process exists and belongs to someone else, which is still "alive" for this purpose.
 * @param pid - the process id from the endpoint file.
 * @returns whether that process exists.
 */
function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/**
 * Read the endpoint the shell publishes.
 *
 * Never throws: a settings panel must get an answer even when the file is mid-write, unreadable, or
 * belongs to a shell that exited an hour ago.
 * @param path - the endpoint file; defaults to the one location the shell writes.
 * @param now - the clock, injected so a test can age a stamp without sleeping.
 * @returns what the panel shows.
 */
export function readBridgeEndpoint(
  path: string = bridgeEndpointPath(),
  now: number = Date.now(),
): BridgeEndpointState {
  if (!existsSync(path)) {
    return {
      present: false,
      alive: false,
      detail: 'no desktop shell has published a bridge endpoint',
    }
  }
  let raw: { port?: unknown; token?: unknown; pid?: unknown; updatedAt?: unknown }
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as typeof raw
  } catch (error) {
    return {
      present: true,
      alive: false,
      detail: `the published endpoint is unreadable: ${String(error)}`,
    }
  }
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined
  const pid = typeof raw.pid === 'number' ? raw.pid : undefined

  // A stamp older than the refresh window is a tombstone, not a slow shell (see
  // ENDPOINT_STALE_AFTER_MS). An ABSENT stamp is not expired on purpose: an older bridge never wrote
  // one, and that shell deserves to be checked by its pid instead of being declared gone.
  if (updatedAt !== undefined) {
    const at = Date.parse(updatedAt)
    if (Number.isFinite(at)) {
      const ageMs = now - at
      if (ageMs > ENDPOINT_STALE_AFTER_MS) {
        return {
          present: true,
          alive: false,
          updatedAt,
          detail: `the published endpoint has not been refreshed for ${Math.round(ageMs / 1000)}s, `
            + 'so the shell that wrote it has most likely exited',
        }
      }
    }
  }
  if (pid !== undefined && !pidAlive(pid)) {
    return {
      present: true,
      alive: false,
      ...updatedAt === undefined ? {} : { updatedAt },
      detail: `the shell that published the endpoint (pid ${pid}) is not running`,
    }
  }
  return {
    present: true,
    alive: true,
    ...updatedAt === undefined ? {} : { updatedAt },
    detail: 'a desktop shell is running and answering on its published endpoint',
  }
}

/**
 * The endpoint file's mtime, for diagnostics that want to say "written at".
 *
 * Separate and optional: the readiness report does not need it, and a caller that does can fail
 * without disturbing anything else.
 * @param path - the endpoint file.
 * @returns the mtime as ISO, or undefined.
 */
export function bridgeEndpointWrittenAt(path: string = bridgeEndpointPath()): string | undefined {
  try {
    return statSync(path).mtime.toISOString()
  } catch {
    return undefined
  }
}
