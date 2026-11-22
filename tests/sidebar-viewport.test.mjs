import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

test('native and opaque iframe viewports follow the sidebar at matching zoom and device scale', {
  skip: !process.env.DSH_TEST_ELECTRON && 'set DSH_TEST_ELECTRON to an Electron executable',
}, async t => {
  const profile = mkdtempSync(join(tmpdir(), 'dsh-sidebar-viewport-'))
  const css = readFileSync(new URL('../src/client/view/Browser.module.css', import.meta.url), 'utf8')
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/javascript')
    if (req.url === '/src/client/view/Browser.module.css') {
      res.end('export default new Proxy({}, {get: (_, name) => name})')
    } else if (req.url === '/src/client/electron/ElectronWebviewPresentation.ts' || req.url === '/src/client/view/IframePresentation.ts') {
      res.end(stripTypeScriptTypes(readFileSync(new URL('..' + req.url, import.meta.url), 'utf8'), { mode: 'transform' }))
    } else if (req.url === '/fixture.js') {
      res.end(readFileSync(new URL('./fixtures/sidebar-viewport.js', import.meta.url), 'utf8'))
    } else if (req.url === '/') {
      res.setHeader('content-type', 'text/html')
      res.end(`<html><head><style>${css}
        body { margin: 0; background: #e8edf4; } #sidebar { position: absolute; right: 0; top: 0; width: 500px; height: 600px; display: flex; flex-direction: column; }
      </style></head><body><div id="sidebar"><div class="content"><div class="viewport" id="viewport"></div></div></div><script type="module" src="/fixture.js"></script></body></html>`)
    } else {
      res.setHeader('content-type', 'text/html')
      res.end(`<html><body style="margin:0"><h2>Sidebar viewport</h2><div style="width:100%;height:100px;background:#c6e8d1">Responsive guest</div><script>
        addEventListener('message', event => { if (event.data === 'measure') parent.postMessage({ type: 'measurement', width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, '*') })
      </script></body></html>`)
    }
  }).listen(0, '127.0.0.1')
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    rmSync(profile, { recursive: true, force: true })
  })
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const { stdout, stderr } = await promisify(execFile)(process.env.DSH_TEST_ELECTRON, [
    '--no-sandbox', fileURLToPath(new URL('./fixtures/sidebar-viewport.cjs', import.meta.url)),
  ], { timeout: 60000, maxBuffer: 4 * 1024 * 1024, env: {
    ...process.env, DSH_VIEWPORT_ORIGIN: origin, DSH_VIEWPORT_PROFILE: profile,
  } })
  const line = stdout.split('\n').find(line => line.startsWith('VIEWPORT_RESULT='))
  assert.ok(line, stdout + '\n' + stderr)
  const result = JSON.parse(line.slice('VIEWPORT_RESULT='.length))
  for (const row of result.rows) {
    assert.ok(Math.abs(row.guest.width - row.host.width) <= 1, JSON.stringify(row))
    assert.ok(Math.abs(row.guest.height - row.host.height) <= 1, JSON.stringify(row))
    assert.ok(Math.abs(row.guest.dpr - row.host.dpr) < 0.01, JSON.stringify(row))
  }
  assert.deepEqual([...new Set(result.rows.map(row => row.host.width))], [500, 280, 720])
  assert.equal(result.rows.length, 18)
  assert.deepEqual(result.lifecycle, { detached: true, disposed: true, pendingIgnored: true, emptySafe: true, errorReported: true })
  console.log(`Viewport layout: ${result.rows.length} native/opaque-iframe measurements passed; lifecycle checks passed`)
})
