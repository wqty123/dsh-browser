import { createHash } from 'node:crypto'
import { cp, lstat, readdir, readFile, readlink, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { installedProfileExtension, MAIN_EXTENSION_NAME } from './profile-extension.ts'
import { MaintenanceRecoveryError } from './maintenance-lifecycle.ts'
import { runProfileCommand } from './profile-command.ts'

async function fingerprint(path: string): Promise<string> {
  const info = await lstat(path)
  if (info.isSymbolicLink()) return `link:${await readlink(path)}`
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

/** The checkpoint lives beside the staged worker, never inside the removable profile. */
export async function withProfileCheckpoint<T>(home: string, directory: string, operation: () => Promise<T>): Promise<T> {
  const profile = join(home, 'profiles', 'desktop')
  const before = join(directory, 'profile-before')
  try { await verifyProfile(home) } catch (error) {
    throw new Error(`REINSTALL_PROFILE_UNAVAILABLE: the pre-job plugin must resolve before maintenance: ${String(error)}`)
  }
  const unrelated = await unrelatedPackages(profile)
  await cp(profile, before, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, force: false, errorOnExist: true })
  const original = await fingerprint(before)
  try {
    const result = await operation()
    if (await unrelatedPackages(profile) !== unrelated) throw new Error('REINSTALL_UNRELATED_PACKAGES_CHANGED: package manager changed unrelated packages; restoring the profile')
    await verifyProfile(home)
    return result
  } catch (failure) {
    if (failure instanceof MaintenanceRecoveryError) throw failure
    try {
      await rename(profile, join(directory, 'profile-failed'))
      await rename(before, profile)
      if (await fingerprint(profile) !== original) throw new Error('restored profile differs from checkpoint')
      await verifyProfile(home)
    } catch (error) {
      throw new MaintenanceRecoveryError(`REINSTALL_ROLLBACK_FAILED: ${String(error)}; original failure: ${String(failure)}; checkpoint: ${before}`)
    }
    throw new Error(`${String(failure)}; REINSTALL_PROFILE_RESTORED: complete pre-job profile restored and plugin resolution verified`)
  }
}
