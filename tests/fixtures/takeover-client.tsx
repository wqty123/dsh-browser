import { createRoot } from 'react-dom/client'
import { BrowserBody, type BrowserBodyProps } from '../../src/client/view/BrowserBody.tsx'
import { createIframePage } from '../../src/client/pages.ts'
import { emptyBrowserFrame } from '../../src/client/browser/BrowserFrame.ts'
import { zh } from '../../src/client/locales.ts'

const lifetime = new AbortController()
const url = 'https://takeover.example/login'
const tab = { id: 'sidebar-tab', signal: lifetime.signal, navigation: { params: { url }, revision: 1 },
  actions: { bindCommands: () => () => {} } }
const props = {
  sessionId: 'session-owner', useTabInfo: () => ({ tab }), useContextMenu: () => ({ getTriggerProps: () => ({}) }),
  useStore: () => undefined, useStartPage: () => ({ status: 'ready', engines: [], shortcuts: [] }),
  useBrowserState: () => ({ frame: { ...emptyBrowserFrame(), target: { kind: 'https', url }, address: 'observed' } }),
  currentPage: () => undefined, bindAddressFocus: () => () => {},
  mount({ viewportId }: { viewportId: string }) {
    const page = createIframePage({ initial: undefined, persist() {}, openRequested() {} }, 'session-owner')
    page.presentation.mount(viewportId)
    page.frame.loadUrl({ kind: 'https', url, title: 'Login' })
    return () => { page.presentation.dispose(); void page.frame.dispose() }
  },
  loadUrl() {}, reload() {}, shortcuts: {}, engines: {},
  t: (key: keyof typeof zh, params?: Record<string, string>) => zh[key].replace('{reason}', params?.reason ?? ''),
}
createRoot(document.getElementById('toolbar')!).render(<BrowserBody {...props as unknown as BrowserBodyProps} />)
addEventListener('pagehide', () => { lifetime.abort() }, { once: true })
