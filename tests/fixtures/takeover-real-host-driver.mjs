import { randomUUID } from 'node:crypto'

export const inject = ['webServer', 'connection', 'sessionController', 'workspaceController', 'agents', 'tools']

export function apply(ctx) {
  const results = new Map(), controllers = new Set()
  let agent, turn = 0
  ctx.effect(() => () => { for (const controller of controllers) controller.abort() })
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/takeover-real-host-driver', async handler(request, response) {
    if (ctx.connection.requestRejection(request) !== undefined) { response.writeHead(403); response.end(); return }
    try {
      let raw = ''
      for await (const chunk of request) raw += chunk
      const data = JSON.parse(raw || '{}')
      let value
      if (data.operation === 'create') {
        const workspace = await ctx.workspaceController.initializeDefault(new AbortController().signal)
        value = await ctx.sessionController.create({ workspaceId: workspace.id })
        agent = ctx.agents.get(value.sessionId)
      } else if (data.operation === 'turn') {
        agent.session.append('turn/start', { turn: ++turn })
        value = { turn }
      } else if (data.operation === 'call') {
        const id = randomUUID(), controller = new AbortController()
        controllers.add(controller)
        results.set(id, { pending: true })
        const operation = ctx.tools.get(data.name).execute(data.args, {
          agent, callId: id, signal: controller.signal, deferContext() {}, concludeTurn() {},
        })
        void operation.then(value => results.set(id, { value }), error => results.set(id, { error: String(error) }))
          .finally(() => { controllers.delete(controller) })
        value = { id, owner: agent.id }
      } else if (data.operation === 'result') value = results.get(data.id)
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(value ?? null))
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: String(error) }))
    }
  } }, 'takeover real rc.5 host test driver'))
}
