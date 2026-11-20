import { createHash } from 'node:crypto'
import { copyFile, link, lstat, mkdir, readdir, readFile, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { installedProfileExtension, MAIN_EXTENSION_NAME } from './profile-extension.ts'
import { MaintenanceRecoveryError } from './maintenance-lifecycle.ts'
import { runProfileCommand } from './profile-command.ts'

async function fingerprint(path: string): Promise<string> {
  const info = await lstat(path)
  if (info.isSymbolicLink()) {
    const target = await readlink(path)
    return `link:${process.platform === 'win32' ? resolve(dirname(path), target).toLowerCase() : target}`
  }
  if (info.isDirectory()) {
    const entries = await readdir(path)
    entries.sort()
    const result: [string, string][] = []
    for (const name of entries) result.push([name, await fingerprint(join(path, name))])
    return createHash('sha256').update(JSON.stringify(result)).digest('hex')
  }
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function unrelatedPackages(profile: string): Promise<string> {
  const modules = join(profile, 'node_modules')
  const entries = (await readdir(modules)).filter(name => ![MAIN_EXTENSION_NAME, '.pnpm', '.bin', '.modules.yaml', '.pnpm-workspace-state-v1.json'].includes(name)).sort()
  const result: [string, string][] = []
  for (const name of entries) result.push([name, await fingerprint(join(modules, name))])
  for (const directory of ['.pnpm', '.bin']) {
    let names: string[]
    try { names = await readdir(join(modules, directory)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    for (const name of names.sort()) {
      if (directory === '.pnpm' && (name === 'lock.yaml' || name.startsWith(MAIN_EXTENSION_NAME + '@'))) continue
      if (directory === '.bin' && /^dsh-browser-install-electron(?:\.(?:cmd|ps1))?$/.test(name)) continue
      result.push([`${directory}/${name}`, await fingerprint(join(modules, directory, name))])
    }
  }
  return JSON.stringify(result)
}

async function verifyProfile(home: string): Promise<void> {
  await installedProfileExtension(home)
  const script = `const {createRequire} = await import('node:module'); const {readFile} = await import('node:fs/promises'); await readFile(createRequire(process.argv[1]).resolve(${JSON.stringify(MAIN_EXTENSION_NAME)}));`
  const result = await runProfileCommand(process.execPath, ['--expose-internals', '--input-type=module', '--eval', script, '--', join(home, 'profiles', 'desktop', 'package.json')],
    { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1' }, 10_000)
  if (result.code !== 0) throw new Error(`REINSTALL_PROFILE_RESOLUTION_FAILED: ${result.output}`)
}

type CheckpointEntry = { path: string } & (
  | { kind: 'directory' }
  | { kind: 'file'; preserved: 'copy' | 'hardlink' }
  | { kind: 'link'; target: string; type: 'directory' | 'file' | 'unknown' }
)
interface CheckpointIO {
  readonly copyFile: typeof copyFile
  readonly link: typeof link
  readonly symlink: typeof symlink
}

async function saveProfile(profile: string, before: string, io: CheckpointIO): Promise<CheckpointEntry[]> {
  const entries: CheckpointEntry[] = []
  const visit = async (path: string, mutable: boolean): Promise<void> => {
    const source = join(profile, path), info = await lstat(source)
    if (info.isSymbolicLink()) {
      const target = await readlink(source)
      let type: 'directory' | 'file' | 'unknown' = 'unknown'
      try { type = (await stat(source)).isDirectory() ? 'directory' : 'file' } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if (/(?:^|[\\/])node_modules[\\/](?:@[^\\/]+[\\/])?[^.\\/][^\\/]*$/.test(path)) type = 'directory'
      }
      entries.push({ path, kind: 'link', target, type })
      return
    }
    const destination = join(before, 'files', path)
    if (info.isDirectory()) {
      entries.push({ path, kind: 'directory' })
      await mkdir(destination, { recursive: true })
      for (const name of (await readdir(source)).sort()) {
        const child = join(path, name)
        await visit(child, mutable || path === 'node_modules' && (name === MAIN_EXTENSION_NAME || name.startsWith(MAIN_EXTENSION_NAME + '_tmp_') || ['.modules.yaml', '.pnpm-workspace-state-v1.json'].includes(name))
          || path === join('node_modules', '.pnpm') && (name.startsWith(MAIN_EXTENSION_NAME + '@') || name === 'lock.yaml')
          || path === join('node_modules', '.bin') && name.startsWith('dsh-browser-install-electron'))
      }
    } else {
      await mkdir(dirname(destination), { recursive: true })
      const preserved = mutable ? 'copy' : 'hardlink'
      await (mutable ? io.copyFile : io.link)(source, destination)
      entries.push({ path, kind: 'file', preserved })
    }
  }
  for (const name of (await readdir(profile)).sort()) await visit(name, name !== 'node_modules')
  await writeFile(join(before, 'metadata.json'), JSON.stringify({ version: 1, entries }))
  return entries
}

async function restoreProfile(profile: string, before: string, entries: readonly CheckpointEntry[], io: CheckpointIO): Promise<void> {
  await mkdir(profile)
  for (const entry of entries) {
    const destination = join(profile, entry.path)
    if (entry.kind === 'directory') await mkdir(destination, { recursive: true })
    else if (entry.kind === 'file') await (entry.preserved === 'copy' ? io.copyFile : io.link)(join(before, 'files', entry.path), destination)
    else {
      try {
        await io.symlink(entry.type === 'directory' && process.platform === 'win32' ? resolve(dirname(destination), entry.target) : entry.target, destination, entry.type === 'directory' ? 'junction' : 'file')
      } catch (error) {
        throw new Error(`REINSTALL_LINK_RESTORE_FAILED: ${entry.type} link ${entry.path}: ${String(error)}`)
      }
    }
  }
}

/** The checkpoint lives beside the staged worker, never inside the removable profile. */
export async function withProfileCheckpoint<T>(home: string, directory: string, operation: () => Promise<T>, overrides: Partial<CheckpointIO> = {}): Promise<T> {
  const profile = join(home, 'profiles', 'desktop')
  const before = join(directory, 'profile-before')
  const io = { copyFile, link, symlink, ...overrides }
  let entries: CheckpointEntry[], unrelated: string, original: string
  let created = false
  try {
    await verifyProfile(home)
    unrelated = await unrelatedPackages(profile)
    original = await fingerprint(profile)
    await mkdir(before)
    created = true
    entries = await saveProfile(profile, before, io)
  } catch (error) {
    if (created) await rm(before, { recursive: true, force: true })
    throw new Error(`REINSTALL_CHECKPOINT_FAILED: profile unchanged: ${String(error)}`)
  }
  try {
    const result = await operation()
    if (await unrelatedPackages(profile) !== unrelated) throw new Error('REINSTALL_UNRELATED_PACKAGES_CHANGED: package manager changed unrelated packages; restoring the profile')
    await verifyProfile(home)
    return result
  } catch (failure) {
    if (failure instanceof MaintenanceRecoveryError) throw failure
    try {
      await rename(profile, join(directory, 'profile-failed'))
      await restoreProfile(profile, before, entries, io)
      if (await fingerprint(profile) !== original) throw new Error('restored profile differs from checkpoint')
      await verifyProfile(home)
    } catch (error) {
      throw new MaintenanceRecoveryError(`REINSTALL_ROLLBACK_FAILED: ${String(error)}; original failure: ${String(failure)}; checkpoint: ${before}`)
    }
    throw new Error(`${String(failure)}; REINSTALL_PROFILE_RESTORED: complete pre-job profile restored and plugin resolution verified`)
  }
}
