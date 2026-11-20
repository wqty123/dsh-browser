import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { guestRuntimeScript } from '../src/browser-electron/guest-runtime.ts'
import { guestPath, relayTag } from '../src/browser-electron/guest-route.ts'

function page() {
  const requests = [], navigations = [], listeners = new Map(), observers = []
  class Element {
    nodeType = 1
    attributes = new Map()
    getAttribute(name) { return this.attributes.get(name) ?? null }
    hasAttribute(name) { return this.attributes.has(name) }
    setAttribute(name, value) { this.attributes.set(name, String(value)) }
  }
  class Form extends Element {
    tagName = 'FORM'
    fields = [['q', 'hello world'], ['page', '2']]
    submit() { this.submitted = true }
  }
  class XHR {
    headers = new Map()
    open(...args) { this.args = args }
    setRequestHeader(name, value) { this.headers.set(name, value) }
  }
  const location = { origin: 'https://dsh.example', href: 'https://dsh.example' + guestPath('https://ordinary.example/dir/page'),
    assign(url) { navigations.push(url) } }
  const history = { pushState(state, title, url) { location.href = new URL(url, location.href).href },
    replaceState(state, title, url) { location.href = new URL(url, location.href).href } }
  const context = {
    URL, URLSearchParams, Headers, Request, Element, HTMLFormElement: Form, XMLHttpRequest: XHR, location, history,
    FormData: class { constructor(form, submitter) { this.values = [...form.fields]; if (submitter) this.values.push(['button', 'search']) }
      [Symbol.iterator]() { return this.values[Symbol.iterator]() } },
    document: { addEventListener(name, listener) { listeners.set(name, listener) } }, navigator: {},
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this) }
      observe(target, options) { this.target = target; this.options = options }
    },
    fetch: async (input, init) => { requests.push({ input, init }); return new Response('ok') },
    addEventListener(name, listener) { listeners.set(name, listener) },
  }
  for (const [name, prop] of [['HTMLImageElement', 'src'], ['HTMLScriptElement', 'src'], ['HTMLIFrameElement', 'src'],
    ['HTMLLinkElement', 'href'], ['HTMLSourceElement', 'src']]) {
    context[name] = class extends Element {}
    Object.defineProperty(context[name].prototype, prop, { configurable: true,
      get() { return this.value }, set(value) { this.value = value } })
  }
  context.parent = { postMessage() {} }
  context.window = context
  vm.createContext(context)
  vm.runInContext(guestRuntimeScript('https://ordinary.example/dir/page'), context)
  return { context, requests, navigations, listeners, Element, Form, XHR, observers }
}

test('toProxy resolves relative, root-relative, absolute and URL values against the real page', () => {
  const { context } = page()
  const toProxy = context.__dshGuestToProxy
  for (const [input, expected] of [['api?q=1', 'https://ordinary.example/dir/api?q=1'],
    ['/search', 'https://ordinary.example/search'], ['//cdn.example/x', 'https://cdn.example/x'],
    ['https://other.example/x', 'https://other.example/x'],
    ['https://dsh.example/api', 'https://ordinary.example/api']]) {
    assert.equal(toProxy(input), guestPath(expected))
  }
  assert.equal(toProxy(new URL('https://other.example/x')), guestPath('https://other.example/x'))
  for (const value of ['data:text/plain,hi', 'blob:https://ordinary.example/uuid', 'javascript:void(0)', 'about:blank',
    guestPath('https://ordinary.example/x'), 'https://dsh.example' + guestPath('https://ordinary.example/x')]) {
    assert.equal(toProxy(value), value)
  }
  assert.equal(toProxy('http://['), 'http://[')
})

test('navigation metadata echoes the parent load identity without inventing completion', () => {
  const { context, listeners } = page()
  const sent = []
  context.parent.postMessage = data => sent.push(data)
  const receive = (loadId, source = context.parent) => listeners.get('message')({ source,
    data: { type: 'dsh.browser.guest.navigation.request', loadId } })
  receive(1, {})
  receive(0)
  receive('1')
  assert.equal(sent.length, 0)
  receive(1)
  assert.equal(sent[0].loadId, 1)
  assert.equal(sent[0].url, 'https://ordinary.example/dir/page')
  context.history.pushState({}, '', '/next')
  assert.equal(sent.at(-1).loadId, 1)
  assert.equal(sent.at(-1).url, 'https://ordinary.example/next')
  receive(2)
  assert.equal(sent.at(-1).loadId, 2)
})

test('fetch handles string, URL and Request inputs, preserving POST body and adding the subrequest marker', async () => {
  const { context, requests } = page()
  await context.fetch('/api', { method: 'POST', body: 'a=1', headers: { 'content-type': 'text/plain' } })
  await context.fetch(new URL('https://other.example/api'))
  await context.fetch(new Request('https://ordinary.example/post', { method: 'POST', body: 'body', headers: { authorization: 'Bearer site' } }))
  assert.equal(requests[0].input, guestPath('https://ordinary.example/api'))
  assert.equal(requests[0].init.body, 'a=1')
  assert.equal(requests[0].init.headers.get('content-type'), 'text/plain')
  assert.equal(requests[1].input, guestPath('https://other.example/api'))
  assert.equal(requests[2].input.url, 'https://dsh.example' + guestPath('https://ordinary.example/post'))
  assert.equal(await requests[2].input.text(), 'body')
  assert.equal(requests[2].init.headers.get('authorization'), 'Bearer site')
  for (const { init } of requests) assert.equal(init.headers.get('x-dsh-guest-sub'), '1')
})

test('query-only, fragment-only and empty URLs resolve against the real page, including after history changes', () => {
  const { context } = page()
  assert.equal(context.__dshGuestToProxy('?page=2'), guestPath('https://ordinary.example/dir/page?page=2'))
  assert.equal(context.__dshGuestToProxy(''), guestPath('https://ordinary.example/dir/page'))
  context.history.pushState({}, '', '/next/page?q=old#old')
  assert.equal(context.__dshGuestToProxy('?page=3'), guestPath('https://ordinary.example/next/page?page=3'))
  assert.equal(context.__dshGuestToProxy('#section'), guestPath('https://ordinary.example/next/page?q=old#section'))
  assert.equal(context.__dshGuestToProxy(''), guestPath('https://ordinary.example/next/page?q=old'))
  context.history.replaceState({}, '', '?replaced=1')
  assert.equal(context.location.href, 'https://dsh.example' + guestPath('https://ordinary.example/next/page?replaced=1'))
})

test('XHR and beacon stay in the proxy; window.open never impersonates a child by replacing its opener', () => {
  const { context, requests, navigations, XHR } = page()
  const xhr = new XHR()
  xhr.open('POST', '../api', false)
  assert.equal(xhr.args[1], guestPath('https://ordinary.example/api'))
  assert.equal(xhr.args[2], false)
  assert.equal(xhr.headers.get('x-dsh-guest-sub'), '1')
  assert.equal(context.navigator.sendBeacon('/metrics', 'payload'), true)
  assert.equal(requests[0].input, guestPath('https://ordinary.example/metrics'))
  assert.equal(requests[0].init.headers['x-dsh-guest-sub'], '1')
  assert.equal(requests[0].init.body, 'payload')
  assert.throws(() => context.open('next', '_blank'), error => error.name === 'NotSupportedError' && error.code === 'native-child-opener-unavailable')
  assert.deepEqual(navigations, [])
})

test('history updates the real resolution base and dynamic attributes and property setters are proxied', () => {
  const { context, Element } = page()
  context.history.pushState({}, '', '/next/page')
  assert.equal(context.location.href, 'https://dsh.example' + guestPath('https://ordinary.example/next/page'))
  assert.equal(context.__dshGuestToProxy('api'), guestPath('https://ordinary.example/next/api'))
  context.history.replaceState({}, '', '/replaced/page')
  const element = new Element()
  for (const attribute of ['src', 'href', 'action']) {
    element.setAttribute(attribute, 'asset')
    assert.equal(element.getAttribute(attribute), guestPath('https://ordinary.example/replaced/asset'))
  }
  for (const [name, prop] of [['HTMLImageElement', 'src'], ['HTMLScriptElement', 'src'], ['HTMLIFrameElement', 'src'],
    ['HTMLLinkElement', 'href'], ['HTMLSourceElement', 'src']]) {
    const node = new context[name]()
    node[prop] = '/asset'
    assert.equal(node[prop], guestPath('https://ordinary.example/asset'))
  }
})

test('anchor clicks and GET forms navigate self; POST forms retain native body encoding', () => {
  const { context, listeners, navigations, Element, Form } = page()
  const anchor = new Element()
  anchor.tagName = 'A'
  anchor.setAttribute('href', '../next')
  anchor.setAttribute('target', '_self')
  let prevented = false
  listeners.get('click')({ target: anchor, preventDefault() { prevented = true } })
  assert.equal(prevented, true)
  assert.equal(navigations.pop(), guestPath('https://ordinary.example/next'))
  const form = new Form()
  form.setAttribute('action', 'search?old=1')
  listeners.get('submit')({ target: form, preventDefault() {} })
  assert.equal(navigations.pop(), guestPath('https://ordinary.example/dir/search?q=hello+world&page=2'))
  form.setAttribute('method', 'POST')
  listeners.get('submit')({ target: form, preventDefault() { assert.fail('POST should submit natively') } })
  assert.equal(form.getAttribute('action'), guestPath('https://ordinary.example/dir/search?old=1'))
  assert.equal(form.getAttribute('target'), '_self')
  form.submit()
  assert.equal(form.submitted, true)
  const fetch = context.fetch
  vm.runInContext(guestRuntimeScript('https://ignored.example/'), context)
  assert.equal(context.fetch, fetch)
})

test('explicit noopener window.open, blank links and GET forms dispatch URL-only sidebar tabs without moving the opener', () => {
  const { context, listeners, navigations, Element, Form } = page()
  const requests = []
  context.parent.postMessage = data => { if (data.type === 'dsh.browser.guest.child.request') requests.push(data) }
  listeners.get('message')({ source: context.parent, data: { type: 'dsh.browser.guest.navigation.request', loadId: 7 } })
  assert.equal(context.open('../child', '_blank', 'noopener'), null)
  const link = new Element(); link.tagName = 'A'; link.setAttribute('href', '/linked'); link.setAttribute('target', '_blank')
  listeners.get('click')({ target: link, preventDefault() {} })
  const form = new Form(); form.setAttribute('target', '_blank'); form.setAttribute('action', '/search')
  let prevented = false
  listeners.get('submit')({ target: form, preventDefault() { prevented = true } })
  assert.equal(prevented, true)
  assert.deepEqual(requests.map(({ mode, url, loadId, requestId }) => [mode, url, loadId, requestId]), [
    ['url-only', 'https://ordinary.example/child', 7, 1],
    ['url-only', 'https://ordinary.example/linked', 7, 2],
    ['url-only', 'https://ordinary.example/search?q=hello+world&page=2', 7, 3],
  ])
  assert.deepEqual(navigations, [])
})

test('native opener, named targets, blank children, POST targets and unready tab owners fail explicitly without navigation', () => {
  const { context, listeners, navigations, Form } = page()
  assert.throws(() => context.open('next', '_blank', 'noopener'), error => error.code === 'sidebar-tab-owner-not-ready')
  const requests = []
  context.parent.postMessage = data => { if (data.type === 'dsh.browser.guest.child.request') requests.push(data) }
  listeners.get('message')({ source: context.parent, data: { type: 'dsh.browser.guest.navigation.request', loadId: 1 } })
  for (const args of [[], [''], ['about:blank'], ['next', 'login'], ['next', '_blank', 'noopener=0']]) {
    assert.throws(() => context.open(...args), error => error.code === 'native-child-opener-unavailable')
  }
  const form = new Form(); form.setAttribute('target', '_blank'); form.setAttribute('method', 'POST')
  listeners.get('submit')({ target: form, preventDefault() {} })
  form.submit()
  assert.notEqual(form.submitted, true)
  assert.ok(requests.every(request => request.mode === 'native-opener'))
  assert.deepEqual(navigations, [])
  assert.equal(vm.runInContext('window.open("/self", "_self") === window', context), true)
  assert.equal(navigations[0], guestPath('https://ordinary.example/self'))
})

test('installer tolerates missing optional APIs and safely embeds unusual URLs', () => {
  const context = { location: { origin: 'https://dsh.example', href: 'https://dsh.example/' } }
  context.window = context
  const source = guestRuntimeScript('https://ordinary.example/</script>')
  assert.equal(source.includes('</script>'), false)
  assert.doesNotThrow(() => vm.runInNewContext(source, context))
})

test('download anchors, including empty download attributes, retain native browser handling', () => {
  const { listeners, navigations, Element } = page()
  for (const filename of ['', 'report.pdf']) {
    const anchor = new Element()
    anchor.tagName = 'A'
    anchor.setAttribute('href', '/download/report.pdf')
    anchor.setAttribute('download', filename)
    listeners.get('click')({ target: { parentNode: anchor }, preventDefault() { assert.fail('download intercepted') } })
    assert.equal(navigations.length, 0)
  }
})

test('the reference relay sends data to the parent without authenticated requests', async () => {
  const { context, requests, listeners } = page()
  const tag = relayTag('owner')
  vm.runInContext(tag.slice(tag.indexOf('>') + 1, tag.lastIndexOf('</script>')), context)
  const sent = []
  context.parent.postMessage = (intent, target) => sent.push({ intent, target })
  listeners.get('message')({ source: vm.runInContext('window', context), data: { type: 'dsh-browser-ref:intent', comment: 'quote' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(requests.length, 0)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].intent.comment, 'quote')
  assert.equal(sent[0].target, '*')
})

test('observer proxies parsed resource subtrees and attribute mutations without rewrite loops', () => {
  const { context, Element, observers } = page()
  const observer = observers[0]
  assert.equal(observer.target, context.document)
  assert.equal(observer.options.childList, true)
  assert.equal(observer.options.subtree, true)
  assert.equal(observer.options.attributes, true)
  assert.deepEqual(Array.from(observer.options.attributeFilter), ['src', 'href', 'srcset', 'poster', 'action'])
  const link = new Element()
  link.tagName = 'LINK'
  link.attributes.set('href', '/rp/style.css')
  const image = new Element()
  image.attributes.set('src', '/rp/image.png')
  image.attributes.set('srcset', '/rp/a.png 1x,/rp/b.png 2x, data:image/png;base64,AA 3x')
  const video = new Element()
  video.attributes.set('poster', '/cdt/dictionary/poster.png')
  const anchor = new Element()
  anchor.tagName = 'A'
  anchor.attributes.set('href', '/search')
  link.querySelectorAll = () => [image, video, anchor]
  let writes = 0
  for (const node of [link, image, video, anchor]) {
    const set = node.setAttribute
    node.setAttribute = function(...args) { writes++; return set.apply(this, args) }
  }
  observer.callback([{ type: 'childList', addedNodes: [link, { nodeType: 3 }] }])
  assert.equal(link.getAttribute('href'), guestPath('https://ordinary.example/rp/style.css'))
  assert.equal(image.getAttribute('src'), guestPath('https://ordinary.example/rp/image.png'))
  assert.equal(image.getAttribute('srcset'), `${guestPath('https://ordinary.example/rp/a.png')} 1x,${guestPath('https://ordinary.example/rp/b.png')} 2x, data:image/png;base64,AA 3x`)
  assert.equal(video.getAttribute('poster'), guestPath('https://ordinary.example/cdt/dictionary/poster.png'))
  assert.equal(anchor.getAttribute('href'), '/search')
  assert.equal(writes, 4)
  observer.callback([link, image, video].map(target => ({ type: 'attributes', target })))
  assert.equal(writes, 4)
  image.attributes.set('src', '/rp/changed.png')
  observer.callback([{ type: 'attributes', target: image }])
  assert.equal(image.getAttribute('src'), guestPath('https://ordinary.example/rp/changed.png'))
  assert.equal(writes, 5)
  image.attributes.set('srcset', '/rp/a.png, /rp/b.png,   ')
  observer.callback([{ type: 'attributes', target: image }])
  assert.equal(image.getAttribute('srcset'), `${guestPath('https://ordinary.example/rp/a.png')}, ${guestPath('https://ordinary.example/rp/b.png')},   `)
  assert.equal(writes, 6)
  for (const value of ['#fragment', 'data:image/png;base64,AA', 'blob:https://ordinary.example/uuid', 'about:blank', 'javascript:void(0)', '']) {
    image.attributes.set('src', value)
    observer.callback([{ type: 'attributes', target: image }])
    assert.equal(image.getAttribute('src'), value)
  }
  observer.callback([{ type: 'childList', addedNodes: [] }])
  assert.doesNotThrow(() => observer.callback([{ type: 'attributes', target: { nodeType: 1 } }]))
  assert.equal(writes, 6)
  assert.equal(observers.length, 1)
  vm.runInContext(guestRuntimeScript('https://ignored.example/'), context)
  assert.equal(observers.length, 1)
})
