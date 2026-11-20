// @vitest-environment jsdom
import { browserSourceRule } from '../production/user-text-rule.ts'
/**
 * Report item 7 — the reply-side `dsh-browser-ref:` link had NO producer: the
 * verification script inserted anchors by hand, which only proved the
 * interceptor worked. These specs close the loop end to end:
 *
 *   1. a REAL `wireSubmissionContent` projection emits a canonical URI whose
 *      decoded referenceId matches the group the message carried;
 *   2. `sourceLinks:false` restores the exact pre-marker shape;
 *   3. the markdown-rendered anchor is intercepted by the bridge;
 *   4. a PLAIN-TEXT user message (ui-conversation's UserTextRun, a bare text
 *      node) is conservatively decorated into a clickable anchor;
 *   5. clicking calls the runtime revealer with that same referenceId.
 *
 * The marker is part of the message content, so it necessarily changes the
 * model input; that is the price of giving the reply a locatable source.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createAdmitImage,
  wireSubmissionContent,
  COMMENT_LABEL,
  type HostPromptContentPart,
  type WireSubmissionInput,
} from '../production/production-submission.ts'
import { createAssetStore } from '../production/asset-store.ts'
import { toOrderedGroup } from '../production/snapshot-adapter.ts'
import { encodeBrowserRefUri, decodeBrowserRefUri } from '../scheme.ts'
import {
  installReplyLinkBridge,
  REPLY_LINK_STATE_ATTR,
  type ReplyLinkBridge,
} from '../production/reply-link-bridge.ts'
import { createProductionRuntime } from '../production/runtime.ts'
import type { HostInputFace } from '../production/draft-adapter.ts'
import {
  ASSET_MAP,
  FakeReferenceHttp,
  LONG_TEXT,
  assetOf,
  deliveriesResponse,
  fakeHostInput,
  makeDelivery,
  makeSnapshot,
  memoryKV,
} from './production.fixtures.ts'

const group = toOrderedGroup(makeSnapshot())
const REFERENCE_ID = group.referenceId
const uploaded: readonly HostPromptContentPart[] = [{ type: 'file', receiptId: 'receipt-1' }]

function boundAssets() {
  const assets = createAssetStore(memoryKV(), 'sess-A')
  for (const [key, bytes] of Object.entries(ASSET_MAP)) assets.bind(assetOf(key, bytes))
  return assets
}

const baseInput = (): WireSubmissionInput => ({
  uploaded,
  text: '用户问题',
  groups: [group],
  admitImage: createAdmitImage(boundAssets()),
})

/** Every canonical `dsh-browser-ref:` URI found in the projected text blocks. */
function urisIn(parts: readonly HostPromptContentPart[]): string[] {
  const found: string[] = []
  for (const part of parts) {
    if (part.type !== 'text') continue
    for (const match of part.text.matchAll(/dsh-browser-ref:[^\s)\]]+/gu)) found.push(match[0])
  }
  return found
}

let bridge: ReplyLinkBridge | undefined
afterEach(() => {
  bridge?.dispose()
  bridge = undefined
  document.body.innerHTML = ''
})

describe('item 7 — the real send path produces a locatable source', () => {
  it('emits a canonical URI that decodes back to the group referenceId', () => {
    const content = wireSubmissionContent(baseInput())
    const uris = urisIn(content)
    expect(uris).toHaveLength(1)
    // Strict, canonical decode (not just a substring match).
    expect(decodeBrowserRefUri(uris[0]!)).toEqual({ referenceId: REFERENCE_ID })
    expect(uris[0]).toBe(encodeBrowserRefUri({ referenceId: REFERENCE_ID }))
  })

  it('keeps attachments first, quoted text verbatim + trailing newline, question last', () => {
    const content = wireSubmissionContent(baseInput())
    expect(content[0]).toEqual({ type: 'file', receiptId: 'receipt-1' })
    // Fifth-round fix: every projected text block keeps its own newline.
    expect((content[1] as { text: string }).text).toBe(`${LONG_TEXT}\n`)
    // The marker is its OWN text block, visible to user and model.
    const marker = content.find(part => part.type === 'text' && part.text.includes('dsh-browser-ref:'))
    expect(marker).toBeDefined()
    expect((marker as { text: string }).text).toContain(`[引用来源 1](${encodeBrowserRefUri({ referenceId: REFERENCE_ID })})`)
    expect(content.at(-1)).toEqual({ type: 'text', text: '用户问题' })
  })

  it('sourceLinks:false returns the exact old shape (on minus the marker block)', () => {
    const on = wireSubmissionContent(baseInput())
    const off = wireSubmissionContent({ ...baseInput(), sourceLinks: false })
    expect(on).toHaveLength(off.length + 1)
    expect(on.filter(part => !(part.type === 'text' && part.text.includes('dsh-browser-ref:')))).toEqual(off)
    expect(JSON.stringify(off)).not.toContain('dsh-browser-ref:')
    expect(urisIn(off)).toEqual([])
  })

  it('emits one marker per group, in capture order', () => {
    const second = { ...group, referenceId: 'ref-second' }
    const uris = urisIn(wireSubmissionContent({ ...baseInput(), groups: [group, second] }))
    expect(uris).toEqual([
      encodeBrowserRefUri({ referenceId: REFERENCE_ID }),
      encodeBrowserRefUri({ referenceId: 'ref-second' }),
    ])
  })

  it('with no groups nothing is added (byte-identical to service.ts:302)', () => {
    expect(wireSubmissionContent({ ...baseInput(), groups: [], text: '只有问题' }))
      .toEqual([...uploaded, { type: 'text', text: '只有问题' }])
  })

  it('also emits the marker in the per-group comment branch, in order', () => {
    const content = wireSubmissionContent({
      ...baseInput(),
      comments: new Map([[REFERENCE_ID, '只看这段']]),
    })
    const texts = content.map(part => (part.type === 'text' ? part.text : `<${part.type}>`))
    // The label is markdown bold, not literal square brackets: `[引用评论] 321` reached the transcript
    // as raw punctuation and read like part of the quoted page text.
    expect(texts[1]).toBe(`${COMMENT_LABEL}：只看这段\n`)
    expect(texts.at(-1)).toBe('用户问题')
    expect(urisIn(content)).toEqual([encodeBrowserRefUri({ referenceId: REFERENCE_ID })])
  })

  it('a page title is display-only: it never enters or breaks the URI', () => {
    const content = wireSubmissionContent({
      ...baseInput(),
      sourceTitleFor: () => '季度](财报) 与 [狐狸*图鉴',
    })
    expect(urisIn(content)).toEqual([encodeBrowserRefUri({ referenceId: REFERENCE_ID })])
    const marker = content.find(part => part.type === 'text' && part.text.includes('dsh-browser-ref:')) as { text: string }
    expect(marker.text).toContain('[引用来源 1：')
    // No raw bracket/paren survived into the label, so markdown stays one link.
    expect(marker.text).not.toContain('](财报)')
    expect(urisIn(content)[0]).not.toContain('财报')
  })
})

describe('item 7 — the source marker is clickable and reveals the original', () => {
  const uriOf = (): string => urisIn(wireSubmissionContent(baseInput()))[0]!

  const click = (node: Element): MouseEvent => {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    node.dispatchEvent(event)
    return event
  }

  it('markdown-rendered anchor: bridge intercepts the click and activate gets the URI', () => {
    const uri = uriOf()
    const activate = vi.fn()
    // render.tsx sanitizeUrl falls through for this scheme, so the deployed
    // markdown renderer emits exactly this <a href> (pinned by
    // ui-primitives/tests/markdown-browser-ref.client.spec.tsx:23-34).
    const anchor = document.createElement('a')
    anchor.setAttribute('href', uri)
    anchor.textContent = '引用来源 1'
    document.body.appendChild(anchor)
    bridge = installReplyLinkBridge({ doc: document, isAvailable: () => true, activate })
    expect(bridge.scan()).toBeGreaterThanOrEqual(1)
    expect(anchor.getAttribute(REPLY_LINK_STATE_ATTR)).toBe('available')

    expect(click(anchor).defaultPrevented).toBe(true)
    expect(activate).toHaveBeenCalledWith(uri)
    expect(decodeBrowserRefUri(activate.mock.calls[0]![0] as string).referenceId).toBe(REFERENCE_ID)
  })

  it('parses a source marker through the native user-text rule without rewriting DOM', () => {
    const content = wireSubmissionContent(baseInput());
    const plain = content.filter(part => part.type === 'text').map(part => part.type === 'text' ? part.text : '').join('');
    const node = browserSourceRule.match(plain, 0, { read: () => undefined });
    expect(node?.id).toBe('browser-ref');
    expect(node?.data).toMatchObject({uri: uriOf(), label: '引用来源 1'});
    if (node !== undefined) expect(plain.slice(node.start,node.end)).toContain(uriOf());
    const span = document.createElement('span'); const original = document.createTextNode(plain);
    span.appendChild(original); document.body.appendChild(span);
    bridge = installReplyLinkBridge({ doc: document, isAvailable: () => true, activate: vi.fn() });
    bridge.scan();
    expect(span.firstChild).toBe(original);
    expect(span.textContent).toBe(plain);
    expect(span.querySelector('a')).toBeNull();
  });

  it('never rewrites protected text (script / editable / inside an existing anchor)', () => {
    const uri = uriOf()
    const script = document.createElement('script')
    script.textContent = `var x = "${uri}"`
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    editable.textContent = `[草稿](${uri})`
    const inside = document.createElement('a')
    inside.setAttribute('href', uri)
    inside.textContent = uri
    document.body.append(script, editable, inside)

    bridge = installReplyLinkBridge({ doc: document, isAvailable: () => true, activate: vi.fn() })
    bridge.scan()
    expect(script.querySelector('a')).toBeNull()
    expect(editable.querySelector('a')).toBeNull()
    expect(inside.querySelector('a')).toBeNull()
  })

  it('the real runtime.activateUri resolves that referenceId from a sent message', async () => {
    const http = new FakeReferenceHttp()
    http.assets = Object.fromEntries(Object.entries(ASSET_MAP).map(([key, bytes]) => [key, assetOf(key, bytes)]))
    const host = fakeHostInput('帮我总结这段网页内容', 7)
    const hostInputFor: (sessionId: string) => HostInputFace = () => host
    const runtime = createProductionRuntime({
      http,
      storage: memoryKV(),
      initialSessionId: 'sess-A',
      hostInputFor,
    })
    try {
      http.enqueue(deliveriesResponse([makeDelivery({ state: 'prepared', sequence: 1 })], 1))
      await runtime.pollOnce()

      const content = runtime.submission.buildContent({ sessionId: 'sess-A', uploaded: [], text: '问题' })
      const uri = urisIn(content)[0]!
      expect(decodeBrowserRefUri(uri).referenceId).toBe(REFERENCE_ID)

      await runtime.activateUri(uri)
      expect(http.revealCalls).toContainEqual({ referenceId: REFERENCE_ID })
    } finally {
      runtime.dispose()
    }
  })
})
