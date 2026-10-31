import { randomUUID } from 'node:crypto'
import { closeSync, constants, copyFileSync, linkSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Write a complete new file without replacing any existing directory entry. */
export function writeFileNoReplace(file: string, contents: Uint8Array): void {
  const directory = dirname(file)
  mkdirSync(directory, { recursive: true })
  // Never touch a predictable .part file: it may be somebody else's download or a link.
  const temporary = join(directory, `.dsh-download-${randomUUID()}.part`)
  const descriptor = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(descriptor, contents)
    // A hard-link commit is atomic and fails with EEXIST even if another writer created
    // the final name after admission. rename() would silently replace it on Windows too.
    try {
      linkSync(temporary, file)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'ENOSYS'].includes(code ?? '')) throw error
      // FAT/exFAT and some network shares cannot create hard links. Exclusive copy keeps
      // the no-replacement guarantee there; unlike a hard link, it is not crash-atomic.
      copyFileSync(temporary, file, constants.COPYFILE_EXCL)
    }
  } finally {
    // Cleanup may be blocked by a scanner/lock after the final file was committed. It
    // must neither turn that success into a failure nor hide the original write error.
    try { closeSync(descriptor) } catch { /* best-effort cleanup */ }
    try { unlinkSync(temporary) } catch { /* best-effort cleanup */ }
  }
}
