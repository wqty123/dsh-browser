import assert from 'node:assert/strict'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

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

export function extractPackedPackage(run, directory, archive) {
  assert.ok(typeof archive === 'string' && archive.length > 0 && !/[:/\\]/.test(archive), 'archive must be a relative filename')
  return run('tar', ['-xzf', archive, '-C', 'extracted'], directory)
}

export function stagePackage(source, destination) {
  const excluded = new Set(['.git', 'node_modules', 'lib', 'dist'])
  cpSync(source, destination, { recursive: true,
    filter: path => !excluded.has(relative(source, path).split(sep)[0]),
  })
  let directory = source
  for (;;) {
    const dependencies = join(directory, 'node_modules')
    if (existsSync(dependencies)) {
      linkDependencies(dependencies, join(destination, 'node_modules'))
      return destination
    }
    const parent = dirname(directory)
    assert.notEqual(parent, directory, 'node_modules is unavailable for the isolated pack fixture')
    directory = parent
  }
}

/**
 * Links every installed package to its real location instead of linking the whole folder: pnpm's
 * entries are relative symlinks, and Windows resolves those against the path walked to reach them,
 * so through a junction (the only directory link that needs no privilege) they point nowhere.
 */
function linkDependencies(source, destination) {
  mkdirSync(destination, { recursive: true })
  for (const name of readdirSync(source)) {
    const entry = join(source, name)
    if (name.startsWith('@') && !lstatSync(entry).isSymbolicLink()) {
      linkDependencies(entry, join(destination, name))
      continue
    }
    let target
    try { target = realpathSync(entry) } catch { continue }
    if (statSync(target).isDirectory()) symlinkSync(target, join(destination, name), process.platform === 'win32' ? 'junction' : 'dir')
  }
}

export function packedPackage(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-real-pack-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = fileURLToPath(new URL('../../', import.meta.url))
  const staging = stagePackage(source, join(root, 'source'))
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
  const manifest = JSON.parse(readFileSync(join(staging, 'package.json'), 'utf8'))
  const { command, args, shell } = packInvocation(manifest.packageManager, root)
  run(command, args, staging, { shell })
  const archives = readdirSync(root).filter(name => name.endsWith('.tgz'))
  assert.equal(archives.length, 1)
  extractPackedPackage(run, root, archives[0])
  return { root, pkg: join(extracted, 'package'), manifest: JSON.parse(readFileSync(join(staging, 'package.json'), 'utf8')), run }
}
