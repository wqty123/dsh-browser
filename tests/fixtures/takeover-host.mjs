import { Context } from '@deepseek-ai/cordis'
import { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import { apply } from '../../src/tool-browser/index.ts'

export function takeoverHost(browser = {}) {
  const events = new Context(), tools = new Map(), routes = new Map(), audit = [], sections = [], disposers = []
  const native = []
  let turnOpen = true
  const approval = Object.create(ApprovalService.prototype)
  Object.defineProperty(approval, 'ctx', { value: events })
  approval.approvalStateOf = () => ({ turnOpen })
  approval.effectivePolicy = () => 'ask'
  const connection = { requestRejection: () => undefined }
  const webServer = { register: spec => { routes.set(spec.path, spec.handler); return () => routes.delete(spec.path) } }
  const ctx = {
    tools: { register: tool => tools.set(tool.name, tool) },
    systemPrompt: { section: section => sections.push(section) },
    get: name => ({ browser, approval, connection, webServer })[name],
    on: (...args) => events.on(...args),
    effect: callback => { const dispose = callback(); if (typeof dispose === 'function') disposers.push(dispose) },
    inject: (_dependencies, callback) => callback(ctx),
  }
  apply(ctx)
  events.on('approval/request', request => new Promise(resolve => {
    let answerable = true
    const answer = decision => {
      if (!answerable) return
      answerable = false
      request.signal.removeEventListener('abort', abort)
      resolve(decision)
    }
    const abort = () => answer('cancelled')
    request.signal.addEventListener('abort', abort, { once: true })
    native.push({ request, answer, get answerable() { return answerable } })
    if (request.signal.aborted) abort()
  }))
  const controller = new AbortController()
  const exec = { signal: controller.signal, callId: 'takeover-call', agent: {
    id: 'session-owner', session: { append: (kind, data) => audit.push({ kind, ...data }) },
  } }
  return { tools, routes, native, audit, sections, controller, exec, setTurnOpen(value) { turnOpen = value },
    dispose() { controller.abort(); for (const dispose of disposers.reverse()) dispose() } }
}

export async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('takeover test condition timed out')
}
