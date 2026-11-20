import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { createReferenceService } from '../../lib/browser-reference/service.js'
import { createReferenceRouteHandlers } from '../../lib/browser-electron/reference-route.js'
import { WEB_SOURCE_ROUTE } from '../../lib/reference-source.js'
import { registerWebGuest } from '../../lib/web-guest.js'
import { apply } from '../../lib/tool-browser/index.js'

export async function webReferenceHttp() {
  const home = mkdtempSync(join(tmpdir(), 'web-reference-http-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const context = new Context()
  class WebBrowser extends Service {
    constructor() { super(context, 'browser') }
    exists() { return false }
    execute() { throw new Error('web reference must not use a CDP session') }
  }
  new WebBrowser()
  const browser = context.get('browser')
  const service = createReferenceService(browser)
  const handlers = createReferenceRouteHandlers({ service })
  const routes = new Map([
    [WEB_SOURCE_ROUTE, handlers.source],
    ['/dsh-builtin-browser/reference/capture', handlers.capture],
    ['/dsh-builtin-browser/reference/reveal', handlers.reveal],
  ])
  registerWebGuest({ inject(_names, install) { install({ effect: fn => fn(), webServer: { register(route) { routes.set(route.path, route.handler); return () => {} } } }) } })
  const tools = new Map()
  apply({ tools: { register: tool => tools.set(tool.name, tool) }, systemPrompt: { section() {} }, effect() {}, get: name => context.get(name) }, { surface: 'tools' })
  const server = createServer((req, res) => {
    const handler = routes.get(new URL(req.url, 'http://localhost').pathname)
    if (!handler) { res.writeHead(404); res.end(); return }
    Promise.resolve(handler(req, res)).catch(error => res.destroy(error))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const call = (path, body, headers = {}) => new Promise((resolve, reject) => {
    const req = request(new URL(path, baseUrl), { method: body === undefined ? 'GET' : 'POST', headers: {
      origin: baseUrl, 'content-type': 'application/json', ...headers,
    } }, async res => {
      const chunks = []
      for await (const chunk of res) chunks.push(chunk)
      const text = Buffer.concat(chunks).toString()
      resolve({ status: res.statusCode, text, headers: res.headers, json: () => JSON.parse(text) })
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
  return {
    baseUrl, service, call, distinctBrowserProxies: browser !== context.get('browser'),
    source: (body, headers) => call(WEB_SOURCE_ROUTE, body, headers),
    reveal: (referenceId, owner = 'session-owner', extra = {}) => tools.get('dsh_browser_reference_reveal').execute({ referenceId, ...extra }, { agent: { id: owner }, signal: new AbortController().signal }),
    async close() {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      rmSync(home, { recursive: true, force: true })
    },
  }
}
