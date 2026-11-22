import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rewriteCss } from '../src/browser-electron/guest-css.ts'
import { guestPath, rewriteDocument } from '../src/browser-electron/guest-route.ts'

const base = new URL('https://ordinary.example/styles/site.css')
const proxy = raw => {
  if (raw === '' || raw.startsWith('#')) return undefined
  try {
    const url = new URL(raw, base)
    return /^https?:$/u.test(url.protocol) ? guestPath(url.href) : undefined
  } catch { return undefined }
}

test('CSS URLs share original-resource resolution across imports, fonts and image sets', () => {
  for (const [input, absolute] of [
    ['../fonts/font.woff2?v=4.7.0', 'https://ordinary.example/fonts/font.woff2?v=4.7.0'],
    ['/assets/logo.png', 'https://ordinary.example/assets/logo.png'],
    ['//cdn.example/logo.png', 'https://cdn.example/logo.png'],
    ['https://cdn.example/logo.png', 'https://cdn.example/logo.png'],
    ['image\\ name.png', 'https://ordinary.example/styles/image%20name.png'],
    ['image\\)name.png', 'https://ordinary.example/styles/image)name.png'],
    ['\\2e\\2e /font.woff2', 'https://ordinary.example/font.woff2'],
  ]) {
    const expected = guestPath(absolute)
    assert.equal(rewriteCss(`a{background:url(${input})}`, proxy), `a{background:url("${expected}")}`)
    for (const quote of ['"', "'"]) {
      assert.equal(rewriteCss(`@import /* theme */ ${quote}${input}${quote};`, proxy), `@import /* theme */ "${expected}";`)
      assert.equal(rewriteCss(`src:URL( ${quote}${input}${quote} )`, proxy), `src:url("${expected}")`)
    }
  }
  assert.equal(rewriteCss('background:image-set("one.png" 1x, url(two.png) 2x, "three.avif" type("image/avif"))', proxy),
    `background:image-set("${guestPath('https://ordinary.example/styles/one.png')}" 1x, url("${guestPath('https://ordinary.example/styles/two.png')}") 2x, "${guestPath('https://ordinary.example/styles/three.avif')}" type("image/avif"))`)
})

test('CSS leaves empty, non-network, comments, strings and malformed URLs unchanged', () => {
  for (const css of ['', '/* url(secret.png) */', 'a:after{content:"url(secret.png)"}',
    'src:local("font name")', 'background:url()', 'background:url(#gradient)',
    'src:url(data:font/woff2;base64,AA==)', 'src:url("DATA:font/woff2;base64,AA==")',
    'background:url(blob:https://ordinary.example/id)', 'background:url("http://[")',
    '@import "unfinished', 'background:url("unfinished', 'background:url(unfinished', '/* unfinished',
  ]) assert.equal(rewriteCss(css, proxy), css)
})

test('documents use the document URL for attributes and inline CSS, not the proxy path', () => {
  const html = '<link href="styles/site.css"><img src="/assets/logo.png"><style>@import "theme.css"; a{background:url( images/bg.png )}</style><p style="background:url(&quot;/images/inline.png&quot;)">Hi</p>'
  const result = rewriteDocument(html, new URL('https://ordinary.example/docs/article'))
  for (const target of ['https://ordinary.example/docs/styles/site.css', 'https://ordinary.example/assets/logo.png',
    'https://ordinary.example/docs/theme.css', 'https://ordinary.example/docs/images/bg.png', 'https://ordinary.example/images/inline.png']) {
    assert.ok(result.includes(guestPath(target)), target)
  }
  assert.ok(result.includes('style="background:url(&#34;'))
  assert.equal(rewriteDocument('<style>a:after{content:"url(secret.png)"}</style>', base), '<style>a:after{content:"url(secret.png)"}</style>')
})
