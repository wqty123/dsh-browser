import { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { apply } from '../../src/tool-browser/index.ts'

/** rc.5 ask-policy approval contract, supplied by the host in production. */
export class ApprovalContract {
  async request(request) {
    const session = request.agent.session
    if (!this.approvalStateOf(session).turnOpen) throw new Error('approval.request() outside an open turn')
    const id = randomUUID()
    session.append('approval/asked', { id, toolName: request.toolName,
      ...request.callId === undefined ? {} : { callId: request.callId },
      ...request.reason === undefined ? {} : { reason: request.reason } })
    const outcome = await this.decide(request)
    session.append('approval/decided', { id, outcome })
    return outcome
  }

  async decide(request) {
    const { signal } = request
    if (signal?.aborted) return 'cancelled'
    const answer = Promise.resolve().then(() => this.ctx.waterfall('approval/request', request, () => Promise.resolve('unavailable')))
      .then(outcome => ['allowed-once', 'rejected', 'cancelled', 'unavailable'].includes(outcome) ? outcome : 'unavailable', () => 'unavailable')
    if (!signal) return answer
    return new Promise(resolve => {
      const abort = () => { signal.removeEventListener('abort', abort); resolve('cancelled') }
      signal.addEventListener('abort', abort, { once: true })
      void answer.then(outcome => { signal.removeEventListener('abort', abort); resolve(outcome) })
    })
  }
}

export function takeoverHost(browser = {}, ApprovalService = ApprovalContract) {
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
  apply(ctx, { surface: 'tools' })
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
  return { ctx, tools, routes, native, audit, sections, controller, exec, setTurnOpen(value) { turnOpen = value },
    dispose() { controller.abort(); for (const dispose of disposers.reverse()) dispose() } }
}

export async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('takeover test condition timed out')
}
