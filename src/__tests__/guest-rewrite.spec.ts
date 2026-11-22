/**
 * The proxy must keep a page's own assets inside itself.
 *
 * "The proxy cannot render" was, concretely, this: an asset reference the rewriter did not recognise
 * stayed relative, so the browser asked the DSH host for it and got a 404 — the document rendered while
 * its scripts and styles never arrived. The three quote forms are therefore asserted one by one, since
 * real pages use all three and only two used to be handled.
 */
import { describe, expect, it } from 'vitest'
import { guestPath, rewriteDocument } from '../browser-electron/guest-route.ts'

const base = new URL('https://example.test/dir/page.html')

/** Resolve what the document would request, to assert the proxy path rather than the literal text. */
function rewritten(html: string): string {
  return rewriteDocument(html, base)
}

describe('document rewriting', () => {
  it('proxies a double-quoted asset', () => {
    expect(rewritten('<script src="/a.js"></script>')).toContain(`src="${guestPath('https://example.test/a.js')}"`)
  })

  it('proxies a single-quoted asset', () => {
    expect(rewritten("<link href='/a.css'>")).toContain(`href='${guestPath('https://example.test/a.css')}'`)
  })

  it('proxies an UNQUOTED asset, quoting the rewritten value', () => {
    // The form example.com uses for its only script. Missing this left the page script-less.
    const out = rewritten('<script src=/s.js></script>')
    expect(out).toBe(`<script src="${guestPath('https://example.test/s.js')}"></script>`)
  })

  it('resolves relative assets against the page, not the host', () => {
    const out = rewritten('<img src=pic.png>')
    expect(out).toContain(guestPath('https://example.test/dir/pic.png'))
  })

  it('proxies a protocol-relative asset', () => {
    const out = rewritten('<script src=//cdn.test/x.js></script>')
    expect(out).toContain(guestPath('https://cdn.test/x.js'))
  })

  it('leaves things it must not touch alone', () => {
    const html = '<a href="#top">t</a><img src="data:image/gif;base64,AA"><a href="javascript:void(0)">j</a>'
    expect(rewritten(html)).toBe(html)
  })

  it('preserves target="_blank" for the guest runtime child-tab handler', () => {
    // The guest runtime intercepts _blank clicks/forms and dispatches URL-only child tabs.
    expect(rewritten('<a href="/x" target="_blank">x</a>')).toContain('target="_blank"')
  })

  it('strips integrity attribute from proxied stylesheet links', () => {
    const out = rewritten('<link rel="stylesheet" href="/a.css" integrity="sha384-abc">')
    expect(out).toContain(`href="${guestPath('https://example.test/a.css')}"`)
    expect(out).not.toContain('integrity=')
  })

  it('proxies a srcset candidate list', () => {
    const out = rewritten('<img srcset="/a.png 1x, /b.png 2x">')
    expect(out).toContain(guestPath('https://example.test/a.png'))
    expect(out).toContain(guestPath('https://example.test/b.png'))
  })

  it('proxies a CSS url()', () => {
    const out = rewritten('<style>body{background:url(/bg.png)}</style>')
    expect(out).toContain(guestPath('https://example.test/bg.png'))
  })

  it('rewrites a form action for the relay script', () => {
    const html = '<form action="/search"></form>'
    expect(rewritten(html)).toBe(`<form action="${guestPath('https://example.test/search')}"></form>`)
  })
})
