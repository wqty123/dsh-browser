import { createIframePage } from '../../src/client/pages.ts'

Object.assign(window, {
  startFrame() {
    for (const step of ['a', 'b', 'c']) history.pushState({}, '', `/host/${step}`)
    const page = createIframePage({ initial: undefined, persist() {}, openRequested() {} }, 'session-owner')
    page.presentation.mount('viewport')
    page.frame.loadUrl({ kind: 'https', url: 'https://history.example/one', title: 'One' })
    Object.assign(window, { framePage: page })
  },
})
