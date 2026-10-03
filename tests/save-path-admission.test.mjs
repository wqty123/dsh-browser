// Save-path admission (issue #13): browser_screenshot must go through the SAME
// gate as browser_download — absolute, inside downloadDir, never an existing
// file — and the default download directory must honor localized names.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ElectronBrowserProvider } from '../lib/browser-electron/provider.js'

/** The bytes the fake capture returns, so a written file can be verified. */
const IMAGE_BYTES = 'fake-png-bytes'
const IMAGE_BASE64 = Buffer.from(IMAGE_BYTES).toString('base64')

/**
 * Minimal host stub: one view per createView() whose capture() returns a fixed
 * image and whose download() is a no-op (admission is what these tests cover,
 * not the transfer).
 */
function makeHost() {
  let counter = 0
  return {
    createView() {
      return {
        id: `view${++counter}`,
        async sendCommand(method) {
          if (method === 'Runtime.evaluate') return { result: { value: 'about:blank' } }
          return {}
        },
        async download() {},
        async capture() { return { base64: IMAGE_BASE64, mime: 'image/png' } },
      }
    },
    destroyView() {},
    showView() {},
    groupView() {},
    onUserAction() {},
  }
}

test('screenshot savePath is confined to downloadDir and must be absolute', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-shot-gate-'))
  const p = new ElectronBrowserProvider(makeHost(), { downloadDir: dir })
  const sid = await p.open()

  // Outside the admitted directory: the pre-fix behavior wrote to any path the
  // process could reach (the reported sandbox escape).
  await assert.rejects(
    () => p.screenshot(sid, { savePath: join(tmpdir(), 'dsh-outside-shot.png') }),
    /must be inside downloadDir/,
  )
  // Relative path.
  await assert.rejects(
    () => p.screenshot(sid, { savePath: 'relative.png' }),
    /must be an absolute path/,
  )
  // ..-escape out of the admitted directory.
  await assert.rejects(
    () => p.screenshot(sid, { savePath: join(dir, '..', 'dsh-escape-shot.png') }),
    /must be inside downloadDir/,
  )
  await p.close(sid)
})

test('screenshot writes inside downloadDir and never overwrites an existing file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-shot-write-'))
  const p = new ElectronBrowserProvider(makeHost(), { downloadDir: dir })
  const sid = await p.open()
  const target = join(dir, 'shot.png')

  const first = await p.screenshot(sid, { savePath: target })
  assert.equal(first.path, target)
  assert.equal(readFileSync(target, 'utf8'), IMAGE_BYTES)

  // A second capture onto the same path must fail loudly and leave the file alone.
  await assert.rejects(
    () => p.screenshot(sid, { savePath: target }),
    /refusing to overwrite existing file/,
  )
  assert.equal(readFileSync(target, 'utf8'), IMAGE_BYTES, 'existing content untouched')
  await p.close(sid)
})

test('download uses the same gate: it refuses to overwrite an existing file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-dl-gate-'))
  const p = new ElectronBrowserProvider(makeHost(), { downloadDir: dir })
  const sid = await p.open()
  const target = join(dir, 'file.bin')

  const first = await p.download(sid, { url: 'https://a.example/f', savePath: target })
  assert.equal(first.path, target)

  writeFileSync(target, 'keep-me')
  await assert.rejects(
    () => p.download(sid, { url: 'https://a.example/f', savePath: target }),
    /refusing to overwrite existing file/,
  )
  assert.equal(readFileSync(target, 'utf8'), 'keep-me', 'existing content untouched')
  await p.close(sid)
})

test('a localized (Chinese) download directory works, explicitly and via XDG_DOWNLOAD_DIR', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-zh-'))
  const zhDir = join(base, '下载')
  mkdirSync(zhDir)

  // Explicit config: a Chinese path is a normal admitted directory.
  const p = new ElectronBrowserProvider(makeHost(), { downloadDir: zhDir })
  const sid = await p.open()
  const target = join(zhDir, '截图.png')
  const shot = await p.screenshot(sid, { savePath: target })
  assert.equal(shot.path, target)
  assert.equal(readFileSync(target, 'utf8'), IMAGE_BYTES)
  await p.close(sid)

  // No explicit config: an existing XDG_DOWNLOAD_DIR becomes the default, and
  // the containment rule still applies to it.
  const previous = process.env.XDG_DOWNLOAD_DIR
  process.env.XDG_DOWNLOAD_DIR = zhDir
  try {
    const p2 = new ElectronBrowserProvider(makeHost())
    const sid2 = await p2.open()
    const xdgTarget = join(zhDir, 'xdg.png')
    const xdgShot = await p2.screenshot(sid2, { savePath: xdgTarget })
    assert.equal(xdgShot.path, xdgTarget)
    await assert.rejects(
      () => p2.screenshot(sid2, { savePath: join(base, 'nope.png') }),
      /must be inside downloadDir/,
    )
    await p2.close(sid2)
  } finally {
    if (previous === undefined) delete process.env.XDG_DOWNLOAD_DIR
    else process.env.XDG_DOWNLOAD_DIR = previous
  }
})

// The containment check was TEXTUAL, and a symlink is exactly what a textual check
// cannot see: `resolve()` normalizes `..` but never follows a link, so a link inside
// the directory that pointed outside it passed every test the gate had and the write
// landed outside. (M5's residue — the download sandbox resolved no real paths.)
test('a link inside downloadDir cannot be used to write outside it', async t => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-link-'))
  const dir = join(base, 'dl')
  const outside = join(base, 'outside')
  mkdirSync(dir)
  mkdirSync(outside)
  const link = join(dir, 'out')
  try {
    // A junction on Windows needs no privilege (a file symlink does, and requiring one
    // would make this skip on every default install); POSIX ignores the type argument.
    symlinkSync(outside, link, 'junction')
  } catch (error) {
    // Saying "skipped" is honest. Passing as though the case ran is not.
    t.skip(`this environment cannot create a link: ${error.message}`)
    return
  }

  const p = new ElectronBrowserProvider(makeHost(), { downloadDir: dir })
  const sid = await p.open()
  await assert.rejects(
    () => p.screenshot(sid, { savePath: join(link, 'escaped.png') }),
    /resolves outside downloadDir/,
  )
  assert.equal(existsSync(join(outside, 'escaped.png')), false, 'nothing was written through the link')
  await p.close(sid)
})

// `existsSync` follows links, so a DANGLING one read as "this name is free" — and the
// write then created the link's target, outside the admitted directory whenever the
// link pointed out of it. The directory entry is what has to be free, not its target.
test('a dangling link is refused rather than followed out of the directory', async t => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-dangling-'))
  const dir = join(base, 'dl')
  mkdirSync(dir)
  const target = join(base, 'never-written.png')
  const link = join(dir, 'shot.png')
  try {
    symlinkSync(target, link, 'file')
  } catch (error) {
    // Needs SeCreateSymbolicLinkPrivilege on Windows (developer mode or an elevated
    // shell); Linux and macOS allow it for any user.
    t.skip(`this environment cannot create a file symlink: ${error.message}`)
    return
  }

  const p = new ElectronBrowserProvider(makeHost(), { downloadDir: dir })
  const sid = await p.open()
  await assert.rejects(
    () => p.screenshot(sid, { savePath: link }),
    /refusing to overwrite existing file/,
  )
  assert.equal(existsSync(target), false, 'the link target was not created')
  await p.close(sid)
})
