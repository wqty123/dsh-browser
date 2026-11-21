import { randomUUID } from 'node:crypto'
import { resolveSessionHandle, sessionWireId, tabWireId } from '../lib/browser/handles.js'

export const testScope = (owner, session = 'browser:test') => sessionWireId({ owner, session })
export const testTab = (owner = 'session-a', tab = randomUUID()) => tabWireId({ owner, session: 'browser:test', tab })
export const tabIn = (session, tab) => tabWireId({ ...resolveSessionHandle(session), tab })
