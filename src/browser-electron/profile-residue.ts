import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { MAIN_EXTENSION_NAME } from './profile-extension.ts'
import { runProfileCommand } from './profile-command.ts'

export async function inspectProfileResidue(home: string): Promise<readonly string[]> {
  const profile = join(home, 'profiles', 'desktop')
  const plugin = join(profile, 'node_modules', MAIN_EXTENSION_NAME)
  let directory: string
  try { directory = await realpath(plugin) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const path = relative(await realpath(profile), directory)
  if (path === '..' || path.startsWith('../') || path.startsWith('..\\') || isAbsolute(path)) return []
  const modules = join(directory, 'node_modules')
  let info
  try { info = await lstat(modules) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  if (info.isSymbolicLink()) return ['node_modules (external link)']
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string>
  }
  const declared = new Set(Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies }))
  const names: string[] = []
  for (const name of await readdir(modules)) {
    if (name === '.bin' || name === '.modules.yaml') continue
    if (name.startsWith('@') && !(await lstat(join(modules, name))).isSymbolicLink()) {
      for (const child of await readdir(join(modules, name))) names.push(`${name}/${child}`)
    } else names.push(name)
  }
  return names.filter(name => !declared.has(name)).sort()
}

/** Only contaminated, profile-owned nested dependencies are removed; external link checkouts are untouched. */
export async function cleanProfileResidue(home: string): Promise<string> {
  const residue = await inspectProfileResidue(home)
  if (residue.length === 0) return ''
  const path = join(home, 'profiles', 'desktop', 'node_modules', MAIN_EXTENSION_NAME, 'node_modules')
  const script = `process.noAsar = true; const { rm } = await import('node:fs/promises'); await rm(process.argv[1], {recursive:true, force:true, maxRetries:3, retryDelay:100});`
  const result = await runProfileCommand(process.execPath, ['--expose-internals', '--input-type=module', '--eval', script, '--', path],
    { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1' })
  if (result.code !== 0) throw new Error(`REINSTALL_RESIDUE_REMOVE_FAILED: ${result.output}`)
  return `Removed pre-existing undeclared nested dependency residue before pnpm: ${residue.join(', ')}`
}
