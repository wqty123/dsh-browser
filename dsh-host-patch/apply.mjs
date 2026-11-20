import * as fs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { stripLegacyBridge } from './legacy-bridge.mjs'

const specs = ['rc3', 'rc5'].map(name => JSON.parse(fs.readFileSync(new URL(`./${name}.json`, import.meta.url), 'utf8')))
const previousSpecs = ['rc3', 'rc5'].flatMap(name => [3, 2, 1].map(revision =>
  JSON.parse(revision === 3
    ? gunzipSync(fs.readFileSync(new URL(`./${name}-revision${revision}.json.gz`, import.meta.url))).toString('utf8')
    : fs.readFileSync(new URL(`./${name}-revision${revision}.json`, import.meta.url), 'utf8'))))
const suffix = '.before-dsh-host-patch'
const digest = value => createHash('sha256').update(value).digest('hex')

function exactlyOnce(text, anchor) {
  const at = text.indexOf(anchor)
  if (!anchor || at < 0 || text.indexOf(anchor, at + 1) !== -1) throw new Error('anchor must match exactly once')
  return at
}

/** Resolve only the sidebar stylesheet's class prefix, independent of its build directory. */
function substitutions(text, target) {
  if (target.id !== 'client') return value => value
  const matches = [...text.matchAll(/\.([A-Za-z0-9_-]+)_session\{display:contents\}/g)]
  if (matches.length !== 1) throw new Error('sidebar CSS module prefix is missing or ambiguous')
  return value => value.replaceAll('{{sidebar}}', matches[0][1])
}

/** Validate every anchor against the original input before producing any replacement. */
export function patchText(text, target) {
  if (text.includes(target.marker)) throw new Error('already patched')
  if (target.sha256 && digest(text) !== target.sha256) throw new Error('pristine main.js hash mismatch')
  const substitute = substitutions(text, target)
  const edits = target.edits.map(edit => {
    const before = substitute(edit.before)
    return { at: exactlyOnce(text, before), before, after: substitute(edit.after) }
  }).sort((a, b) => a.at - b.at)
  for (let i = 1; i < edits.length; i++) {
    if (edits[i].at < edits[i - 1].at + edits[i - 1].before.length) throw new Error('overlapping anchors')
  }
  for (const edit of edits.reverse()) text = text.slice(0, edit.at) + edit.after + text.slice(edit.at + edit.before.length)
  if (!text.includes(target.marker)) throw new Error('patch marker is missing')
  return text
}

function patchSource(text, target, path, io) {
  if (!target.legacyBridge || !text.includes(target.legacyBridge.marker)) return text
  const backup = path + target.legacyBridge.backupSuffix
  if (!io.lstatSync(backup).isFile() || io.lstatSync(backup).isSymbolicLink()) throw new Error('legacy bridge backup is not a regular file')
  const pristine = io.readFileSync(backup, 'utf8')
  if (digest(pristine) !== target.sha256) throw new Error('legacy bridge backup pristine main.js hash mismatch')
  if (stripLegacyBridge(text) !== pristine) throw new Error('live main.js is not the pristine backup plus a recognized legacy bridge; refusing to discard other edits')
  return pristine
}

function plan(packages, restoring, io) {
  const directories = typeof packages === 'string' ? [packages] : packages
  if (!Array.isArray(directories) || directories.length === 0) throw new Error('at least one package directory is required')
  const entries = directories.flatMap(directory => {
    const root = io.realpathSync(directory)
    const manifest = JSON.parse(io.readFileSync(join(root, 'package.json'), 'utf8'))
    const spec = specs.find(item => item.version === manifest.version)
    if (!spec) {
      const error = new Error(`unsupported DSH version: ${String(manifest.version)} (supported: ${specs.map(item => item.version).join(', ')})`)
      error.status = 'unsupported version'
      throw error
    }
    const targets = spec.targets.filter(item => item.packageName === manifest.name)
    if (targets.length === 0) throw new Error(`unsupported package: ${String(manifest.name)}`)
    return targets.map(target => {
      const path = join(root, target.file)
      const real = io.realpathSync(path)
      const part = relative(root, real)
      if (part === '..' || part.startsWith('..' + '/') || part.startsWith('..' + '\\') || isAbsolute(part)) {
        throw new Error('target resolves outside its package')
      }
      if (!io.lstatSync(path).isFile() || io.lstatSync(path).isSymbolicLink()) throw new Error('target is not a regular file')
      const text = io.readFileSync(path, 'utf8')
      const backup = path + suffix
      const held = io.existsSync(backup)
      if (held && (!io.lstatSync(backup).isFile() || io.lstatSync(backup).isSymbolicLink())) throw new Error('backup is not a regular file')
      const original = held ? io.readFileSync(backup, 'utf8') : undefined
      const applied = text.includes(target.marker)
      if (applied) {
        if (original !== undefined && patchText(patchSource(original, target, path, io), target) !== text) throw new Error('patched file differs from its recorded backup; refusing to overwrite other edits')
        if (restoring && original === undefined) throw new Error('no backup for this already patched host')
        return { path, backup, text, output: restoring ? original : text, applied, held, mode: io.statSync(path).mode }
      }
      const previousTarget = previousSpecs.filter(item => item.version === manifest.version).flatMap(item => item.targets)
        .find(item => item.id === target.id && item.marker !== target.marker && text.includes(item.marker))
      const previous = previousTarget !== undefined && text.includes(previousTarget.marker)
      if (previous) {
        if (original === undefined) throw new Error('no backup for the previous host patch revision')
        if (patchText(patchSource(original, previousTarget, path, io), previousTarget) !== text) throw new Error('previous patch revision differs from its recorded backup; refusing to overwrite other edits')
        return { path, backup, text, output: restoring ? original : patchText(patchSource(original, target, path, io), target),
          applied: false, previous: true, held, mode: io.statSync(path).mode }
      }
      if (restoring) {
        if (original !== undefined && original !== text) throw new Error('file changed after restore or Desktop update')
        return { path, backup, text, output: text, applied, held, mode: io.statSync(path).mode }
      }
      if (original !== undefined && original !== text) throw new Error('backup belongs to different bytes; refusing to overwrite it')
      return { path, backup, text, backupText: text, output: patchText(patchSource(text, target, path, io), target), applied, held, mode: io.statSync(path).mode }
    })
  })
  if (new Set(entries.map(entry => entry.path)).size !== entries.length) throw new Error('duplicate package target')
  if (!restoring && !entries.some(entry => entry.previous) && entries.some(entry => entry.applied) && !entries.every(entry => entry.applied)) {
    throw new Error('only part of the host patch is present; restore before applying')
  }
  return entries
}

function inspect(packages, restoring, io) {
  try {
    const entries = plan(packages, restoring, io)
    return { status: entries.every(entry => entry.applied) ? 'applied' : 'absent',
      ...(entries.some(entry => entry.previous) ? { reason: 'host patch revision 1 or 2 or 3; explicit bootstrap upgrade to revision 4 required' } : {}), entries }
  } catch (error) {
    return { status: error.status ?? 'anchors mismatch', reason: String(error.message ?? error) }
  }
}

/** Read-only validation. A valid absent patch is ready to apply; a mismatch never writes. */
export function hostPatchStatus(packages, options = {}) {
  const { entries, ...status } = inspect(packages, false, options.fs ?? fs)
  return status
}

function change(packages, restoring, options) {
  const io = options.fs ?? fs
  const checked = inspect(packages, restoring, io)
  if (!checked.entries) return { ...checked, changed: false }
  const changed = checked.entries.filter(entry => entry.text !== entry.output)
  const staged = []
  const backedUp = []
  const committed = []
  try {
    for (const entry of changed) {
      const temporary = join(dirname(entry.path), `.dsh-host-patch-${randomUUID()}`)
      const rollback = temporary + '.original'
      const backupTemporary = temporary + '.backup'
      staged.push({ ...entry, temporary, rollback, backupTemporary })
      io.writeFileSync(temporary, entry.output, { flag: 'wx', mode: entry.mode })
      io.writeFileSync(rollback, entry.text, { flag: 'wx', mode: entry.mode })
      if (!restoring && !entry.held) io.writeFileSync(backupTemporary, entry.backupText, { flag: 'wx', mode: entry.mode })
    }
    // Recheck all inputs before committing, including targets that needed no change.
    for (const entry of checked.entries) {
      if (io.readFileSync(entry.path, 'utf8') !== entry.text) throw new Error('target changed during validation')
    }
    for (const entry of staged) {
      if (!restoring && !entry.held) {
        io.linkSync(entry.backupTemporary, entry.backup)
        backedUp.push(entry.backup)
      }
    }
    for (const entry of staged) {
      io.renameSync(entry.temporary, entry.path)
      committed.push(entry)
    }
    return { status: restoring ? 'absent' : 'applied', changed: changed.length > 0 }
  } catch (error) {
    const failures = []
    for (const entry of committed.reverse()) {
      try { io.renameSync(entry.rollback, entry.path) } catch (failure) { failures.push(String(failure)) }
    }
    for (const backup of backedUp) {
      try { io.unlinkSync(backup) } catch (failure) { failures.push(String(failure)) }
    }
    return { status: 'anchors mismatch', changed: false,
      reason: String(error.message ?? error) + (failures.length ? '; rollback failed: ' + failures.join('; ') : '') }
  } finally {
    for (const entry of staged) {
      for (const path of [entry.temporary, entry.rollback, entry.backupTemporary]) {
        try { io.rmSync(path, { force: true }) } catch { /* report the original write failure */ }
      }
    }
  }
}

/** Apply all validated targets, backing up once and replacing hardlinks by rename. */
export function applyHostPatch(packages, options = {}) { return change(packages, false, options) }

/** Restore only files that exactly match the patch applied to their preserved backup. */
export function restoreHostPatch(packages, options = {}) { return change(packages, true, options) }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action = 'status', ...directories] = process.argv.slice(2)
  const operation = { status: hostPatchStatus, 'dry-run': hostPatchStatus, apply: applyHostPatch, restore: restoreHostPatch }[action]
  const result = operation ? operation(directories) : { status: 'anchors mismatch', reason: 'usage: node dsh-host-patch/apply.mjs status|dry-run|apply|restore <package-directory> [...]' }
  console.log(JSON.stringify(result))
  if (!['absent', 'applied'].includes(result.status)) process.exitCode = 1
}
