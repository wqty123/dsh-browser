// A reference link must point at the site, never at this machine's guest proxy.
//
// The capture runs inside the guest document, where every `<a href>` has been rewritten to
// `<GUEST_ROUTE>?u=<real>`. The projection is what the model reads and what the composer renders,
// so a proxy URL surfaced there as a blue `http://127.0.0.1:<port>/…` link inside the user's own
// message.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GUEST_ROUTE } from '../assets/browser-policy.mjs'
import { renderReferenceText } from '../src/reference-text.ts'

const link = href => [{ type: 'paragraph', children: [{ type: 'link', href, children: [{ type: 'text', text: '开' }] }] }]

test('a proxied link projects the site URL', () => {
  const real = 'https://www.baidu.com/s?wd=open'
  const proxied = `http://127.0.0.1:3080${GUEST_ROUTE}?u=${encodeURIComponent(real)}&runtime=3&storage-context=x`
  const text = renderReferenceText(link(proxied))
  assert.ok(text.includes(real), text)
  assert.ok(!text.includes('127.0.0.1'), 'the proxy host never reaches the message')
})

test('a direct link is left alone', () => {
  const text = renderReferenceText(link('https://example.test/a?b=1'))
  assert.ok(text.includes('https://example.test/a?b=1'), text)
})

test('an unparseable proxied href keeps its literal value instead of throwing', () => {
  const text = renderReferenceText(link(`${GUEST_ROUTE}?u=%E0%A4%A`))
  assert.equal(typeof text, 'string')
})
