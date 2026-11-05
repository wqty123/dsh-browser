// The bridge status the settings panel shows (issue #36, recommendation B).
//
// The report's point: when the bridge is missing the plugin only logs a warning, so a user on
// `channel: sidebar` sees "another window opened again" and cannot connect that with "the bridge is
// not installed". Worse is the state after a desktop update — the archive is restored, our patch is
// still in the unpacked tree, the shell loads the archive, and everything LOOKS installed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { findDesktopInstall, readBridgeStatus } from '../lib/browser-electron/bridge-status.js'
import { handleBridgeStatus, BRIDGE_STATUS_ROUTE } from '../lib/browser-electron/preview-route.js'
import { writeAsar } from './fake-asar.mjs'

const MARKER = '// dsh-builtin-browser: hand the plugin a way to drive the sidebar'

/**
 * The registry lookup a fixture wants: none.
 *
 * This change adds custom-install discovery, which reads the machine's uninstall registry. A test
 * that asserts "nothing matches" must not consult the machine it runs on — the developer's own DSH
 * may well be installed somewhere, and the assertion would then depend on whose computer ran it.
 */
const noRegistry = () => []

/**
 * The conventional locations a fixture wants: none.
 *
 * The macOS/Linux counterpart of `noRegistry`, and for the same reason: on those platforms the
 * conventional list is a real source, so a test of "what is under `base`" must close it too.
 */
const noConventions = () => []

/** An install tree with the pieces a given state needs. */
function makeInstall({ archive = false, patched = false, backup = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bridge-status-'))
  const lib = join(root, 'resources', 'app', 'lib')
  mkdirSync(lib, { recursive: true })
  const body = `${patched ? `${MARKER} pages.\n` : ''}const app = {};\n\nexport {};\n`
  writeFileSync(join(lib, 'main.js'), body)
  // Identity (issue #40): the status reader verifies the app's own name before it reports anything,
  // so a fixture without a manifest is not a DSH install any more.
  writeFileSync(join(root, 'resources', 'app', 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-desktop',
    version: '0.2.1-rc.5',
    main: 'lib/main.js',
  }))
  if (backup) writeFileSync(join(lib, 'main.js.before-bridge'), 'const app = {};\n\nexport {};\n')
  if (archive) {
    // A real archive, because identity is read from it when it exists — that is the whole point of
    // the "stale" state: the shell loads the archive and the patched tree beside it is inert.
    writeAsar(join(root, 'resources', 'app.asar'), {
      'package.json': JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: '0.2.1-rc.5', main: 'lib/main.js' }),
      'lib/main.js': 'const app = {};\n\nexport {};\n',
    })
  }
  return root
}

test('a patched tree with no archive is installed', () => {
  const root = makeInstall({ patched: true })
  try {
    const status = readBridgeStatus(root)
    assert.equal(status.state, 'installed')
    assert.equal(status.present, true)
    assert.equal(status.archivePresent, false)
    assert.equal(status.installRoot, root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the state after a desktop update is stale, not installed', () => {
  // The archive is back AND our patch is still in the unpacked tree. The shell loads the archive, so
  // the patch has no effect — this is the case that looks fine and is not.
  const root = makeInstall({ patched: true, archive: true, backup: true })
  try {
    const status = readBridgeStatus(root)
    assert.equal(status.state, 'stale')
    assert.match(status.detail, /update restored it/i)
    assert.equal(typeof status.backupAt, 'string', 'the backup time is reported so a user can date it')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an archive with no patch is missing, because the archive is what loads', () => {
  const root = makeInstall({ archive: true, patched: false })
  try {
    const status = readBridgeStatus(root)
    assert.equal(status.state, 'missing')
    assert.equal(status.archivePresent, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an unpacked tree without the patch is missing', () => {
  const root = makeInstall({ patched: false })
  try {
    assert.equal(readBridgeStatus(root).state, 'missing')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a directory that is not an install reports that, instead of throwing', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-not-an-install-'))
  try {
    const status = readBridgeStatus(root)
    assert.equal(status.state, 'missing')
    assert.equal(status.present, false)
    assert.match(status.detail, /not a DSH Desktop install/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the repair command is offered, quoted, and never executed', () => {
  // Issue #40, fourth item: the command used to be `node desktop-bridge/install.mjs …`, which is a
  // path relative to a source checkout. Anyone who installed the plugin from npm has no such path,
  // so the "hint" sent them to a file that does not exist. It must name THIS package's installer.
  const root = makeInstall({ patched: false })
  try {
    const status = readBridgeStatus(root)
    assert.ok(typeof status.command === 'string' && status.command !== '', 'a command is offered')
    assert.match(status.command, /install\.mjs/, 'it names the installer')
    assert.ok(status.command.includes(`"${root}"`), 'and quotes the path, which may contain spaces')
    assert.match(status.command, /--restart/, 'and asks for the close-install-restart flow')

    const named = /node "([^"]+install\.mjs)"/.exec(status.command)
    assert.ok(named !== null, 'the installer is quoted in full')
    assert.equal(named[1].includes('..'), false, 'an absolute path, not one relative to the reader')
    assert.equal(existsSync(named[1]), true,
      'the file the command names exists on this machine — the whole point of the fix')
    assert.match(named[1], /desktop-bridge[\\/]install\.mjs$/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the install is found by identity, under either product name', () => {
  // Issue #40 changed what discovery may accept: the shape alone used to be enough, and every
  // Electron app has the shape. What the user names the directory still must not matter — the app's
  // own manifest does.
  const base = mkdtempSync(join(tmpdir(), 'dsh-lad-status-'))
  try {
    const roots = {
      'DSH Desktop': join(base, 'Programs', 'DSH Desktop'),
      'DeepSeek Harness': join(base, 'Programs', 'DeepSeek Harness'),
      'Some Other Name': join(base, 'Programs', 'Some Other Name'),
    }
    const manifest = JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: '0.2.1-rc.5', main: 'lib/main.js' })
    for (const [name, root] of Object.entries(roots)) {
      mkdirSync(join(root, 'resources', 'app', 'lib'), { recursive: true })
      writeFileSync(join(root, 'resources', 'app', 'lib', 'main.js'), 'const app = {};\n\nexport {};\n')
      writeFileSync(join(root, 'resources', 'app', 'package.json'), manifest)
      assert.equal(findDesktopInstall(base, noRegistry, noConventions), root, `${name} is found`)
      // Remove it again so the next candidate is the one that matches.
      rmSync(root, { recursive: true, force: true })
    }
    assert.equal(findDesktopInstall(base, noRegistry, noConventions), undefined, 'and nothing matches when nothing is there')

    // The half that used to be wrong: the right shape with the wrong name is NOT an install.
    const impostor = join(base, 'Programs', 'DSH Desktop')
    mkdirSync(join(impostor, 'resources', 'app', 'lib'), { recursive: true })
    writeFileSync(join(impostor, 'resources', 'app', 'lib', 'main.js'), 'const app = {};\n\nexport {};\n')
    writeFileSync(join(impostor, 'resources', 'app', 'package.json'),
      JSON.stringify({ name: 'unrelated-meeting-app', main: 'lib/main.js' }))
    assert.equal(findDesktopInstall(base, noRegistry, noConventions), undefined, 'an Electron app is not DSH Desktop')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

/** A request shaped like the host's. */
function request(method = 'GET', origin = 'http://localhost:3000') {
  const req = Readable.from([])
  req.method = method
  req.headers = { host: 'localhost:3000', origin, referer: `${origin}/` }
  req.url = BRIDGE_STATUS_ROUTE
  return req
}

/** A response that records what was written. */
function response() {
  const recorded = { status: 0, headers: {}, body: undefined }
  return {
    recorded,
    writeHead(status, headers) { recorded.status = status; recorded.headers = headers ?? {} },
    end(body) { recorded.body = body },
  }
}

test('the endpoint answers with the reading, same-origin only', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-lad-endpoint-'))
  try {
    const root = join(base, 'Programs', 'DSH Desktop')
    mkdirSync(join(root, 'resources', 'app', 'lib'), { recursive: true })
    writeFileSync(join(root, 'resources', 'app', 'lib', 'main.js'), `${MARKER} pages.\nconst app = {};\n\nexport {};\n`)
    writeFileSync(join(root, 'resources', 'app', 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: '0.2.1-rc.5', main: 'lib/main.js' }))

    const ok = response()
    await handleBridgeStatus(request(), ok, base, noRegistry, noConventions)
    assert.equal(ok.recorded.status, 200)
    const payload = JSON.parse(String(ok.recorded.body))
    assert.equal(payload.ok, true)
    assert.equal(payload.bridge.state, 'installed')

    const foreign = response()
    await handleBridgeStatus(request('GET', 'https://evil.example'), foreign, base, noRegistry, noConventions)
    assert.equal(foreign.recorded.status, 403, 'a foreign origin learns nothing')

    const wrongMethod = response()
    await handleBridgeStatus(request('POST'), wrongMethod, base, noRegistry, noConventions)
    assert.equal(wrongMethod.recorded.status, 405)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('no install at all is a state, not an error', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-lad-empty-'))
  try {
    const res = response()
    await handleBridgeStatus(request(), res, base, noRegistry, noConventions)
    assert.equal(res.recorded.status, 200, 'the panel still gets an answer')
    const payload = JSON.parse(String(res.recorded.body))
    assert.equal(payload.bridge.state, 'missing')
    assert.equal(payload.bridge.present, false)
    assert.match(payload.bridge.detail, /no DSH Desktop install/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// Issue #40 follow-up: `%LOCALAPPDATA%\Programs` is where the Windows installer puts the app BY DEFAULT, not
// where every install is. A tree moved to another drive is a good DSH Desktop that discovery used
// to miss — and a miss is not cosmetic: the panel shows "no desktop on this machine" and the repair
// command, the one thing that would fix a stale bridge, is never offered. Measured on an install at
// `E:\Applications\DeepSeek Harness` after a stale unpacked directory was cleaned out of `Programs`.

/** Run a body with DSH_DESKTOP_APP set to `value`, restoring the previous answer afterwards. */
function withDesktopApp(value, body) {
  const previous = process.env.DSH_DESKTOP_APP
  if (value === undefined) delete process.env.DSH_DESKTOP_APP
  else process.env.DSH_DESKTOP_APP = value
  try {
    return body()
  } finally {
    if (previous === undefined) delete process.env.DSH_DESKTOP_APP
    else process.env.DSH_DESKTOP_APP = previous
  }
}

/** An install tree at an arbitrary path, with the manifest identity needs. */
function makeInstallAt(root, { patched = true } = {}) {
  mkdirSync(join(root, 'resources', 'app', 'lib'), { recursive: true })
  const body = `${patched ? `${MARKER} pages.\n` : ''}const app = {};\n\nexport {};\n`
  writeFileSync(join(root, 'resources', 'app', 'lib', 'main.js'), body)
  writeFileSync(join(root, 'resources', 'app', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: '0.2.1-rc.5', main: 'lib/main.js' }))
  return root
}

test('an install outside Programs is found through DSH_DESKTOP_APP', () => {
  // The reported case: the app lives on another drive, so nothing under Programs matches. The
  // person can say where it is, and the same identity rule decides whether to believe them.
  const base = mkdtempSync(join(tmpdir(), 'dsh-lad-elsewhere-'))
  try {
    const elsewhere = makeInstallAt(join(base, 'Other Drive', 'DeepSeek Harness'))
    mkdirSync(join(base, 'Programs'), { recursive: true })

    assert.equal(findDesktopInstall(base, noRegistry, noConventions), undefined, 'nothing under Programs is still nothing')
    assert.equal(withDesktopApp(elsewhere, () => findDesktopInstall(base, noRegistry, noConventions)), elsewhere,
      'the declared directory is found')
    assert.equal(withDesktopApp(elsewhere, () => readBridgeStatus(elsewhere).state), 'installed',
      'and it reads as the install it is, so the panel shows a state instead of "no desktop"')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('DSH_DESKTOP_APP is held to the identity rule, like every other candidate', () => {
  // Accepting the declared path on trust would reopen exactly what issue #40 closed: any Electron
  // app, named by the user or by a stale environment, reported as DSH Desktop together with a
  // ready-to-run installer command aimed at it.
  const base = mkdtempSync(join(tmpdir(), 'dsh-lad-impostor-'))
  try {
    mkdirSync(join(base, 'Programs'), { recursive: true })
    const impostor = join(base, 'Unrelated App')
    mkdirSync(join(impostor, 'resources', 'app', 'lib'), { recursive: true })
    writeFileSync(join(impostor, 'resources', 'app', 'lib', 'main.js'), 'const app = {};\n\nexport {};\n')
    writeFileSync(join(impostor, 'resources', 'app', 'package.json'),
      JSON.stringify({ name: 'unrelated-meeting-app', main: 'lib/main.js' }))

    assert.equal(withDesktopApp(impostor, () => findDesktopInstall(base, noRegistry, noConventions)), undefined,
      'a directory that is not DSH Desktop is refused even when declared')
    assert.equal(withDesktopApp(join(base, 'does-not-exist'), () => findDesktopInstall(base, noRegistry, noConventions)), undefined,
      'and a stale declaration is not an error')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('the default Programs install still wins over a declaration', () => {
  // Order matters: the default location must stay authoritative, so a leftover environment
  // variable on a machine that HAS a normal install cannot silently retarget the panel.
  const base = mkdtempSync(join(tmpdir(), 'dsh-lad-precedence-'))
  try {
    const conventional = makeInstallAt(join(base, 'Programs', 'DeepSeek Harness'))
    const elsewhere = makeInstallAt(join(base, 'Other Drive', 'DeepSeek Harness'))
    assert.equal(withDesktopApp(elsewhere, () => findDesktopInstall(base, noRegistry, noConventions)), conventional,
      'the default location wins')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('an install outside Programs is found through the uninstall registry', () => {
  // The half a user does not have to do anything for. The Windows installer records the directory
  // it installed into; reading it back is how a custom install is found with no configuration at
  // all. This is the exact shape measured in the report: nothing under Programs, an install on E:.
  const base = mkdtempSync(join(tmpdir(), 'dsh-lad-registry-'))
  try {
    const elsewhere = makeInstallAt(join(base, 'Other Drive', 'DeepSeek Harness'))
    mkdirSync(join(base, 'Programs'), { recursive: true })
    const registry = () => [elsewhere]
    assert.equal(findDesktopInstall(base, registry, noConventions), elsewhere, 'the recorded location is found')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a registry value that is not an install is ignored, and the others are still tried', () => {
  // Registry values outlive the directories they name — an uninstall that left its key behind, a
  // truncated write, a path from another machine restored from a backup. Each must be skipped
  // rather than trusted, and one bad entry must not stop the search.
  const base = mkdtempSync(join(tmpdir(), 'dsh-lad-stale-registry-'))
  try {
    const real = makeInstallAt(join(base, 'Other Drive', 'DeepSeek Harness'))
    const notAnInstall = join(base, 'leftover')
    mkdirSync(notAnInstall, { recursive: true })
    const registry = () => [join(base, 'gone'), notAnInstall, real]
    assert.equal(findDesktopInstall(base, registry, noConventions), real, 'the first candidate that IS an install wins')
    assert.equal(findDesktopInstall(base, () => [join(base, 'gone'), notAnInstall], noConventions), undefined,
      'and when none of them is one, the answer is still "nothing found"')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a lookup that fails is a state, not a crash', () => {
  // `reg.exe` is a best-effort source: a locked-down machine, a missing tool, a policy-restricted
  // key. Discovery must still answer, and the answer is "no custom install found".
  const base = mkdtempSync(join(tmpdir(), 'dsh-lad-registry-throws-'))
  try {
    mkdirSync(join(base, 'Programs'), { recursive: true })
    const throwing = () => { throw new Error('reg.exe is not available') }
    assert.equal(findDesktopInstall(base, throwing, noConventions), undefined, 'the failure does not escape')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})



test('a macOS install is found inside the app bundle', () => {
  // macOS has no registry and no Programs directory, so the convention IS the record. The part that
  // matters is inside the bundle: <app>.app/Contents/Resources is what Electron reads app.asar
  // from, which is why the candidate list names that directory and not the .app itself.
  const base = mkdtempSync(join(tmpdir(), 'dsh-lad-macos-'))
  try {
    mkdirSync(join(base, 'Programs'), { recursive: true })
    const bundle = join(base, 'Applications', 'DeepSeek Harness.app', 'Contents', 'Resources')
    makeInstallAt(bundle)
    const conventions = () => [bundle]
    assert.equal(findDesktopInstall(base, noRegistry, conventions), bundle,
      'the bundle resources directory is the install root')
    assert.equal(readBridgeStatus(bundle).state, 'installed', 'and it reads as installed')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a Linux install under /opt or ~/.local is found', () => {
  // Linux has no single convention, so the candidate list covers the ways the app actually ships:
  // a tarball in /opt, a distro package under /usr/lib, a per-user extract in ~/.local.
  const base = mkdtempSync(join(tmpdir(), 'dsh-lad-linux-'))
  try {
    mkdirSync(join(base, 'Programs'), { recursive: true })
    const opt = join(base, 'opt', 'DeepSeek Harness')
    makeInstallAt(opt)
    assert.equal(findDesktopInstall(base, noRegistry, () => [join(base, 'opt', 'DSH Desktop'), opt]), opt,
      'the second conventional candidate is tried when the first is absent')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a conventional location is held to the identity rule, like every other candidate', () => {
  // Naming a path is a place to look, never an assumption that something is there. A bundle left
  // behind by an uninstall, or an unrelated app in /opt, must not be reported as DSH Desktop.
  const base = mkdtempSync(join(tmpdir(), 'dsh-lad-conventional-impostor-'))
  try {
    mkdirSync(join(base, 'Programs'), { recursive: true })
    const impostor = join(base, 'opt', 'DeepSeek Harness')
    mkdirSync(join(impostor, 'resources', 'app', 'lib'), { recursive: true })
    writeFileSync(join(impostor, 'resources', 'app', 'lib', 'main.js'), 'const app = {};' + "\n\n" + 'export {};' + "\n")
    writeFileSync(join(impostor, 'resources', 'app', 'package.json'),
      JSON.stringify({ name: 'unrelated-meeting-app', main: 'lib/main.js' }))
    assert.equal(findDesktopInstall(base, noRegistry, () => [impostor]), undefined,
      'an unrelated app in a conventional location is still not DSH Desktop')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a failing conventional lookup is a state, not a crash', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-lad-conventional-throws-'))
  try {
    mkdirSync(join(base, 'Programs'), { recursive: true })
    const throwing = () => { throw new Error('permission denied reading /Applications') }
    assert.equal(findDesktopInstall(base, noRegistry, throwing), undefined,
      'discovery still answers when walking a conventional location fails')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
