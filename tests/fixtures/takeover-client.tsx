import { createRoot } from 'react-dom/client'
import { TakeoverBanner } from '../../src/client/view/TakeoverBanner.tsx'
import { IframePresentation } from '../../src/client/view/IframePresentation.ts'
import { connectBrowserTakeover } from '../../src/client/browser/takeover-channel.ts'
import type { TakeoverNotice } from '../../src/takeover-protocol.ts'

const toolbar = document.getElementById('toolbar')!
const root = createRoot(toolbar)
const lifetime = new AbortController()
let url = 'https://takeover.example/login'
let channel: ReturnType<typeof connectBrowserTakeover> | undefined
const render = (notice?: TakeoverNotice, error?: boolean) => {
  root.render(<TakeoverBanner notice={notice} error={error} label={`AI 正在等待你完成操作：${notice?.reason ?? ''}`}
    done="确认完成" skip="跳过" failure="确认失败，请重试" answer={outcome => { void channel?.answer(outcome) }} />)
}
const presentation = new IframePresentation({ loaded() {}, observed(_revision, next) { url = next }, failed() {}, remounted() {},
  guestReady(_revision, pageId) {
    if (channel) return
    channel = connectBrowserTakeover({ owner: 'owner', tabId: 'sidebar-tab', pageId, current: () => ({ url, active: true }),
      changed(notice, error) { Object.assign(window, { takeoverConnected: true }); render(notice, error) },
    }, lifetime.signal)
  },
}, 'owner')
presentation.mount('viewport')
presentation.show({ target: { kind: 'https', url, title: 'Login' }, revision: 1, sandboxed: true })
addEventListener('pagehide', () => { lifetime.abort(); presentation.dispose() }, { once: true })
