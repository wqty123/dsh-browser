import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIframePage } from '../../pages.ts'
import { WEB_BROWSER_SANDBOX } from '../../../../assets/browser-policy.mjs'

function sidebar() {
  const frames: { attributes: Map<string, string>; src: string }[] = []
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal('location', { origin: 'https://dsh.test' })
  vi.stubGlobal('document', {
    getElementById: () => ({ append: vi.fn() }),
    createElement: () => {
      const frame = {
        attributes: new Map<string, string>(), src: '', dataset: {},
        setAttribute(name: string, value: string) { this.attributes.set(name, value) },
        addEventListener: vi.fn(), remove: vi.fn(),
      }
      frames.push(frame)
      return frame
    },
  })
  const page = createIframePage({ initial: undefined, persist: vi.fn(), openRequested: vi.fn() })
  page.presentation.mount('viewport')
  return { page, frames }
}

function expectNoPopups(frame: { attributes: Map<string, string> } | undefined) {
  expect(frame).toBeDefined()
  const policy = frame?.attributes.get('sandbox')
  expect(policy).toBeDefined()
  const tokens = policy?.split(/\s+/u) ?? []
  expect(tokens).not.toContain('allow-same-origin')
  expect(tokens).not.toContain('allow-top-navigation')
  expect(tokens).not.toContain('allow-popups')
  expect(tokens).not.toContain('allow-popups-to-escape-sandbox')
  for (const token of ['allow-scripts', 'allow-forms']) expect(tokens).toContain(token)
  return tokens
}

afterEach(() => { vi.unstubAllGlobals() })

describe('Web sidebar popup policy', () => {
  it('keeps the default proxy-capable sandbox without popup grants', () => {
    const { page, frames } = sidebar()
    page.frame.loadUrl({ kind: 'https', url: 'https://example.test/page', title: 'Example' })
    expectNoPopups(frames.at(-1))
    expect(frames.at(-1)?.attributes.get('sandbox')).toBe(WEB_BROWSER_SANDBOX)
    expect(frames.at(-1)?.src).toContain('/browser-view/isolated-guest?u=')
    void page.frame.dispose()
  })

  it('never removes the popup restriction when the shield is toggled', () => {
    const { page, frames } = sidebar()
    page.frame.loadUrl({ kind: 'https', url: 'https://example.test/page', title: 'Example' })
    page.frame.sandbox?.setEnabled(false)
    const relaxed = expectNoPopups(frames.at(-1))
    expect(relaxed).toContain('allow-downloads')
    expect(relaxed).toContain('allow-modals')
    page.frame.sandbox?.setEnabled(true)
    expectNoPopups(frames.at(-1))
    expect(frames.at(-1)?.attributes.get('sandbox')).toBe(WEB_BROWSER_SANDBOX)
    void page.frame.dispose()
  })

  it('enforces popup restrictions when the shield is disabled before the first page', () => {
    const { page, frames } = sidebar()
    page.frame.sandbox?.setEnabled(false)
    expect(frames).toHaveLength(0)
    page.frame.loadUrl({ kind: 'http', url: 'http://example.test/page', title: 'Example' })
    expectNoPopups(frames.at(-1))
    void page.frame.dispose()
  })
})
