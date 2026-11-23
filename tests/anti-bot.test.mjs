/**
 * Anti-bot block handling, without a browser: the classifier, the recovery advice and the
 * fallback routes, plus the page-context detector compiling to valid JavaScript.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blockRetryDelayMs, challengeDetectSource, classifyBlock, fallbackRoutes, recoveryAdvice } from '../lib/browser/anti-bot.js'

test('human verifications go to the human, never to a retry', () => {
  for (const [evidence, kind] of [
    [{ widgets: ['recaptcha'] }, 'recaptcha'],
    [{ frames: 'https://newassets.hcaptcha.com/captcha/v1/abc' }, 'hcaptcha'],
    [{ widgets: ['turnstile'] }, 'turnstile'],
    [{ text: 'Press & Hold to confirm you are a human' }, 'perimeterx'],
    [{ text: '请向右滑动滑块完成验证' }, 'slider'],
    [{ text: '百度安全验证 请完成下方验证后继续操作' }, 'baidu-verify'],
    [{ title: 'Verify you are human', text: '' }, 'human-check'],
  ]) {
    const verdict = classifyBlock(evidence)
    assert.equal(verdict.blocked, true, JSON.stringify(evidence))
    assert.equal(verdict.kind, kind)
    assert.equal(verdict.recovery, 'takeover')
  }
})

test('a Cloudflare interstitial waits; refusals retry; network blocks are an environment limit', () => {
  assert.deepEqual(
    { ...classifyBlock({ status: 503, title: 'Just a moment...', text: 'Checking if the site connection is secure' }) },
    { blocked: true, kind: 'cloudflare', reason: 'Cloudflare "Just a moment" interstitial', recovery: 'wait', status: 503 })
  assert.equal(classifyBlock({ status: 403, title: 'Access Denied', text: 'You don\'t have permission to access this server.' }).recovery, 'retry')
  assert.equal(classifyBlock({ status: 429, text: 'Too many requests' }).kind, 'rate-limit')
  assert.equal(classifyBlock({ status: 403, text: '' }).kind, 'access-denied')
  const ip = classifyBlock({ status: 403, text: 'Your IP address has been blocked. Requests from hosting providers are not allowed.' })
  assert.equal(ip.kind, 'ip-block')
  assert.equal(ip.recovery, 'environment')
  assert.equal(classifyBlock({ status: 200, text: 'Our systems have detected unusual traffic from your computer network.' }).recovery, 'environment')
})

test('ordinary pages are not blocks, even when they mention the words', () => {
  assert.equal(classifyBlock({ status: 200, title: 'Docs', text: 'If you see "Access denied", check your token. Our CDN is forbidden from caching this.' }).blocked, false)
  assert.equal(classifyBlock({ status: 200, title: 'Sign in', text: 'Email Password Sign in', frames: 'https://www.google.com/recaptcha/api2/anchor?size=invisible' }).blocked, false)
  assert.equal(classifyBlock({ status: 404, text: 'Not found. '.repeat(10) }).blocked, false)
  assert.equal(classifyBlock({ status: 403, text: 'Members only. '.repeat(60) }).blocked, false)
})

test('every recovery has advice, and a clean page has none', () => {
  assert.equal(recoveryAdvice({ blocked: false }), '')
  assert.match(recoveryAdvice({ blocked: true, recovery: 'takeover' }), /never solve it.*dsh_browser_request_takeover/su)
  assert.match(recoveryAdvice({ blocked: true, recovery: 'environment' }), /environment limit.*do not retry/su)
  assert.match(recoveryAdvice({ blocked: true, recovery: 'retry' }), /fallback routes/u)
  assert.match(recoveryAdvice({ blocked: true, recovery: 'wait' }), /dsh_browser_wait/u)
})

test('fallback routes: the site API first, then search, then archives', () => {
  const reddit = fallbackRoutes('https://www.reddit.com/r/node/comments/abc/title/')
  assert.deepEqual(reddit.map(route => route.kind), ['api', 'search', 'search', 'archive', 'archive'])
  assert.equal(reddit[0].url, 'https://www.reddit.com/r/node/comments/abc/title.json')
  assert.equal(fallbackRoutes('https://github.com/acme/tool/issues/7')[0].url, 'https://api.github.com/repos/acme/tool/issues/7')
  assert.equal(fallbackRoutes('https://en.wikipedia.org/wiki/Web_scraping')[0].url, 'https://en.wikipedia.org/api/rest_v1/page/html/Web_scraping')
  assert.equal(fallbackRoutes('https://pypi.org/project/requests/')[0].url, 'https://pypi.org/pypi/requests/json')
  const plain = fallbackRoutes('https://shop.example/item/42?ref=x')
  assert.deepEqual(plain.map(route => route.kind), ['search', 'search', 'archive', 'archive'])
  assert.equal(plain[2].url, 'https://web.archive.org/web/2/https://shop.example/item/42?ref=x')
  assert.deepEqual(fallbackRoutes('about:blank'), [])
  assert.deepEqual(fallbackRoutes('not a url'), [])
})

test('the page-context detector is one self-contained expression, and the retry pause is tunable', () => {
  assert.doesNotThrow(() => new Function(`return ${challengeDetectSource()}`))
  const previous = process.env.DSH_BROWSER_BLOCK_RETRY_MS
  try {
    delete process.env.DSH_BROWSER_BLOCK_RETRY_MS
    assert.equal(blockRetryDelayMs(), 2500)
    process.env.DSH_BROWSER_BLOCK_RETRY_MS = '0'
    assert.equal(blockRetryDelayMs(), 0)
    process.env.DSH_BROWSER_BLOCK_RETRY_MS = '999999'
    assert.equal(blockRetryDelayMs(), 60000)
  } finally {
    if (previous === undefined) delete process.env.DSH_BROWSER_BLOCK_RETRY_MS
    else process.env.DSH_BROWSER_BLOCK_RETRY_MS = previous
  }
})
