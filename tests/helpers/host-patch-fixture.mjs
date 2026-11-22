import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'

export function hostPatchFixture(name, kind, release = 'rc3') {
  const directory = release === 'rc3' ? '' : release + '/'
  return gunzipSync(readFileSync(new URL(`../fixtures/dsh-host-patch/${directory}${name}.${kind}.js.gz`, import.meta.url))).toString('utf8')
}
