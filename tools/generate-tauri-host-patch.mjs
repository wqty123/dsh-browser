/**
 * Generate dsh-host-patch/tauri.json from dsh-host-patch/tauri/sidebar-session.cjs and the pristine
 * DSH Tauri runtime/browser.cjs fixtures. `--check` fails when the committed spec is out of date.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const output = fileURLToPath(new URL('dsh-host-patch/tauri.json', root))
const releases = ['0.33.0']
const marker = '/* dsh-host-patch: tauri sidebar session r2 */'

function embedded(name) {
  const source = readFileSync(new URL(`dsh-host-patch/tauri/${name}`, root), 'utf8')
  const start = source.indexOf('module.exports = ')
  if (start < 0) throw new Error(`${name} must assign module.exports`)
  return source.slice(start + 'module.exports = '.length).trim()
}

export function tauriSidebarSessionSource() {
  return embedded('sidebar-session.cjs')
}

export function tauriDesktopMainSource() {
  return embedded('desktop-main.cjs')
}

export function tauriHostPatchSpec() {
  const session = tauriSidebarSessionSource()
  const main = tauriDesktopMainSource()
  const targets = releases.map(release => {
    const pristine = readFileSync(new URL(`tests/fixtures/dsh-host-patch/tauri-${release}/browser.cjs`, root), 'utf8')
    return {
      id: 'browser',
      release,
      file: 'runtime/browser.cjs',
      sha256: createHash('sha256').update(pristine).digest('hex'),
      marker,
      edits: [
        {
          before: 'let t=require("electron"),n=require("node:crypto");',
          after: `let t=require("electron"),n=require("node:crypto");${marker}const dshSidebarSession=(${session})({app:t.app,createHash:n.createHash,fs:require("node:fs"),path:require("node:path")});const dshDesktopMain=(${main})({app:t.app,webContents:t.webContents,fs:require("node:fs"),path:require("node:path"),os:require("node:os"),url:require("node:url"),importEntry:e=>import(e)});`,
        },
        {
          before: 'bind(n){let r=n.trustedOrigin;if(r===`null`)throw Error(`browser guest: host requires a document origin`);',
          after: 'bind(n){let r=n.trustedOrigin;if(r===`null`)throw Error(`browser guest: host requires a document origin`);dshDesktopMain.host(n.contents);',
        },
        {
          before: 'acquire(e,r){if(this.owner(e),',
          after: 'async acquire(e,r){if(this.owner(e),',
        },
        {
          before: 'let i=this.partitions.get(r);if(!i){i=`electron-browser-`+(0,n.randomUUID)();',
          after: 'let i=dshSidebarSession.partition();if(!this.partitions.has(i)){',
        },
        {
          before: 'e.on(`will-download`,e=>e.preventDefault()),',
          after: 'e.on(`will-download`,(e,t)=>dshSidebarSession.download(t)),',
        },
        {
          before: 'this.partitions.set(r,i)}let a=(0,n.randomUUID)();',
          after: 'this.partitions.set(i,i)}if(await dshSidebarSession.attach(t.session.fromPartition(i)),this.owner(e),e.trustedNavigationPending)throw Error(`browser guest: trusted navigation pending`);let a=(0,n.randomUUID)();',
        },
      ],
    }
  })
  return { host: 'electron-rs', identifiers: ['dsh-tauri'], version: 'tauri', revision: 2, targets }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = JSON.stringify(tauriHostPatchSpec(), null, 2) + '\n'
  if (process.argv.includes('--check')) {
    if (readFileSync(output, 'utf8') !== text) {
      console.error('dsh-host-patch/tauri.json is out of date; run node tools/generate-tauri-host-patch.mjs')
      process.exitCode = 1
    }
  } else writeFileSync(output, text)
}
