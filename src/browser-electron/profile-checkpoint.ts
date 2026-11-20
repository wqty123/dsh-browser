import { copyFile, lstat, mkdir, readdir, readFile, readlink, rename, rm, rmdir, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { installedProfileExtension, MAIN_EXTENSION_NAME } from './profile-extension.ts'
import { MaintenanceRecoveryError } from './maintenance-lifecycle.ts'
import { runProfileCommand } from './profile-command.ts'

type Entry = { path: string } & (
  | { kind: 'missing' | 'directory' | 'file' }
  | { kind: 'link'; target: string; type: 'directory' | 'file' }
)
interface CheckpointIO {
  readonly copyFile: typeof copyFile
  readonly symlink: typeof symlink
  readonly readdir: typeof readdir
  readonly reconcile: () => Promise<void>
}
const pluginPath = join('node_modules', MAIN_EXTENSION_NAME)
const manifestPaths = ['package.json', 'pnpm-lock.yaml', join('node_modules', '.modules.yaml')]

async function describe(profile: string, path: string, packageEntry = false): Promise<Entry> {
  const source = join(profile, path)
  let info
  try { info = await lstat(source) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, kind: 'missing' }
    throw error
  }
  if (info.isSymbolicLink()) {
    const target = await readlink(source)
    let type: 'directory' | 'file' = 'directory'
    if (!packageEntry) {
      try { type = (await stat(source)).isDirectory() ? 'directory' : 'file' } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return { path, kind: 'link', target, type }
  }
  return { path, kind: info.isDirectory() ? 'directory' : 'file' }
}

async function inventory(profile: string, io: CheckpointIO): Promise<Entry[]> {
  const entries: Entry[] = []
  for (const name of (await io.readdir(join(profile, 'node_modules'))).sort()) {
    const path = join('node_modules', name), entry = await describe(profile, path, true)
    entries.push(entry)
    if (name.startsWith('@') && entry.kind === 'directory') {
      for (const child of (await io.readdir(join(profile, path))).sort()) entries.push(await describe(profile, join(path, child), true))
    }
  }
  return entries
}

async function saveProfile(profile: string, before: string, io: CheckpointIO): Promise<{ entries: Entry[]; modules: Entry[] }> {
  const entries: Entry[] = []
  const visit = async (path: string, packageEntry = false): Promise<void> => {
    const entry = await describe(profile, path, packageEntry)
    entries.push(entry)
    const destination = join(before, 'files', path)
    if (entry.kind === 'directory') {
      await mkdir(destination, { recursive: true })
      for (const name of (await io.readdir(join(profile, path))).sort()) await visit(join(path, name))
    } else if (entry.kind === 'file') {
      await mkdir(dirname(destination), { recursive: true })
      await io.copyFile(join(profile, path), destination)
    }
  }
  if ((await lstat(join(profile, 'node_modules'))).isSymbolicLink()) throw new Error('REINSTALL_CHECKPOINT_LINKED_MODULES: node_modules must be a real directory')
  const modules = await inventory(profile, io)
  for (const path of manifestPaths) await visit(path)
  await visit(pluginPath, true)
  await writeFile(join(before, 'metadata.json'), JSON.stringify({ version: 2, entries, modules }))
  return { entries, modules }
}

async function restoreLink(profile: string, entry: Extract<Entry, { kind: 'link' }>, io: CheckpointIO): Promise<void> {
  const destination = join(profile, entry.path)
  await mkdir(dirname(destination), { recursive: true })
  try {
    await io.symlink(entry.type === 'directory' && process.platform === 'win32' ? resolve(dirname(destination), entry.target) : entry.target,
      destination, entry.type === 'directory' ? 'junction' : 'file')
  } catch (error) { throw new Error(`REINSTALL_LINK_RESTORE_FAILED: ${entry.type} link ${entry.path}: ${String(error)}`) }
}

async function restoreFiles(profile: string, before: string, entries: readonly Entry[], io: CheckpointIO): Promise<void> {
  for (const path of [...manifestPaths, pluginPath]) await rm(join(profile, path), { recursive: true, force: true })
  for (const entry of entries) {
    const destination = join(profile, entry.path)
    if (entry.kind === 'directory') await mkdir(destination, { recursive: true })
    else if (entry.kind === 'file') {
      await mkdir(dirname(destination), { recursive: true })
      await io.copyFile(join(before, 'files', entry.path), destination)
    } else if (entry.kind === 'link') await restoreLink(profile, entry, io)
  }
}

function unrelated(entries: readonly Entry[]): string {
  return JSON.stringify(entries.filter(entry => entry.path !== pluginPath && !manifestPaths.includes(entry.path) && entry.path !== join('node_modules', '.ignored')))
}

async function recoverModules(profile: string, modules: readonly Entry[], io: CheckpointIO): Promise<void> {
  const ignored = join('node_modules', '.ignored')
  for (const entry of modules) {
    if (entry.path === pluginPath || manifestPaths.includes(entry.path) || entry.path === ignored) continue
    const current = await describe(profile, entry.path, true)
    if (JSON.stringify(current) === JSON.stringify(entry)) continue
    if (current.kind !== 'missing') throw new Error(`REINSTALL_UNRELATED_PACKAGE_CHANGED: ${entry.path}`)
    if (entry.kind === 'link') await restoreLink(profile, entry, io)
    else {
      const relative = entry.path.slice('node_modules'.length + 1), parts = relative.split(/[\\/]/)
      for (let i = 0; i < parts.length; i++) {
        const parent = await describe(profile, join(ignored, ...parts.slice(0, i)), true)
        if (parent.kind !== 'directory') throw new Error(`REINSTALL_ORPHAN_RECOVERY_FAILED: unsafe or missing .ignored path for ${entry.path}`)
      }
      await mkdir(dirname(join(profile, entry.path)), { recursive: true })
      await rename(join(profile, ignored, relative), join(profile, entry.path))
      for (let i = parts.length - 1; i >= 0; i--) {
        if (i === 0 && modules.some(entry => entry.path === ignored)) break
        try { await rmdir(join(profile, ignored, ...parts.slice(0, i))) } catch (error) {
          if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        }
      }
    }
  }
}

async function verifyProfile(home: string): Promise<void> {
  await installedProfileExtension(home)
  const script = `const {createRequire} = await import('node:module'); const {readFile} = await import('node:fs/promises'); await readFile(createRequire(process.argv[1]).resolve(${JSON.stringify(MAIN_EXTENSION_NAME)}));`
  const result = await runProfileCommand(process.execPath, ['--expose-internals', '--input-type=module', '--eval', script, '--', join(home, 'profiles', 'desktop', 'package.json')],
    { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1' }, 10_000)
  if (result.code !== 0) throw new Error(`REINSTALL_PROFILE_RESOLUTION_FAILED: ${result.output}`)
}

/** The checkpoint lives beside the staged worker, never inside the removable profile. */
export async function withProfileCheckpoint<T>(home: string, directory: string, operation: () => Promise<T>, options: Pick<CheckpointIO, 'reconcile'> & Partial<CheckpointIO>): Promise<T> {
  const profile = join(home, 'profiles', 'desktop'), before = join(directory, 'profile-before')
  const io = { copyFile, symlink, readdir, ...options }
  let saved: { entries: Entry[]; modules: Entry[] }
  let created = false
  try {
    await verifyProfile(home)
    await mkdir(before)
    created = true
    saved = await saveProfile(profile, before, io)
  } catch (error) {
    if (created) await rm(before, { recursive: true, force: true })
    throw new Error(`REINSTALL_CHECKPOINT_FAILED: profile unchanged: ${String(error)}`)
  }
  try {
    const result = await operation()
    if (unrelated(await inventory(profile, io)) !== unrelated(saved.modules)) throw new Error('REINSTALL_UNRELATED_PACKAGES_CHANGED: package manager changed unrelated entries; restoring the profile')
    await verifyProfile(home)
    return result
  } catch (failure) {
    if (failure instanceof MaintenanceRecoveryError) throw failure
    try {
      await restoreFiles(profile, before, saved.entries, io)
      await io.reconcile()
      await recoverModules(profile, saved.modules, io)
      await restoreFiles(profile, before, saved.entries, io)
      await verifyProfile(home)
    } catch (error) {
      throw new MaintenanceRecoveryError(`REINSTALL_ROLLBACK_FAILED: ${String(error)}; original failure: ${String(failure)}; checkpoint: ${before}`)
    }
    throw new Error(`${String(failure)}; REINSTALL_PROFILE_RESTORED: profile manifests and plugin restored, dependencies reconciled offline and plugin resolution verified`)
  }
}
