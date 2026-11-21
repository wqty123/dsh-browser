import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

export function packInvocation(packageManager, destination, {
  npmExecpath = process.env.npm_execpath,
  execPath = process.execPath,
  platform = process.platform,
} = {}) {
  const pinned = /^pnpm@(\d+\.\d+\.\d+(?:-[\w.-]+)?)(?:\+sha(?:224|256|384|512)\.[a-f0-9]+)?$/i.exec(packageManager ?? '')
  assert.ok(pinned, 'packageManager must pin a pnpm version')
  const args = ['pack', '--pm-on-fail=ignore', '--pack-destination', destination]
  if (npmExecpath && isAbsolute(npmExecpath) && /\.(?:js|cjs)$/i.test(npmExecpath)) {
    try {
      if (statSync(npmExecpath).isFile()) {
        let directory = dirname(npmExecpath)
        for (;;) {
          try {
            const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
            if (manifest.name === 'pnpm' && manifest.version === pinned[1]) {
              return { command: execPath, args: [npmExecpath, ...args], shell: false }
            }
            break
          } catch (error) { if (error.code !== 'ENOENT') break }
          const parent = dirname(directory)
          if (parent === directory) break
          directory = parent
        }
      }
    } catch {}
  }
  if (platform === 'win32') {
    return { command: `corepack ${packageManager} pack --pm-on-fail=ignore --pack-destination "%DSH_TEST_PACK_DEST%"`, args: [], shell: true }
  }
  return { command: 'corepack', args: [packageManager, ...args], shell: false }
}

export function packedPackage(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-real-pack-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = fileURLToPath(new URL('../../', import.meta.url))
  const extracted = join(root, 'extracted')
  mkdirSync(extracted)
  const run = (command, args, cwd = root, options = {}) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 180000,
      maxBuffer: 8 * 1024 * 1024, windowsHide: true, ...options,
      env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', DSH_TEST_PACK_DEST: root } })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    return result.stdout
  }
  const lock = join(tmpdir(), 'dsh-pack-' + createHash('sha256').update(source).digest('hex'))
  const deadline = Date.now() + 180000
  for (;;) {
    try { mkdirSync(lock); break }
    catch (error) {
      if (error.code !== 'EEXIST' || Date.now() >= deadline) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
  }
  try {
    const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
    const { command, args, shell } = packInvocation(manifest.packageManager, root)
    run(command, args, source, { shell })
  } finally { rmSync(lock, { recursive: true }) }
  const archives = readdirSync(root).filter(name => name.endsWith('.tgz'))
  assert.equal(archives.length, 1)
  run('tar', ['-xzf', join(root, archives[0]), '-C', extracted])
  return { root, pkg: join(extracted, 'package'), manifest: JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')), run }
}
