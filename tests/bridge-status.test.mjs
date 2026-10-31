// The bridge status the settings panel shows (issue #36, recommendation B).
//
// The report's point: when the bridge is missing the plugin only logs a warning, so a user on
// `channel: sidebar` sees "another window opened again" and cannot connect that with "the bridge is
// not installed". Worse is the state after a desktop update — the archive is restored, our patch is
// still in the unpacked tree, the shell loads the archive, and everything LOOKS installed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { findDesktopInstall, readBridgeStatus } from '../lib/browser-electron/bridge-status.js'
import { handleBridgeStatus, BRIDGE_STATUS_ROUTE } from '../lib/browser-electron/preview-route.js'

const MARKER = '// dsh-builtin-browser: hand the plugin a way to drive the sidebar'

/** An install tree with the pieces a given state needs. */
function makeInstall({ archive = false, patched = false, backup = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bridge-status-'))
  const lib = join(root, 'resources', 'app', 'lib')
  mkdirSync(lib, { recursive: true })
  const body = `${patched ? `${MARKER} pages.\n` : ''}const app = {};\n\nexport {};\n`
  writeFileSync(join(lib, 'main.js'), body)
  if (backup) writeFileSync(join(lib, 'main.js.before-bridge'), 'const app = {};\n\nexport {};\n')
  if (archive) writeFileSync(join(root, 'resources', 'app.asar'), 'not really an archive')
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
  const root = makeInstall({ patched: false })
  try {
    const status = readBridgeStatus(root)
    assert.ok(typeof status.command === 'string' && status.command !== '', 'a command is offered')
    assert.match(status.command, /install\.mjs/, 'it names the installer')
    assert.ok(status.command.includes(`"${root}"`), 'and quotes the path, which may contain spaces')
    assert.match(status.command, /--restart/, 'and asks for the close-install-restart flow')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the install is found by shape, under either product name', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-lad-status-'))
  try {
    const roots = {
      'DSH Desktop': join(base, 'Programs', 'DSH Desktop'),
      'DeepSeek Harness': join(base, 'Programs', 'DeepSeek Harness'),
      'Some Other Name': join(base, 'Programs', 'Some Other Name'),
    }
    for (const [name, root] of Object.entries(roots)) {
      mkdirSync(join(root, 'resources', 'app', 'lib'), { recursive: true })
      writeFileSync(join(root, 'resources', 'app', 'lib', 'main.js'), 'const app = {};\n\nexport {};\n')
      assert.equal(findDesktopInstall(base), root, `${name} is found`)
      // Remove it again so the next candidate is the one that matches.
      rmSync(root, { recursive: true, force: true })
    }
    assert.equal(findDesktopInstall(base), undefined, 'and nothing matches when nothing is there')
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

    const ok = response()
    await handleBridgeStatus(request(), ok, base)
    assert.equal(ok.recorded.status, 200)
    const payload = JSON.parse(String(ok.recorded.body))
    assert.equal(payload.ok, true)
    assert.equal(payload.bridge.state, 'installed')

    const foreign = response()
    await handleBridgeStatus(request('GET', 'https://evil.example'), foreign, base)
    assert.equal(foreign.recorded.status, 403, 'a foreign origin learns nothing')

    const wrongMethod = response()
    await handleBridgeStatus(request('POST'), wrongMethod, base)
    assert.equal(wrongMethod.recorded.status, 405)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('no install at all is a state, not an error', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-lad-empty-'))
  try {
    const res = response()
    await handleBridgeStatus(request(), res, base)
    assert.equal(res.recorded.status, 200, 'the panel still gets an answer')
    const payload = JSON.parse(String(res.recorded.body))
    assert.equal(payload.bridge.state, 'missing')
    assert.equal(payload.bridge.present, false)
    assert.match(payload.bridge.detail, /no DSH Desktop install/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
