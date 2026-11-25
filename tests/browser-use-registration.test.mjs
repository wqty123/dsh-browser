import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { BrowserRuntime } from '../lib/browser/runtime.js'

test('BrowserRuntime optionally registers with ctx.browserUse when present and releases on dispose', async () => {
  const ctx = new Context()
  const events = []
  ctx.provide('browserUse')
  ctx.set('browserUse', {
    register(name) {
      events.push(['register', name])
      return () => { events.push(['dispose', name]) }
    },
  })
  const fiber = ctx.plugin(BrowserRuntime)
  await ctx.lifecycle?.flush?.()
  assert.deepEqual(events, [['register', 'dsh-builtin-browser']])
  await fiber.dispose()
  assert.deepEqual(events, [['register', 'dsh-builtin-browser'], ['dispose', 'dsh-builtin-browser']])
  await ctx.fiber.dispose()
})

test('BrowserRuntime starts cleanly when ctx.browserUse is absent', async () => {
  const ctx = new Context()
  ctx.plugin(BrowserRuntime)
  await ctx.lifecycle?.flush?.()
  assert.ok(ctx.get('browser') instanceof BrowserRuntime)
  await ctx.fiber.dispose()
})
