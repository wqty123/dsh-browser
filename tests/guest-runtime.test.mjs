import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { guestRuntimeScript } from '../src/browser-electron/guest-runtime.ts'
import { guestPath, relayTag } from '../src/browser-electron/guest-route.ts'

function page() {
  const requests = [], navigations = [], listeners = new Map()
  class Element {
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
    fetch: async (input, init) => { requests.push({ input, init }); return new Response('ok') },
    addEventListener(name, listener) { listeners.set(name, listener) },
  }
  for (const [name, prop] of [['HTMLImageElement', 'src'], ['HTMLScriptElement', 'src'], ['HTMLIFrameElement', 'src'],
    ['HTMLLinkElement', 'href'], ['HTMLSourceElement', 'src']]) {
    context[name] = class extends Element {}
    Object.defineProperty(context[name].prototype, prop, { configurable: true,
      get() { return this.value }, set(value) { this.value = value } })
  }
  context.window = context
  vm.createContext(context)
  vm.runInContext(guestRuntimeScript('https://ordinary.example/dir/page'), context)
  return { context, requests, navigations, listeners, Element, Form, XHR }
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

test('XHR, beacon and window.open stay in the proxy', () => {
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
  context.open('next')
  assert.equal(navigations[0], guestPath('https://ordinary.example/dir/next'))
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

test('installer tolerates missing optional APIs and safely embeds unusual URLs', () => {
  const context = { location: { origin: 'https://dsh.example', href: 'https://dsh.example/' } }
  context.window = context
  const source = guestRuntimeScript('https://ordinary.example/</script>')
  assert.equal(source.includes('</script>'), false)
  assert.doesNotThrow(() => vm.runInNewContext(source, context))
})

test('the reference relay bypasses site request interception', async () => {
  const { context, requests } = page()
  const tag = relayTag('owner')
  vm.runInContext(tag.slice(tag.indexOf('>') + 1, tag.lastIndexOf('</script>')), context)
  context.__dshRefIntents.push({ comment: 'quote' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(requests[0].input, '/dsh-builtin-browser/reference/capture')
  assert.equal(JSON.parse(requests[0].init.body).sessionId, 'owner')
})
