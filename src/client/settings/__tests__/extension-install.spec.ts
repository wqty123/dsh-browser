import { expect, it } from 'vitest'
import { requestExtensionSetup } from '../panel.ts'

it('Web and Desktop extension setup POST to the plugin without commands, IDs or tokens', async () => {
  const calls: unknown[][] = []
  const result = await requestExtensionSetup((async (...args: unknown[]) => {
    calls.push(args)
    return { ok: true, json: async () => ({ ok: true, connected: true, detail: '已连接' }) }
  }) as typeof fetch)
  expect(calls).toEqual([['/dsh-builtin-browser/extension/install', { method: 'POST', headers: { accept: 'application/json' } }]])
  expect(result.connected).toBe(true)
})

it('reports server installation errors rather than claiming success', async () => {
  await expect(requestExtensionSetup((async () => ({ ok: true, json: async () => ({ ok: false, detail: 'Registration refused' }) })) as typeof fetch)).rejects.toThrow('Registration refused')
})
