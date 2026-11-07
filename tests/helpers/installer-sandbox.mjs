import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const INSTALLER_TEST_MARKER = '.dsh-bridge-test-root'
export const INSTALLER_TEST_MARKER_BODY = 'dsh-browser-installer-test-root-v1\n'
const closedDesktopPreload = fileURLToPath(new URL('./closed-desktop-preload.cjs', import.meta.url)).replaceAll('\\', '/')

/** Refuse an unmarked or redirected parent rather than inheriting a guessed test boundary. */
export function assertInstallerSandbox(root) {
  if (typeof root !== 'string' || !isAbsolute(root) || lstatSync(root).isSymbolicLink()) {
    throw new Error('installer sandbox must be an absolute, non-linked directory')
  }
  const actual = realpathSync(root)
  const marker = join(actual, INSTALLER_TEST_MARKER)
  if (lstatSync(marker).isSymbolicLink() || readFileSync(marker, 'utf8') !== INSTALLER_TEST_MARKER_BODY) {
    throw new Error('installer sandbox marker is missing or invalid')
  }
  return actual
}

/** A private test boundary that cannot resolve to a user Desktop or DSH home. */
export function createInstallerSandbox() {
  const inherited = process.env.DSH_BRIDGE_TEST_ROOT
  const parent = inherited === undefined ? realpathSync(tmpdir()) : assertInstallerSandbox(inherited)
  const root = mkdtempSync(join(parent, 'dsh-installer-sandbox-'))
  writeFileSync(join(root, INSTALLER_TEST_MARKER), INSTALLER_TEST_MARKER_BODY, { flag: 'wx' })
  const actual = assertInstallerSandbox(root)
  const home = join(actual, 'home')
  mkdirSync(home)
  return {
    root: actual,
    temp(prefix = 'fixture-') {
      if (prefix.includes('/') || prefix.includes('\\')) throw new Error('fixture prefix must be a name')
      return mkdtempSync(join(actual, prefix))
    },
    env(overrides = {}) {
      const nodeOptions = Object.hasOwn(overrides, 'NODE_OPTIONS') ? overrides.NODE_OPTIONS : process.env.NODE_OPTIONS
      return {
        ...process.env, ...overrides,
        NODE_OPTIONS: [nodeOptions, `--require "${closedDesktopPreload}"`].filter(Boolean).join(' '),
        DSH_BROWSER_TEST: '1', DSH_BRIDGE_TEST_ROOT: actual,
        TEMP: actual, TMP: actual, TMPDIR: actual,
        DSH_HOME: join(actual, 'home'),
        DSH_DESKTOP_PATH: overrides.DSH_DESKTOP_PATH ?? join(actual, 'unavailable-desktop'),
      }
    },
    close() {
      const current = assertInstallerSandbox(actual)
      if (dirname(current).toLowerCase() !== parent.toLowerCase()
        || !basename(current).startsWith('dsh-installer-sandbox-')
        || relative(parent, current).startsWith('..') || resolve(current).toLowerCase() === resolve(parent).toLowerCase()) {
        throw new Error('refusing to remove a sandbox outside its created temporary parent')
      }
      rmSync(current, { recursive: true, force: true })
    },
  }
}
