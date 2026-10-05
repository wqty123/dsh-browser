/**
 * Install or upgrade dsh-builtin-browser in the web profile — the whole procedure,
 * in the order that keeps the profile healthy.
 *
 * WHY THIS EXISTS
 * A non-frozen `pnpm install` in profiles/web re-resolves the dependency graph, and
 * as a side effect it prunes the nested `node_modules` of packages the profile links
 * to (via `link:`) and materializes the farm's `@deepseek-ai/dsh-tools` as a real
 * registry directory. That breaks module resolution for the plugins that share it:
 * 156 `ERR_MODULE_NOT_FOUND` for cordis, 12 "failed to import", 9 "waiting for
 * services", and the whole startup is judged failed. It has happened four times, and
 * one of those times was an install run to ship 0.3.0 — the trigger is the install
 * itself, not carelessness.
 *
 * So the repair is not optional advice, it is step 3 of every install. Running this
 * script instead of `pnpm install` is what makes that structural rather than
 * something somebody has to remember.
 *
 * WHAT IT DOES
 *   1. snapshot the current pin, then set profiles/web/package.json to the version;
 *   2. pnpm install in profiles/web (not frozen — it has to edit the lockfile);
 *   3. immediately run repair-web-profile.mjs --apply;
 *   4. verify: the repaired junctions are present and the doctor reports healthy.
 *
 * USAGE
 *   node install-web-plugin.mjs 0.3.1
 *   node install-web-plugin.mjs            # reinstall whatever is currently pinned
 *   node install-web-plugin.mjs --verify   # check only, change nothing
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'
import path from 'node:path'

/**
 * Where the DSH home is.
 *
 * Same default DSH itself uses, so this works on a machine it has never seen: an
 * explicit `DSH_HOME`, else `~/.dsh`. Nothing here is tied to the machine this was
 * written on.
 */
const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
/**
 * The deepseek-harness checkout.
 *
 * It has no conventional location — it is wherever the user cloned it — so this is
 * never guessed. Everything that needs it says so plainly instead of silently
 * looking in the wrong place.
 */
const HARNESS = process.env.DSH_HARNESS
if (HARNESS === undefined || HARNESS === '') {
  console.error('set DSH_HARNESS to your deepseek-harness checkout (this script needs the repo\'s node_modules layout)')
  process.exit(1)
}
/**
 * Which profile to install into.
 *
 * This used to be the literal `profiles/web`, so the desktop profile was not merely
 * unsupported — it was invisible, and installing there produced a plugin that could not
 * load. The failure is silent and misdiagnoses easily: the package is linked and listed in
 * `dsh.profile.bundles`, so everything LOOKS installed, but its five peerDependencies are
 * absent from a profile that lives outside the desktop install's resolution chain. Node
 * cannot find them, the loader's import fails, the entry ends up with no fiber, and the
 * client-module scan skips it — taking the tools AND the settings panel with it (see
 * `dsh-client-modules/lib/index.js`, the `entry.fiber === void 0` check).
 * @returns the profile name, from `--profile` or `DSH_PROFILE`, defaulting to `web`.
 */
const PROFILE_NAME = (() => {
  const flag = process.argv.indexOf('--profile')
  if (flag !== -1 && process.argv[flag + 1] !== undefined) return process.argv[flag + 1]
  return process.env.DSH_PROFILE ?? 'web'
})()
const PROFILE = join(HOME, 'profiles', PROFILE_NAME)
const PACKAGE = join(PROFILE, 'package.json')
const PLUGIN = 'dsh-builtin-browser'
/**
 * The five packages the plugin declares as peerDependencies.
 *
 * A peer is the host's to provide, and `dsh web` provides them because its profile links the
 * harness checkout. The desktop ships its own copies inside `resources/app/dsh/node_modules`
 * instead, and a profile at `$DSH_HOME/profiles/desktop` sits OUTSIDE that tree — so the
 * lookup never reaches them. Linking the shipped copies is what the web profile does in
 * effect, and it is what makes the desktop profile resolvable.
 */
const PEERS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/schemastery',
]
/**
 * Where the desktop keeps the copies of those peers, when it is the selected profile.
 * Discovered rather than assumed: the install can live under LOCALAPPDATA or be given
 * outright, and a wrong guess here is worse than none.
 * @returns the `node_modules` directory holding the peers, or undefined.
 */
function desktopPeerRoot() {
  const candidates = []
  if (process.env.DSH_DESKTOP_APP !== undefined && process.env.DSH_DESKTOP_APP !== '') {
    candidates.push(join(process.env.DSH_DESKTOP_APP, 'node_modules'))
  }
  const local = process.env.LOCALAPPDATA
  if (local !== undefined && local !== '') {
    candidates.push(join(local, 'Programs', 'DeepSeek Harness', 'resources', 'app', 'dsh', 'node_modules'))
  }
  for (const candidate of candidates) {
    if (PEERS.every(peer => existsSync(join(candidate, peer)))) return candidate
  }
  return undefined
}
const HERE = import.meta.dirname
/**
 * Where the repair tool lives.
 *
 * It is a separate, environment-specific script rather than part of this package, so
 * this script looks for it in the places it has actually been kept: beside this file,
 * beside the harness checkout, and one level up. `DSH_REPAIR_TOOL` overrides the
 * search when it lives somewhere else entirely — and if none of them exist, the
 * failure says so rather than pretending the profile is fine.
 */
function findRepairTool() {
  const candidates = [
    process.env.DSH_REPAIR_TOOL,
    join(HERE, 'repair-web-profile.mjs'),
    join(HARNESS, 'scripts', 'repair-web-profile.mjs'),
    join(HERE, '..', 'repair-web-profile.mjs'),
  ].filter(candidate => typeof candidate === 'string' && candidate !== '')
  return candidates.find(candidate => existsSync(candidate))
}

/**
 * What must hold for the profile to resolve modules correctly.
 *
 * The repo's own nested `node_modules` is a REAL directory — it is the one that
 * holds junctions of its own; requiring a junction there would be wrong. What must
 * never happen is the farm's `dsh-tools` turning into a registry copy: that is the
 * one pnpm materializes, and the one four plugins break on.
 */
const CHECKS = [
  { path: join(HARNESS, 'packages', 'core', 'tools', 'node_modules'), expect: 'directory' },
  { path: join(HOME, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools'), expect: 'junction' },
]

const args = process.argv.slice(2)
const verifyOnly = args.includes('--verify')
const version = args.find(arg => !arg.startsWith('--'))

/** Run a command, streaming nothing but failing loudly. */
/**
 * Resolve a command the way a shell would.
 *
 * `execFileSync('pnpm', …)` fails with ENOENT on Windows whenever pnpm is a `.cmd` shim or an
 * extensionless sh script — Node's execFile does no PATHEXT resolution and no shim reading, so
 * the step that this whole script exists to perform could not run on the machine it was
 * written for. Probing for a runnable spelling first is what makes it portable; passing
 * `shell: true` unconditionally would also work but would hand every argument to cmd.exe.
 * @param command - the bare command name.
 * @returns the name to actually execute.
 */
function resolveCommand(command) {
  if (process.platform !== 'win32') return command
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  // A bare name that already carries an extension is left alone.
  if (extname(command) !== '') return command
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  return command
}

function run(command, commandArgs, cwd) {
  const resolved = resolveCommand(command)
  console.log(`  $ ${command} ${commandArgs.join(' ')}`)
  // `.cmd`/`.bat` are not executables; they are read by cmd.exe, so they need a shell.
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved)
  execFileSync(resolved, commandArgs, { cwd, stdio: ['ignore', 'inherit', 'inherit'], shell: needsShell })
}

/** Read the profile's pin for this plugin. */
function currentPin() {
  return JSON.parse(readFileSync(PACKAGE, 'utf8')).dependencies?.[PLUGIN]
}

/** What shape is each required path in right now? */
function junctionReport() {
  return CHECKS.map(check => {
    if (!existsSync(check.path)) return { ...check, state: 'missing' }
    const stats = lstatSync(check.path)
    const state = stats.isSymbolicLink() ? 'junction' : 'directory'
    return { ...check, state, ok: state === check.expect }
  })
}

console.log(`web-profile plugin install  (profile: ${PROFILE})`)

// Before anything reads the profile. `currentPin()` reads the profile's package.json, so
// running this against a profile that does not exist — a typo, or `--profile desktop` — used
// to fail with a raw ENOENT stack from JSON.parse, and the friendly "not a dsh web profile"
// message below was unreachable because the throw happened first.
if (!existsSync(join(PROFILE, 'package.json'))) {
  console.error(`  ${PROFILE} is not a dsh web profile (no package.json there).`)
  console.error('  Pass --profile <name>, or install the plugin manually.')
  process.exit(2)
}
console.log(`pin now: ${currentPin()}`)

if (verifyOnly) {
  const report = junctionReport()
  for (const entry of report) console.log(`  ${entry.state.padEnd(15)} ${entry.path}`)
  const broken = report.filter(entry => entry.ok !== true)
  console.log(broken.length === 0 ? 'VERIFY: healthy' : `VERIFY: ${broken.length} broken`)
  process.exit(broken.length === 0 ? 0 : 1)
}

if (!existsSync(PACKAGE)) {
  console.error(`not a dsh web profile (no ${PACKAGE})`)
  process.exit(1)
}

// ---- 1. pin the version -----------------------------------------------------
if (version !== undefined) {
  const pinned = currentPin()
  if (pinned === version) {
    console.log(`step 1: already pinned at ${version}`)
  } else if (typeof pinned === 'string' && pinned.startsWith('link:')) {
    // A `link:` pin is a deliberate source checkout — someone pointed the profile at a working
    // tree on purpose, usually to develop against it. This script installs a PUBLISHED version,
    // and overwriting the link with a plain version number would silently swap that working tree
    // for whatever the registry serves: the one outcome nobody asking for a release expects when
    // their profile is aimed at source. Refusing is the only safe default, and editing
    // package.json by hand is the escape hatch for the cases where the swap IS meant.
    console.error(`refusing to overwrite a link: pin with ${version}`)
    console.error(`  ${PLUGIN} is currently: ${pinned}`)
    console.error('  That is a deliberate checkout of a local working tree. To install the published')
    console.error(`  version instead, edit ${PACKAGE} yourself and remove the link first.`)
    process.exit(1)
  } else {
    copyFileSync(PACKAGE, `${PACKAGE}.bak-before-${version}`)
    const document = JSON.parse(readFileSync(PACKAGE, 'utf8'))
    document.dependencies[PLUGIN] = version
    writeFileSync(PACKAGE, `${JSON.stringify(document, null, 2)}\n`)
    console.log(`step 1: pinned ${version} (backup: ${PACKAGE}.bak-before-${version})`)
  }
} else {
  console.log('step 1: no version given, keeping the current pin')
}

// ---- 1b. peer dependencies, on a profile that cannot reach them ---------------
//
// The plugin declares five peers, which the HOST provides. `dsh web` provides them by
// linking the harness checkout into its profile, so nothing was ever needed here. The
// desktop ships its own copies inside `resources/app/dsh/node_modules` and its profile lives
// outside that tree, so the lookup cannot reach them — and the plugin then fails to load in a
// way that looks like success: it is linked, it is in `dsh.profile.bundles`, and its tools
// and settings panel are simply absent. Linking the shipped copies is what closes it.
if (PROFILE_NAME === 'desktop' && !verifyOnly) {
  const peerRoot = desktopPeerRoot()
  if (peerRoot === undefined) {
    console.error('step 1b: could not find the desktop\'s own copies of the plugin\'s peers.')
    console.error('  Set DSH_DESKTOP_APP to the `dsh` directory inside the desktop install')
    console.error('  (the one containing node_modules), then re-run. Without them the plugin')
    console.error('  will be linked but will not load, and its settings panel will be missing.')
    process.exit(1)
  }
  const document = JSON.parse(readFileSync(PACKAGE, 'utf8'))
  document.dependencies ??= {}
  const linked = []
  for (const peer of PEERS) {
    const spec = `link:${join(peerRoot, peer).replace(/\\/g, '/')}`
    if (document.dependencies[peer] !== spec) {
      document.dependencies[peer] = spec
      linked.push(peer)
    }
  }
  if (linked.length === 0) {
    console.log('step 1b: peer links already in place')
  } else {
    writeFileSync(PACKAGE, `${JSON.stringify(document, null, 2)}\n`)
    console.log(`step 1b: linked ${linked.length} peer(s) from the desktop install`)
    for (const peer of linked) console.log(`  ${peer}`)
  }
} else if (PROFILE_NAME === 'desktop') {
  console.log('step 1b: verify-only, not touching the peer links')
} else {
  console.log(`step 1b: not needed for the ${PROFILE_NAME} profile`)
}

// ---- 2. install -------------------------------------------------------------
  // Resolve the repair tool BEFORE installing. Step 2 is the step that breaks the
  // profile, and this script depends on a repair tool that ships outside this package —
  // so checking afterwards meant the default outcome was to damage the profile and then
  // report that it could not be fixed.
  const repair = findRepairTool()
  if (repair === undefined) {
    console.error('  no repair tool found — refusing to run the install that would break the profile.')
    console.error('  Set DSH_REPAIR_TOOL to repair-web-profile.mjs (it is not part of this package: the')
    console.error('  profile layout it repairs is specific to the machine DSH is installed on).')
    process.exit(1)
  }

console.log('step 2: pnpm install (this is the step that causes the damage)')
run('pnpm', ['install', '--ignore-scripts'], PROFILE)

// ---- 3. repair, immediately -------------------------------------------------
console.log('step 3: repair the profile (never skip this)')
run(process.execPath, [repair, '--apply'], import.meta.dirname)

// ---- 4. verify --------------------------------------------------------------
console.log('step 4: verify')
const report = junctionReport()
for (const entry of report) console.log(`  ${entry.state.padEnd(15)} ${entry.path}`)
const broken = report.filter(entry => entry.ok !== true)
if (broken.length > 0) {
  console.error(`FAILED: ${broken.length} junction(s) still broken after repair`)
  process.exit(1)
}
console.log(`installed: ${currentPin()}`)
console.log('done — restart the web host to load it')
