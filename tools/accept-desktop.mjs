// Post-restart acceptance run.
//
// Everything this session fixed, checked in one pass against the live shell. Written before the
// restart on purpose: the alternative is what happened for the last four rounds — one check at a
// time, each one finding the next problem, each one costing the user another restart.
//
// Usage: node tools/accept-desktop.mjs
// It sends real requests to the running bridge, so it DOES open pages. Every step reports what it
// saw; nothing is inferred.
import { readFileSync } from 'node:fs'
import { connect } from 'node:net'

const ENDPOINT = process.env.DSH_BRIDGE_ENDPOINT ?? 'D:/dsh-home/dsh-builtin-browser-bridge.json'
const ep = JSON.parse(readFileSync(ENDPOINT, 'utf8'))

const socket = connect({ host: '127.0.0.1', port: ep.port })
socket.setEncoding('utf8')
let seq = 1
const pending = new Map()
let buffer = ''
socket.on('data', (chunk) => {
  buffer += chunk
  let cut
  while ((cut = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, cut)
    buffer = buffer.slice(cut + 1)
    if (line.trim() === '') continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    const waiter = pending.get(message.bridgeRequestId)
    if (waiter === undefined) continue
    clearTimeout(waiter.timer)
    pending.delete(message.bridgeRequestId)
    waiter.resolve(message)
  }
})

/** @returns the bridge's answer, or throws on timeout. */
function call (op, extra = {}, ms = 120_000) {
  const id = seq++
  const request = { op, bridgeRequestId: id, ...extra }
  if (id === 1) request.token = ep.token
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(op + ' timed out')) }, ms)
    pending.set(id, { resolve, timer })
    socket.write(JSON.stringify(request) + '\n')
  })
}

await new Promise(resolve => socket.on('connect', resolve))

const results = []
/**
 * Record one check, and on failure print enough state to diagnose without another restart.
 *
 * The restart is the scarce resource here: a run that says only "FAIL" costs another one to
 * interpret. So a failure also reads the strip back — how many tabs this session holds, and what
 * the strip's own labels are, which is where 开始 entries with no page behind them show up.
 */
async function check (name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail === '' ? '' : '   ' + detail}`)
  if (ok) return
  try {
    const state = await call('list', { owner: 'acceptance' }, 20_000)
    const mine = state.sidebar ?? []
    console.log(`        [diag] this session holds ${mine.length} page(s)`)
    for (const guest of mine) {
      console.log(`        [diag]   id=${guest.id} title=${JSON.stringify(String(guest.title ?? '').slice(0, 44))}`)
    }
    const shell = (state.guests ?? []).find(g => g.type === 'window')
    if (shell !== undefined) {
      const strip = await call('cdp', {
        id: shell.id,
        method: 'Runtime.evaluate',
        params: {
          expression: `(() => {
            const strip = document.querySelector('[class*=_tabStrip]');
            if (strip === null) return JSON.stringify({ strip: 'absent' });
            const rows = Array.from(strip.querySelectorAll('button,[role=tab],[class*=tab]'))
              .map(r => ((r.getAttribute('aria-label') || '') + ' ' + (r.textContent || '')).trim().slice(0, 18))
              .filter(t => t !== '');
            return JSON.stringify({ strip: 'present', labels: rows.slice(0, 14) });
          })()`,
          returnByValue: true,
        },
      }, 20_000)
      console.log('        [diag] strip ' + String(strip?.result?.result?.value ?? 'unreadable').slice(0, 300))
    }
  } catch (error) {
    console.log('        [diag] could not read state: ' + String(error.message).slice(0, 70))
  }
}

console.log('=== post-restart acceptance ===')
console.log('')

// ---------------------------------------------------------------- the sidebar itself
const shellState = await call('list', { owner: 'acceptance' })
const startCount = (shellState.sidebar ?? []).length
console.log(`  (the sidebar currently holds ${startCount} of this session's pages)`)
console.log('')

// ------------------------------------------------------------------ first open, no url
// This is the shape the host actually uses: documentStamp opens the view with no address.
const first = await call('ensureSidebar', { owner: 'acceptance' })
check('first open with NO url creates a page', first.ok === true && Number.isFinite(first.id),
  JSON.stringify({ ok: first.ok, id: first.id, created: first.created, via: first.via }).slice(0, 120))

// ------------------------------------------------------------------ second open, new tab
const second = await call('ensureSidebar', { owner: 'acceptance', newTab: true })
check('second open (newTab) creates a DIFFERENT page',
  second.ok === true && Number.isFinite(second.id) && second.id !== first.id,
  `id=${String(second.id)} vs first ${String(first.id)}`)

// ------------------------------------------------- how many pages did those two make?
const after = await call('list', { owner: 'acceptance' })
const made = (after.sidebar ?? []).length - startCount
check('exactly two pages were added — no spray', made === 2, `added ${made}`)

// --------------------------------------------------------------- both pages are operable
const ids = [first.id, second.id].filter(Number.isFinite)
let operable = 0
for (const id of ids) {
  try {
    await call('showTab', { viewId: id, owner: 'acceptance' }, 20_000)
    await new Promise(resolve => setTimeout(resolve, 600))
    const answer = await call('cdp', {
      id,
      method: 'Runtime.evaluate',
      params: { expression: 'location.href', returnByValue: true },
    }, 20_000)
    const href = answer?.result?.result?.value
    if (typeof href === 'string' && href !== '') operable += 1
    console.log(`        page ${id}: ${String(href).slice(0, 60)}`)
  } catch (error) {
    console.log(`        page ${id}: ${String(error.message).slice(0, 60)}`)
  }
}
check('both pages answer after being brought forward', operable === 2, `${operable}/2`)

// ------------------------------------------------------------------ session isolation
const other = await call('list', { owner: 'a-different-session' })
const leaked = (other.sidebar ?? []).filter(guest => ids.includes(guest.id)).length
check('another session cannot see these pages', leaked === 0, `${leaked} leaked`)

// ---------------------------------------------------------------------- settings write
const settings = await call('cdp', {
  id: ids[0],
  method: 'Runtime.evaluate',
  params: {
    expression: `fetch('/dsh-builtin-browser/settings').then(r => r.status + '')`,
    returnByValue: true,
    awaitPromise: true,
  },
}, 20_000).catch(() => undefined)
check('the settings route answers the page', String(settings?.result?.result?.value ?? '') === '200',
  String(settings?.result?.result?.value ?? 'no answer'))

// --------------------------------------------------------------------- closing a page
// The release chain: the host resolves titles through `list` WITH an owner, then asks the bridge
// to close them. Every one of those calls was missing its owner after the ledger landed, and the
// failure was silent — nothing closed and nothing was reported. So this checks the OUTCOME, and
// also that the other page survived, which is the isolation half of the same rule.
const doomed = ids[1]
const survivor = ids[0]
if (Number.isFinite(doomed) && Number.isFinite(survivor)) {
  const beforeClose = (await call('list', { owner: 'acceptance' })).sidebar ?? []
  const doomedTitle = beforeClose.find(g => g.id === doomed)?.title
  let closed = false
  try {
    const answer = await call('closeSidebarBrowser', {
      owner: 'acceptance',
      ...typeof doomedTitle === 'string' && doomedTitle !== '' ? { titles: [doomedTitle] } : {},
    }, 30_000)
    closed = Number(answer?.closed ?? 0) > 0
  } catch (error) {
    console.log(`        close attempt: ${String(error.message).slice(0, 60)}`)
  }
  await new Promise(resolve => setTimeout(resolve, 1_200))
  const afterClose = (await call('list', { owner: 'acceptance' })).sidebar ?? []
  check('closing one page actually closes it', closed && afterClose.every(g => g.id !== doomed),
    closed ? `closed=${String(closed)}` : 'the bridge reported nothing closed')
  check('and the other page survives', afterClose.some(g => g.id === survivor),
    `survivor ${String(survivor)} present: ${String(afterClose.some(g => g.id === survivor))}`)
}

console.log('')
const failed = results.filter(r => !r.ok)
console.log(failed.length === 0
  ? `  ALL ${results.length} CHECKS PASS`
  : `  ${failed.length} of ${results.length} FAILED: ${failed.map(f => f.name).join('; ')}`)
socket.end()
setTimeout(() => process.exit(failed.length === 0 ? 0 : 1), 1_000)
