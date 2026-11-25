/**
 * Browser Use P1: dsh_browser_code end to end on a real headless Chromium against local fixture
 * pages (complex forms, pagination, file upload, OAuth manual takeover, Shadow DOM, Canvas and
 * cell timeout/cancel). Gated on DSH_TEST_CHROME like the other real-browser suites.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { codeBrowser, fixtureSite, ITEMS } from './fixtures/browser-use-e2e.mjs'

const skip = process.env.DSH_TEST_CHROME ? false : 'DSH_TEST_CHROME not set'
const ok = result => { assert.equal(result.ok, true, result.output); return result }

test('complex form: labelled, placeholder, dependent select, radio, controlled input, validation and submit', { skip, timeout: 60000 }, async t => {
  const site = await fixtureSite(t)
  const { run } = await codeBrowser(t)
  ok(await run(`await goto_url(${JSON.stringify(site.url('/form'))})
await fill([{ label: 'Full name', value: 'Alice Zhang' }, { label: 'Email', value: 'alice@example.test' }, { placeholder: 'Phone number', value: '+86 10 5555' }])
await select('#country', 'Japan')
await wait_for_element('#region:not([disabled]) option')
await select('#region', 'Osaka')
await fill([{ name: 'plan', kind: 'radio', value: 'pro' }, { label: 'Notes', kind: 'textarea', value: 'line one\\nline two' }, { label: 'Nickname', value: '  ally ' }])
await click('Create account')
print(await js('document.getElementById("error").textContent'))`))
  assert.equal(site.state.forms.length, 0, 'client-side validation blocked the first submit')
  const done = ok(await run(`await fill([{ label: 'I accept the terms', kind: 'checkbox', value: 'true' }])
await click('Create account')
await wait_for_element('#echo')
JSON.parse(await js('document.getElementById("echo").textContent'))`))
  assert.match(done.output, /Account created|alice@example\.test/)
  assert.deepEqual(site.state.forms, [{ full: 'Alice Zhang', email: 'alice@example.test', phone: '+86 10 5555', country: 'jp', region: 'Osaka',
    plan: 'pro', notes: 'line one\r\nline two', nick: 'ALLY', terms: 'yes' }])
})

test('long form below the fold: clicking Submit order posts the form and keeps the tab intact', { skip, timeout: 60000 }, async t => {
  const site = await fixtureSite(t)
  const { run } = await codeBrowser(t)
  const done = ok(await run(`await goto_url(${JSON.stringify(site.url('/long-form'))})
await fill([
  { name: 'custname', value: 'Bob' },
  { name: 'custtel', value: '555-0100' },
  { name: 'custemail', value: 'bob@example.test' },
  { name: 'size', kind: 'radio', value: 'large' },
  { name: 'topping', kind: 'checkbox', value: 'true' },
  { name: 'comments', kind: 'textarea', value: 'Ring bell' },
])
await click('Submit order')
await wait_for_text('bob@example.test')
const tabs = await list_tabs()
const body = JSON.parse(await js('document.body.innerText'))
JSON.stringify({ tabCount: tabs.length, url: tabs[0]?.url, form: body.form })`))
  const summary = JSON.parse(done.output.trim().split('\n').at(-1))
  assert.equal(summary.tabCount, 1, 'no stray about:blank tab created on submit')
  assert.equal(summary.url, site.url('/long-form'))
  assert.equal(site.state.forms.length, 1, 'clicking Submit order posted to the server')
  assert.deepEqual(summary.form, {
    custname: 'Bob', custtel: '555-0100', custemail: 'bob@example.test',
    size: 'large', topping: 'bacon', comments: 'Ring bell',
  })
})

test('pagination: follows Next until it disappears, and a Load more feed until it is exhausted', { skip, timeout: 60000 }, async t => {
  const site = await fixtureSite(t)
  const { run } = await codeBrowser(t)
  const paged = ok(await run(`await goto_url(${JSON.stringify(site.url('/items'))})
const seen = []
for (let guard = 0; guard < 10; guard++) {
  seen.push(...await js('[...document.querySelectorAll(".item")].map(li => li.textContent)'))
  if (!await js('!!document.querySelector("a[rel=next]")')) break
  await click('Next ›')
  await wait_for_load()
}
print(JSON.stringify(seen))
await back()
print((await page_info()).url)`))
  const [list, url] = paged.output.trim().split('\n').slice(-2)
  assert.deepEqual(JSON.parse(list), ITEMS)
  assert.equal(url, site.url('/items?page=2'))
  const feed = ok(await run(`await goto_url(${JSON.stringify(site.url('/feed'))})
await wait_for_element('#feed .item')
for (let guard = 0; guard < 10 && await js('!!document.getElementById("more")'); guard++) {
  const before = await js('document.querySelectorAll("#feed .item").length')
  await click('#more')
  for (let i = 0; i < 40 && await js('document.querySelectorAll("#feed .item").length') === before; i++) await sleep(50)
}
JSON.stringify(await js('[...document.querySelectorAll("#feed .item")].map(li => li.textContent)'))`))
  assert.deepEqual(JSON.parse(feed.output.trim().split('\n').at(-1)), ITEMS)
})

test('file upload: a workspace file reaches the server byte for byte; a file outside the workspace is refused', { skip, timeout: 60000 }, async t => {
  const site = await fixtureSite(t)
  const { run, workspace } = await codeBrowser(t)
  const content = Buffer.from('id,name\n1,Alice\n2,Bob\n')
  const path = join(workspace, 'report.csv')
  writeFileSync(path, content)
  const outside = join(tmpdir(), `p1-outside-${process.pid}.txt`)
  writeFileSync(outside, 'secret')
  t.after(() => rmSync(outside, { force: true }))
  const result = ok(await run(`await goto_url(${JSON.stringify(site.url('/upload'))})
try { await upload_file('#file', ${JSON.stringify(outside)}) } catch (error) { print('refused: ' + error.message) }
await upload_file('#file', ${JSON.stringify(path)})
print(await js('document.getElementById("picked").textContent'))
await click('Upload')
await wait_for_element('.file')
await js('document.querySelector(".file").textContent')`))
  assert.match(result.output, /refused: .*outside the task workspace/)
  assert.match(result.output, new RegExp(`picked: report\\.csv:${content.length}`))
  assert.deepEqual(site.state.uploads, [{ field: 'attachment', filename: 'report.csv', size: content.length, sha256: createHash('sha256').update(content).digest('hex') }])
})

test('OAuth manual takeover: the agent hands the provider sign-in to the human, a skip is not success, a done resumes on the signed-in page', { skip, timeout: 90000 }, async t => {
  const site = await fixtureSite(t)
  const requests = []
  const answers = ['rejected', 'allowed-once']
  const approval = {
    request: async request => {
      requests.push(request)
      const answer = answers.shift()
      if (answer === 'allowed-once') {
        // The human signs in at the provider; its page notices and redirects back through the callback.
        site.state.oauth.approved = true
        for (let i = 0; i < 100 && site.state.oauth.tokens.length === 0; i++) await new Promise(done => setTimeout(done, 50))
        await new Promise(done => setTimeout(done, 300))
      }
      return answer
    },
  }
  const { run } = await codeBrowser(t, { approval })
  const skipped = ok(await run(`await goto_url(${JSON.stringify(site.url('/app'))})
await click('Sign in with Example ID')
await wait_for_element('input[type=password]')
const first = await tools.dsh_browser_request_takeover({ reason: 'Sign in to Example ID', instructions: 'Enter the password and complete the human check' })
print(first.outcome)
await js('document.getElementById("robot").checked')`))
  assert.deepEqual(skipped.output.trim().split('\n').slice(-2), ['skipped', 'false'], 'a skipped takeover is reported as skipped and the human check is left alone')
  assert.equal(site.state.oauth.tokens.length, 0)
  const done = ok(await run(`const second = await tools.dsh_browser_request_takeover({ reason: 'Sign in to Example ID' })
print(second.outcome)
print(second.page.url)
print(second.page.fresh)
print(second.page.title)
await js('document.getElementById("who").textContent')`))
  assert.deepEqual(done.output.trim().split('\n').slice(-5), ['done', site.url('/app'), 'true', 'Dashboard', 'alice@example.test'])
  assert.equal(requests.length, 2)
  assert.ok(requests.every(request => request.toolName === 'dsh_browser_request_takeover' && /Sign in to Example ID/.test(request.displayReason.en)))
  assert.match(requests[0].displayReason.en, /complete the human check/)
  assert.deepEqual(site.state.oauth.tokens, ['tok-1'])
})

test('Shadow DOM: read, find, type and click reach nested open shadow roots and slotted content', { skip, timeout: 60000 }, async t => {
  const site = await fixtureSite(t)
  const { run } = await codeBrowser(t)
  const result = ok(await run(`await goto_url(${JSON.stringify(site.url('/shadow'))})
const text = await read()
print(text.includes('Outer shadow heading'), text.includes('Slotted light-DOM note'))
print(await find('Continue in shadow'))
await type('#user', 'bob')
await click('Continue in shadow')
await js('document.getElementById("status").textContent')`))
  assert.match(result.output, /^true true$/m)
  assert.match(result.output, /Continue in shadow @ \d+,\d+/)
  assert.equal(result.output.trim().split('\n').at(-1), 'shadow user: bob')
})

test('Canvas: a screenshot is returned and a coordinate click lands as a trusted event on the drawn control', { skip, timeout: 60000 }, async t => {
  const site = await fixtureSite(t)
  const { run } = await codeBrowser(t)
  const result = ok(await run(`await goto_url(${JSON.stringify(site.url('/canvas'))})
await screenshot()
const before = await js('board.toDataURL()')
const box = await js('(() => { const r = board.getBoundingClientRect(); return { x: r.left + board.clientLeft, y: r.top + board.clientTop } })()')
await click_at_xy(box.x + 320, box.y + 100)
await click_at_xy(box.x + 40, box.y + 40)
print(before !== await js('board.toDataURL()'))
JSON.stringify(await js('canvasHits()'))`))
  assert.equal(result.images.length, 1)
  const hits = JSON.parse(result.output.trim().split('\n').at(-1))
  assert.deepEqual(hits.map(hit => [hit.inside, hit.trusted]), [[true, true], [false, true]])
  assert.ok(Math.abs(hits[0].x - 320) <= 1 && Math.abs(hits[0].y - 100) <= 1, JSON.stringify(hits[0]))
  assert.match(result.output, /^true$/m, 'the canvas redrew after the hit')
})

test('timeout/cancel: a deadline or a cancel keeps printed output and the trace, and the tab stays usable', { skip, timeout: 90000 }, async t => {
  const site = await fixtureSite(t)
  const { run } = await codeBrowser(t)
  const items = JSON.stringify(site.url('/items'))
  ok(await run(`await goto_url(${JSON.stringify(site.url('/slow-script'))}); const kept = 1; 'ready'`))
  const deadline = await run(`print('before wait')
await wait_for_element('#never-appears', 30000)
print('unreachable')`, { timeoutMs: 1500 })
  assert.equal(deadline.ok, false)
  assert.match(deadline.output, /^before wait\nError: cell exceeded its 1500ms deadline; the REPL was restarted/)
  assert.doesNotMatch(deadline.output, /unreachable/)
  assert.deepEqual(deadline.trace, [{ tool: 'dsh_browser_wait', status: 'interrupted' }])
  let started = Date.now()
  const afterDeadline = ok(await run(`print(typeof kept); await goto_url(${items}); (await page_info()).title`))
  assert.deepEqual(afterDeadline.output.trim().split('\n').slice(-1), ['Items page 1 of 3'])
  assert.match(afterDeadline.output, /^undefined$/m, 'the restarted REPL lost its variables, as the result said')
  assert.ok(Date.now() - started < 8000, `recovered in ${Date.now() - started}ms`)

  // Cancel a navigation the server never answers, then navigate again in the same tab.
  const controller = new AbortController()
  setTimeout(() => controller.abort(new Error('user stopped')), 1000)
  const cancelled = await run(`print('navigating')
await goto_url(${JSON.stringify(site.url('/hang'))})
print('unreachable')`, { signal: controller.signal })
  assert.equal(cancelled.ok, false)
  assert.match(cancelled.output, /^navigating\nError: cell cancelled/)
  assert.deepEqual(cancelled.trace.map(entry => entry.tool), ['dsh_browser_open'])
  started = Date.now()
  const afterCancel = ok(await run(`await goto_url(${items}); (await page_info()).title`))
  assert.equal(afterCancel.output.trim().split('\n').at(-1), 'Items page 1 of 3')
  assert.ok(Date.now() - started < 8000, `a cancelled navigation must not stall the tab into quarantine (took ${Date.now() - started}ms)`)

  // A renderer stuck in page script past the cell deadline: the deadline still returns, and the tab recovers.
  const busy = await run(`await goto_url(${JSON.stringify(site.url('/slow-script'))})
print('clicking')
await js('(() => { const end = Date.now() + 4000; while (Date.now() < end); return 1 })()')`, { timeoutMs: 1500 })
  assert.equal(busy.ok, false)
  assert.match(busy.output, /clicking\nError: cell exceeded its 1500ms deadline/)
  const afterBusy = ok(await run(`await goto_url(${items}); (await page_info()).title`))
  assert.equal(afterBusy.output.trim().split('\n').at(-1), 'Items page 1 of 3')
})
