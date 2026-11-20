// @vitest-environment jsdom
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToString as renderKatex } from 'katex'
import { renderToStaticMarkup } from 'react-dom/server'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { captureScript, highlightScript, pageTextScript, revealElementScript, type RawCaptureResult } from '../../../../browser-reference/page-script.ts'
import { BrowserReferenceService } from '../../../../browser-reference/service.ts'
import { frameCaptureScript } from '../../../../browser-reference/entry.ts'
import { ReferenceStore } from '../../../../browser-reference/store.ts'
import { isReferenceText, isReferenceTable, MAX_REFERENCE_TEXT, renderReferenceText, referenceTableRows, renderReferenceTable } from '../../../../reference-text.ts'
import { emptyDraftState, insertGroup, isOrderedReferenceGroup } from '../draft-reference.ts'
import { toOrderedGroup } from '../production/snapshot-adapter.ts'
import { wireSubmissionContent } from '../production/production-submission.ts'
import { ReferenceText } from '../production/ReferenceText.tsx'
import { ReferenceCapsules } from '../production/ReferenceCapsules.tsx'
import { buildCardViewModel } from '../production/reference-card.ts'
import { createAssetStore } from '../production/asset-store.ts'
import { referenceLabels } from '../production/reference-labels.ts'
import { memoryKV } from './production.fixtures.ts'

const directories: string[] = []
const box = { x: 10, y: 100, left: 10, top: 100, right: 650, bottom: 120, width: 640, height: 20, toJSON: () => ({}) }
const oldRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects')
beforeAll(() => { Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [box] }) })
afterAll(() => {
  if (oldRects) Object.defineProperty(Range.prototype, 'getClientRects', oldRects)
  else Reflect.deleteProperty(Range.prototype, 'getClientRects')
})
beforeEach(() => { vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(box) })
afterEach(() => {
  window.dispatchEvent(new Event('pointerdown'))
  cleanup()
  vi.restoreAllMocks()
  window.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function execute<T>(source: string, spec: unknown = {}): T {
  return JSON.parse(new Function(`return ${source}`).call(window, spec)) as T
}

function select(html: string): RawCaptureResult {
  document.body.innerHTML = html
  const range = document.createRange()
  range.selectNodeContents(document.body)
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
  return execute(captureScript())
}

async function stored(raw: RawCaptureResult) {
  const directory = mkdtempSync(join(tmpdir(), 'reference-format-'))
  directories.push(directory)
  const path = join(directory, 'references.jsonl')
  const service = new BrowserReferenceService({ exists: () => false, evaluate: async () => { throw new Error('frozen capture must not read a browser') } },
    new ReferenceStore(path), { assetDir: join(directory, 'assets') })
  const outcome = await service.capture({ sessionId: 's', frozenCapture: raw })
  return { outcome, path }
}

async function submit(raw: RawCaptureResult) {
  const { outcome, path } = await stored(raw)
  expect(outcome.failures).toEqual([])
  const snapshot = new ReferenceStore(path).get(outcome.reference!.referenceId)!
  const group = toOrderedGroup(snapshot)
  expect(insertGroup(emptyDraftState(), group, 0).ok).toBe(true)
  return { snapshot, group, parts: wireSubmissionContent({ uploaded: [], text: '', groups: [group], sourceLinks: false, admitImage: () => undefined }) }
}

describe('formatted quotations through emitted capture, storage, draft and submission', () => {
  it.each(['', '\n\n  '])('does not turn inter-block source formatting into blank preview lines (%j)', async gap => {
    const raw = select(`<p>无序列表</p>${gap}<ul>\n<li>列表项</li>\n<li>列表项</li>\n<li>列表项</li>\n</ul>`)
    expect(raw.events).toHaveLength(1)
    const event = raw.events![0]!
    expect(event.content?.map(node => node.type)).toEqual(['paragraph', 'list'])
    const { snapshot, group, parts } = await submit(raw)
    expect(snapshot.parts.map(part => part.type)).toEqual(['text'])
    expect(parts.map(part => part.type === 'text' ? part.text : '').join('')).not.toMatch(/\n{3}/u)
    const page = execute<{ text: string }>(pageTextScript())
    const start = page.text.indexOf(event.exact!)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(execute(highlightScript(), { start, end: start + event.exact!.length })).toMatchObject({ ok: true })
    const card = buildCardViewModel({ referenceId: snapshot.referenceId, intentId: 'intent', browserSessionId: 'browser:s', group, addedAt: 1, snapshot, deliveryState: 'prepared', failures: [] }, createAssetStore(memoryKV(), 's'))
    render(createElement(ReferenceCapsules, { sessionId: 's', cards: [card], actions: {}, labels: referenceLabels(), anchor: document.body }))
    const quote = document.querySelector('[data-part-kind="text"]')!
    expect([...quote.childNodes].map(node => node.nodeName)).toEqual(['P', 'UL'])
    expect(quote.querySelectorAll('li')).toHaveLength(3)
    expect(quote.querySelector('br, p:empty')).toBeNull()
  })

  it('retains inline spaces, explicit breaks and preformatted inter-block whitespace', () => {
    const raw = select('<p><strong>a</strong> <em>b</em><br>c</p><pre><code><div>first</div>\n\n<div>second</div></code></pre>')
    const content = raw.events![0]!.content!
    expect(renderToStaticMarkup(createElement(ReferenceText, { content }))).toContain('<strong>a</strong> <em>b</em><br/>c')
    expect(renderToStaticMarkup(createElement(ReferenceText, { content }))).toContain('<div>first</div>\n\n<div>second</div>')
  })

  it.each([
    ['KaTeX inline', '<span class="katex"><span class="katex-mathml"><math><semantics><mi>x</mi><annotation encoding="application/x-tex">x^2</annotation></semantics></math></span><span class="katex-html">garbled glyphs</span></span>', 'x^2', false],
    ['KaTeX display', '<span class="katex-display"><span class="katex"><math><semantics><mi>x</mi><annotation encoding="application/x-tex">x^2</annotation></semantics></math><span>garbled glyphs</span></span></span>', 'x^2', true],
    ['MathJax 2', '<span class="MathJax_Display"><span class="MathJax">garbled glyphs</span></span><script type="math/tex; mode=display">\\frac{a}{b}</script>', '\\frac{a}{b}', true],
    ['MathJax 2 SVG', '<span class="MathJax_SVG"><svg><text>garbled glyphs</text></svg></span><script type="math/tex">x^2</script>', 'x^2', false],
    ['MathJax 3 annotation', '<mjx-container display="true"><mjx-math>garbled glyphs</mjx-math><mjx-assistive-mml><math><semantics><mi>x</mi><annotation encoding="application/x-tex">x^2</annotation></semantics></math></mjx-assistive-mml></mjx-container>', 'x^2', true],
    ['MathJax 3 data-latex', '<mjx-container data-latex="x^2"><mjx-math>garbled glyphs</mjx-math></mjx-container>', 'x^2', false],
    ['MathJax 3 assistive MathML', '<mjx-container><mjx-math>garbled glyphs</mjx-math><mjx-assistive-mml><math><mfrac><mi>a</mi><mi>b</mi></mfrac></math></mjx-assistive-mml></mjx-container>', '\\frac{a}{b}', false],
    ['MathML annotation', '<math display="block"><semantics><mi>x</mi><annotation encoding="application/x-tex">x^2</annotation></semantics></math>', 'x^2', true],
    ['MathML fallback', '<math><mrow><msup><mi>x</mi><mn>2</mn></msup><mo>+</mo><msqrt><mi>y</mi></msqrt></mrow></math>', 'x^{2}+\\sqrt{y}', false],
  ] as const)('preserves %s through capture, frozen storage, model, both capsule previews and source range', async (_name, html, latex, display) => {
    const raw = select(html)
    expect(raw.events).toHaveLength(1)
    expect(raw.events![0]).toMatchObject({ kind: 'text', exact: latex, content: [{ type: 'math', latex, display }] })
    const formula = document.body.firstElementChild!
    const { snapshot, group, parts } = await submit(raw)
    expect(parts).toEqual([{ type: 'text', text: display ? `$$\n${latex}\n$$\n` : `$${latex}$\n` }])
    const mathSelector = raw.events![0]!.content!.some(node => node.type === 'math' && node.mathml) ? 'math' : '.katex'
    const startBefore = vi.spyOn(Range.prototype, 'setStartBefore')
    const endAfter = vi.spyOn(Range.prototype, 'setEndAfter')
    expect(execute(highlightScript(), { start: 0, end: latex.length })).toMatchObject({ ok: true })
    expect(startBefore).toHaveBeenCalledWith(formula)
    expect(endAfter).toHaveBeenCalledWith(formula)
    const card = buildCardViewModel({ referenceId: snapshot.referenceId, intentId: 'intent', browserSessionId: 'browser:s', group, addedAt: 1, snapshot, deliveryState: 'prepared', failures: [] }, createAssetStore(memoryKV(), 's'))
    const composer = render(createElement(ReferenceCapsules, { sessionId: 's', cards: [card], actions: {}, labels: referenceLabels() }))
    expect(document.querySelector('[data-reference-math]')).toBeNull()
    fireEvent.mouseEnter(composer.getByRole('button'))
    expect(document.querySelector('[data-reference-math]')?.querySelector(mathSelector)).not.toBeNull()
    composer.unmount()
    render(createElement(ReferenceCapsules, { sessionId: 's', cards: [card], actions: {}, labels: referenceLabels(), anchor: document.body }))
    expect(document.querySelector('[data-reference-math]')?.getAttribute('data-reference-math')).toBe(display ? 'display' : 'inline')
    expect(document.querySelector('[data-reference-math]')?.querySelector(mathSelector)).not.toBeNull()
  })

  it.each([
    ['KaTeX annotation', renderKatex('\\sqrt[3]{x}', { throwOnError: false, trust: false }), false],
    ['MathJax assistive MathML', '<mjx-container><mjx-math>x3</mjx-math><mjx-assistive-mml><math><mroot>\n<mi>x</mi>\n<mn>3</mn>\n</mroot></math></mjx-assistive-mml></mjx-container>', true],
    ['raw MathML', '<math><mroot><mi>x</mi><mn>3</mn></mroot></math>', true],
    ['later nonempty annotation', '<math><semantics><mroot><mi>x</mi><mn>3</mn></mroot><annotation encoding="application/x-tex"> </annotation><annotation encoding="Application/X-TeX; charset=utf-8">\\sqrt[3]{x}</annotation></semantics></math>', false],
    ['empty annotation fallback', '<math><semantics><mroot><mi>x</mi><mn>3</mn></mroot><annotation encoding="application/x-tex"> </annotation></semantics></math>', true],
  ] as const)('preserves cube-root structure and source through %s capture, storage, model and preview', async (_name, html, native) => {
    const raw = select(html)
    const math = raw.events![0]!.content![0]!
    expect(math).toMatchObject({ type: 'math', latex: '\\sqrt[3]{x}', display: false })
    if (math.type !== 'math') throw new Error('missing captured formula')
    expect(math.mathml !== undefined).toBe(native)
    if (native) expect(math.mathml).toContain('<mroot>')
    const { snapshot, group, parts } = await submit(raw)
    expect(parts).toEqual([{ type: 'text', text: '$\\sqrt[3]{x}$\n' }])
    expect(snapshot.parts[0]).toMatchObject({ type: 'text', content: [math] })
    const preview = render(createElement(ReferenceText, { content: group.parts[0]!.content! }))
    expect(preview.container.querySelector('math mroot mi')?.textContent).toBe('x')
    expect(preview.container.querySelector('math mroot mn')?.textContent).toBe('3')
    expect(Boolean(preview.container.querySelector('.katex'))).toBe(!native)
    expect(preview.container.querySelector('code')).toBeNull()
    if (!native) expect(preview.container.querySelector('annotation[encoding="application/x-tex"]')?.textContent).toBe('\\sqrt[3]{x}')
  })

  it.each([
    ['msqrt', '<mi>x</mi>', '\\sqrt{x}'],
    ['mfrac', '<mi>x</mi>\n<mi>y</mi>', '\\frac{x}{y}'],
    ['msup', '<mi>x</mi>\n<mn>2</mn>', 'x^{2}'],
    ['msub', '<mi>x</mi>\n<mi>i</mi>', 'x_{i}'],
    ['munderover', '<mi>x</mi>\n<mi>i</mi>\n<mi>n</mi>', 'x_{i}^{n}'],
  ])('retains native %s layout rather than concatenating its children', async (tag, children, latex) => {
    const raw = select(`<math><${tag}>\n${children}\n</${tag}></math>`)
    expect(raw.events![0]!.content![0]).toMatchObject({ type: 'math', latex, mathml: expect.stringContaining(`<${tag}>`) })
    const { group, parts } = await submit(raw)
    expect(parts).toEqual([{ type: 'text', text: `$${latex}$\n` }])
    const preview = render(createElement(ReferenceText, { content: group.parts[0]!.content! }))
    expect(preview.container.querySelector(`math ${tag}`)?.children.length).toBe(tag === 'msqrt' ? 1 : tag === 'munderover' ? 3 : 2)
    expect(preview.container.querySelector('.katex, code')).toBeNull()
  })

  it('expands a partial rendered-formula selection atomically, without capturing adjacent text', async () => {
    document.body.innerHTML = '<p>Before <span class="katex"><span id="glyph">garbled</span><math><annotation encoding="application/x-tex">x^2</annotation></math></span> after</p>'
    const glyph = document.querySelector('#glyph')!.firstChild!
    const range = document.createRange()
    range.setStart(glyph, 1)
    range.setEnd(glyph, 3)
    window.getSelection()!.addRange(range)
    const raw = execute<RawCaptureResult>(captureScript())
    expect(raw.events![0]).toMatchObject({ exact: 'x^2', content: [{ type: 'paragraph', children: [{ type: 'math', latex: 'x^2', display: false }] }] })
    expect((await submit(raw)).parts).toEqual([{ type: 'text', text: '$x^2$\n' }])
    const page = execute<{ text: string }>(pageTextScript())
    expect(page.text).toBe('Before x^2 after\n\n')
    const startBefore = vi.spyOn(Range.prototype, 'setStartBefore')
    expect(execute(highlightScript(), { start: 7, end: 10 })).toMatchObject({ ok: true })
    expect(startBefore).toHaveBeenCalledWith(document.querySelector('.katex'))
  })

  it.each([
    ['code', '<pre><code class="language-js">const x = 1;\n  x++;\n</code></pre><p>Use <code>a`b</code>.</p>', ['```js\nconst x = 1;\n  x++;\n\n```', '`` a`b ``'], 'pre[data-language="js"]', 'const x = 1;\n  x++;\n'],
    ['pre language', '<pre class="lang-python">  print(1)\n</pre>', ['```python\n  print(1)\n\n```'], 'pre[data-language="python"]', '  print(1)\n'],
    ['blockquote', '<blockquote><p>Outer</p><blockquote><p>Inner</p></blockquote></blockquote>', ['> Outer', '> > Inner'], 'blockquote blockquote', 'Inner'],
    ['nested list numbering', '<ol start="3"><li>Three<ul><li>Nested</li></ul></li><li value="8">Eight</li><li>Nine</li></ol>', ['3. Three', '  - Nested', '8. Eight', '9. Nine'], 'ol[start="3"] li[value="8"]', 'Eight'],
    ['definitions', '<dl><dt>Term</dt><dd>Definition</dd></dl>', ['Term', ': Definition'], 'dl dd', 'Definition'],
    ['headings', '<h1>Title</h1><h4>Section</h4>', ['# Title', '#### Section'], 'h4', 'Section'],
    ['sup/sub', '<p>x<sup>2</sup> H<sub>2</sub>O</p>', ['x<sup>2</sup> H<sub>2</sub>O'], 'sub', '2'],
    ['ruby', '<p><ruby>漢<rp>(</rp><rt>kan</rt><rp>)</rp></ruby></p>', ['<ruby>漢<rt>kan</rt></ruby>'], 'ruby rt', 'kan'],
    ['hr/br', '<p>First<br>Second</p><hr><p>Third</p>', ['First  \nSecond', '---', 'Third'], 'hr', ''],
  ] as const)('preserves %s semantics and source-map range', async (_name, html, expected, selector, preview) => {
    const raw = select(html)
    const { snapshot, group, parts } = await submit(raw)
    const model = parts.map(part => part.type === 'text' ? part.text : '').join('')
    for (const text of expected) expect(model).toContain(text)
    const page = execute<{ text: string }>(pageTextScript())
    const exact = raw.events![0]!.exact!
    const start = page.text.indexOf(exact)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(execute(highlightScript(), { start, end: start + exact.length })).toMatchObject({ ok: true })
    const card = buildCardViewModel({ referenceId: snapshot.referenceId, intentId: 'intent', browserSessionId: 'browser:s', group, addedAt: 1, snapshot, deliveryState: 'prepared', failures: [] }, createAssetStore(memoryKV(), 's'))
    render(createElement(ReferenceCapsules, { sessionId: 's', cards: [card], actions: {}, labels: referenceLabels(), anchor: document.body }))
    expect(document.querySelector(`[data-part-kind="text"] ${selector}`)?.textContent).toBe(preview)
  })

  it('captures a Runoob-style thead/zebra table across cells as a real table and Markdown', async () => {
    document.body.innerHTML = '<table class="reference"><thead><tr><th>Firstname</th><th>Lastname</th></tr></thead><tbody><tr style="background:#eee"><td id="first">Peter</td><td>Griffin</td></tr><tr><td>Lois</td><td id="last">Griffin</td></tr></tbody></table>'
    const range = document.createRange()
    range.setStart(document.querySelector('#first')!.firstChild!, 1)
    range.setEnd(document.querySelector('#last')!.firstChild!, 3)
    window.getSelection()!.addRange(range)
    const raw = execute<RawCaptureResult>(captureScript())
    const { snapshot, group, parts } = await submit(raw)
    expect(snapshot.parts.map(part => part.type)).toEqual(['table'])
    expect(parts).toEqual([{ type: 'text', text: '| Firstname | Lastname |\n| --- | --- |\n| Peter | Griffin |\n| Lois | Griffin |\n' }])
    expect(execute(revealElementScript(), { kind: 'table', anchor: raw.events![0] })).toMatchObject({ ok: true })
    const card = buildCardViewModel({ referenceId: snapshot.referenceId, intentId: 'intent', browserSessionId: 'browser:s', group, addedAt: 1, snapshot, deliveryState: 'prepared', failures: [] }, createAssetStore(memoryKV(), 's'))
    render(createElement(ReferenceCapsules, { sessionId: 's', cards: [card], actions: {}, labels: referenceLabels(), anchor: document.body }))
    expect(document.querySelectorAll('[data-part-kind="table"] th')).toHaveLength(2)
    expect(document.querySelectorAll('[data-part-kind="table"] td')).toHaveLength(4)
  })

  it('keeps math/code semantics inside merged table cells', async () => {
    const raw = select('<table><tr><th colspan="2">Formula</th></tr><tr><td rowspan="2"><math><semantics><mi>x</mi><annotation encoding="application/x-tex">x^2</annotation></semantics></math></td><td><code>a*b</code></td></tr><tr><td>End</td></tr></table>')
    const { snapshot, group, parts } = await submit(raw)
    expect(parts.map(part => part.type === 'text' ? part.text : '').join('')).toContain('| $x^2$ | ` a*b ` |')
    const card = buildCardViewModel({ referenceId: snapshot.referenceId, intentId: 'intent', browserSessionId: 'browser:s', group, addedAt: 1, snapshot, deliveryState: 'prepared', failures: [] }, createAssetStore(memoryKV(), 's'))
    render(createElement(ReferenceCapsules, { sessionId: 's', cards: [card], actions: {}, labels: referenceLabels(), anchor: document.body }))
    expect(document.querySelector('[data-part-kind="table"] th[colspan="2"]')).not.toBeNull()
    expect(document.querySelector('[data-part-kind="table"] td[rowspan="2"] [data-reference-math] .katex')).not.toBeNull()
    expect(document.querySelector('[data-part-kind="table"] td[rowspan="2"] annotation')?.textContent).toBe('x^2')
  })

  it('keeps image alt, caption, source identity and caption model text', async () => {
    const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZkAAAAASUVORK5CYII='
    const raw = select(`<figure><img src="data:image/png;base64,${data}" alt="A diagram"><figcaption>Figure one</figcaption></figure>`)
    const { snapshot, group, parts } = await submit(raw)
    const image = snapshot.parts.find(part => part.type === 'image')!
    expect(image).toMatchObject({ type: 'image', alt: 'A diagram', caption: 'Figure one' })
    if (image.type !== 'image') throw new Error('missing image')
    expect(parts).toContainEqual({ type: 'text', text: 'Figure one\n' })
    expect(parts).toContainEqual({ type: 'text', text: 'Image: A diagram\nFigure one\n' })
    expect(execute(revealElementScript(), { kind: 'image', anchor: image.anchor })).toMatchObject({ ok: true })
    const assets = createAssetStore(memoryKV(), 's')
    assets.bind({ ok: true, key: image.assetKey, sha256: image.assetKey, mime: 'image/png', bytes: Buffer.from(data, 'base64').length, data })
    const card = buildCardViewModel({ referenceId: snapshot.referenceId, intentId: 'intent', browserSessionId: 'browser:s', group, addedAt: 1, snapshot, deliveryState: 'prepared', failures: [] }, assets)
    render(createElement(ReferenceCapsules, { sessionId: 's', cards: [card], actions: {}, labels: referenceLabels(), anchor: document.body }))
    expect(document.querySelector('[data-part-kind="image"] img')?.getAttribute('alt')).toBe('A diagram')
    expect(document.querySelector('[data-part-kind="image"] figcaption')?.textContent).toBe('Figure one')
  })

  it('rejects malformed/oversized rich nodes and never fabricates rendered math glyph text', async () => {
    for (const node of [
      { type: 'math', latex: '', display: false }, { type: 'math', latex: 'x', display: 'yes' },
      { type: 'math', latex: 'x'.repeat(MAX_REFERENCE_TEXT + 1), display: false },
      { type: 'heading', level: 7, children: [] }, { type: 'pre', language: 'js\n```', children: [] },
      { type: 'list-item', value: 1.5, children: [] },
    ]) expect(isReferenceText([node])).toBe(false)
    const raw = select('<span class="katex">garbled glyphs</span>')
    expect((await submit(raw)).parts).toEqual([{ type: 'text', text: '$[math source unavailable]$\n' }])
    expect(execute(captureScript(), { maxChars: 2 })).toMatchObject({ truncated: true, events: [] })
    const table = select('<table><tr><th>Heading</th></tr><tr><td>Value</td></tr></table>')
    const badTable = JSON.parse(JSON.stringify(table)) as RawCaptureResult
    Object.assign(badTable.events![0]!.table!.cells![0]!, { content: [{ type: 'math', latex: 'fabricated', display: false }] })
    expect((await stored(badTable)).outcome.failures).toContainEqual(expect.objectContaining({ kind: 'table', reason: 'invalid-text-content' }))
  })

  it('preserves selected article headings and lists inside a layout table as structured text', async () => {
    document.body.innerHTML = '<table><tr><td>navigation</td><td id="article"><h3>Examples</h3><ul><li>One</li><li>Two</li></ul></td></tr></table>'
    const range = document.createRange()
    range.selectNodeContents(document.getElementById('article')!)
    window.getSelection()!.addRange(range)
    const raw = execute<RawCaptureResult>(captureScript())
    expect(raw.events!.map(event => event.kind)).toEqual(['text'])
    const { parts, snapshot } = await submit(raw)
    expect(snapshot.parts.map(part => part.type)).toEqual(['text'])
    expect(parts).toEqual([{ type: 'text', text: '### Examples\n\n- One\n- Two\n' }])
  })

  it.each(['presentation', 'none'])('honors role=%s even when a layout table contains header cells', async role => {
    const raw = select(`<table role="${role}"><tr><th>Heading</th><td>Content</td></tr><tr><td>A</td><td>B</td></tr></table>`)
    expect(raw.events!.map(event => event.kind)).toEqual(['text'])
    expect((await submit(raw)).snapshot.parts[0]?.type).toBe('text')
  })

  it.each(['presentation', 'none'])('preserves role=%s cell and row separators through capture, storage, submission and capsules', async role => {
    const raw = select(`<table role="${role}"><tr><th>Hello</th><td>world</td></tr><tr><td>Again</td><td>friend</td></tr></table>`)
    const text = 'Hello\tworld\nAgain\tfriend'
    expect(raw.events!.map(event => event.kind)).toEqual(['text'])
    expect(raw.events![0]!.exact).toBe(text)
    expect(renderReferenceText(raw.events![0]!.content!)).toBe(text)
    const { parts, snapshot, group } = await submit(raw)
    expect(parts).toEqual([{ type: 'text', text: `${text}\n` }])
    expect(snapshot.parts[0]).toMatchObject({ type: 'text', text, content: raw.events![0]!.content })
    expect(group.parts[0]!.content).toEqual(raw.events![0]!.content)
    const card = buildCardViewModel({ referenceId: snapshot.referenceId, intentId: 'intent', browserSessionId: 'browser:s', group, addedAt: 1, snapshot, deliveryState: 'prepared', failures: [] }, createAssetStore(memoryKV(), 's'))
    render(createElement(ReferenceCapsules, { sessionId: 's', cards: [card], actions: {}, labels: referenceLabels(), anchor: document.body }))
    expect(document.querySelector('[data-part-kind="text"]')!.textContent).toBe(text)
  })

  it('clips layout-cell separators with the same offsets used to highlight the source', async () => {
    document.body.innerHTML = '<table role="presentation"><tr><td>Hello😀</td><td><strong>world</strong></td></tr><tr><td>Again</td><td>friend</td></tr></table>'
    const first = document.querySelector('td')!.firstChild!
    const last = document.querySelectorAll('td')[3]!.firstChild!
    const range = document.createRange()
    range.setStart(first, 3)
    range.setEnd(last, 3)
    window.getSelection()!.addRange(range)
    const raw = execute<RawCaptureResult>(captureScript())
    const exact = 'lo😀\tworld\nAgain\tfri'
    expect(raw.events![0]!.exact).toBe(exact)
    const { parts } = await submit(raw)
    expect(parts).toEqual([{ type: 'text', text: 'lo😀\t**world**\nAgain\tfri\n' }])
    const page = execute<{ text: string }>(pageTextScript()).text
    const start = page.indexOf(exact)
    expect(start).toBeGreaterThanOrEqual(0)
    const setStart = vi.spyOn(Range.prototype, 'setStart')
    const setEnd = vi.spyOn(Range.prototype, 'setEnd')
    expect(execute(highlightScript(), { start, end: start + exact.length })).toMatchObject({ ok: true })
    expect(setStart).toHaveBeenCalledWith(first, 3)
    expect(setEnd).toHaveBeenCalledWith(last, 3)
  })

  it('keeps layout-cell spacing around empty cells and rejects a wholly empty selection', async () => {
    const { parts } = await submit(select('<table role="presentation"><tr><td>Hello</td><td></td><td>world</td></tr><tr><td></td><td>Again</td></tr></table>'))
    expect(parts).toEqual([{ type: 'text', text: 'Hello\tworld\nAgain\n' }])
    const empty = select('<table role="presentation"><tr><td></td><td></td></tr></table>')
    expect(empty.events ?? []).toEqual([])
  })

  it('keeps a real nested data table without promoting its layout ancestor', async () => {
    const raw = select('<table><tr><td><h3>Article</h3><table><tr><th>Name</th><th>Value</th></tr><tr><td>A</td><td>1</td></tr></table><p>After</p></td></tr></table>')
    expect(raw.events!.map(event => event.kind)).toEqual(['text', 'table', 'text'])
    const { snapshot } = await submit(raw)
    expect(snapshot.parts[1]).toMatchObject({ type: 'table', table: { rowCount: 2, columnCount: 2 } })
  })

  it('recognizes a regular headerless data matrix', async () => {
    const raw = select('<table><tr><td>A</td><td>1</td></tr><tr><td>B</td><td>2</td></tr></table>')
    expect(raw.events!.map(event => event.kind)).toEqual(['table'])
    expect((await submit(raw)).snapshot.parts[0]).toMatchObject({ type: 'table', table: { rowCount: 2, columnCount: 2 } })
  })

  it('honors an explicit whole-table request even for a presentation table', async () => {
    document.body.innerHTML = '<table id="layout" role="presentation"><tr><td>A</td><td>B</td></tr></table>'
    const raw = execute<RawCaptureResult>(captureScript(), { tableSelector: '#layout' })
    expect(raw.events!.map(event => event.kind)).toEqual(['table'])
    expect((await submit(raw)).snapshot.parts[0]).toMatchObject({ type: 'table', table: { rowCount: 1, columnCount: 2 } })
  })

  it('keeps partial table columns under their own headers through capture and submission', async () => {
    document.body.innerHTML = '<table><thead><tr><th>A</th><th>B</th><th>C</th><th>D</th></tr></thead><tbody><tr><td>omit</td><td colspan="2">selected</td><td>omit too</td></tr></tbody></table>'
    const range = document.createRange()
    range.selectNodeContents(document.querySelectorAll('tbody td')[1]!)
    window.getSelection()!.addRange(range)
    const raw = execute<RawCaptureResult>(captureScript())
    const { snapshot, group, parts } = await submit(raw)
    const table = snapshot.parts.find(part => part.type === 'table')!
    expect(table.type).toBe('table')
    if (table.type !== 'table') throw new Error('missing table')
    expect(table.table.cells.find(cell => cell.role === 'data')).toMatchObject({ column: 1, columnSpan: 2, text: 'selected' })
    const html = parts.filter(part => part.type === 'text').map(part => part.text).join('\n')
    expect(html).toContain('|  | selected | selected |  |')
    expect(referenceTableRows(table.table)[1]!.cells.map(cell => cell.column)).toEqual([0, 1, 3])
    const card = buildCardViewModel({ referenceId: snapshot.referenceId, intentId: 'intent', browserSessionId: 'browser:s', group, addedAt: 1, snapshot, deliveryState: 'prepared', failures: [] }, createAssetStore(memoryKV(), 's'))
    render(createElement(ReferenceCapsules, { sessionId: 's', cards: [card], actions: {}, labels: referenceLabels(), anchor: document.body }))
    const cells = document.querySelectorAll('[data-part-kind="table"] tbody tr:nth-child(2) td')
    expect([...cells].map(cell => cell.textContent)).toEqual(['', 'selected', ''])
    expect(cells[1]!.getAttribute('colspan')).toBe('2')
  })

  it('leaves rowspan-covered columns occupied, and handles empty tables', () => {
    const table = { columnCount: 3, cells: [
      { row: 0, column: 0, rowSpan: 2, columnSpan: 1, role: 'header' as const, text: 'A' },
      { row: 0, column: 1, rowSpan: 1, columnSpan: 2, role: 'header' as const, text: 'B/C' },
      { row: 1, column: 2, rowSpan: 1, columnSpan: 1, role: 'data' as const, text: 'C value' },
    ] }
    expect(renderReferenceTable(table)).toContain('<tr><td colspan="1"></td><td rowspan="1" colspan="1">C value</td></tr>')
    expect(referenceTableRows({ cells: [] })).toEqual([])
    expect(isReferenceTable({ ...table, columnCount: -1 })).toBe(false)
  })
  it('preserves paragraphs, nested inline emphasis, links, lists and explicit line breaks', async () => {
    const raw = select('<p>First <strong>bold <em>nested</em></strong> <a href="https://example.com/a?q=1">link</a>.</p><p>Second<br>line</p><ol start="3"><li>Alpha</li><li>Beta</li></ol><ul><li>Gamma</li></ul>')
    expect(raw.ok).toBe(true)
    expect(raw.events).toHaveLength(1)
    expect(raw.events![0]!.exact).toBe('First bold nested link.\n\nSecond\nline\n\nAlpha\nBeta\n\nGamma')
    const { parts, group, snapshot } = await submit(raw)
    expect(parts).toEqual([{ type: 'text', text: 'First **bold *nested*** [link](https://example.com/a?q=1).\n\nSecond  \nline\n\n3. Alpha\n4. Beta\n\n- Gamma\n' }])
    expect(group.parts[0]!.content).toEqual(raw.events![0]!.content)
    expect(snapshot.parts[0]).toMatchObject({ content: raw.events![0]!.content })
    const html = renderToStaticMarkup(createElement(ReferenceText, { content: group.parts[0]!.content! }))
    expect(html).toContain('<strong>bold <em>nested</em></strong>')
    expect(html).toContain('<ol start="3"><li>Alpha</li><li>Beta</li></ol>')
    expect(html).toContain('Second<br/>line')
    expect(html).not.toContain('target=')
  })

  it('keeps text/table/text order and submits a structural table with merged cells', async () => {
    const raw = select('<p>Before</p><table><caption>Scores</caption><tr><th colspan="2">Results</th></tr><tr><td>Ada</td><td>42</td></tr></table><p>After</p>')
    expect(raw.events!.map(event => event.kind)).toEqual(['text', 'table', 'text'])
    const { parts, group } = await submit(raw)
    expect(parts).toEqual([
      { type: 'text', text: 'Before\n' },
      { type: 'text', text: 'Scores\n| Results | Results |\n| --- | --- |\n| Ada | 42 |\n' },
      { type: 'text', text: 'After\n' },
    ])
    expect(group.parts[1]!.table!.cells[0]).toMatchObject({ role: 'header', columnSpan: 2 })
  })

  it('keeps the real Runoob table readable beside trailing navigation text in a mixed preview', async () => {
    const markup = readFileSync(join(process.cwd(), 'tests/fixtures/runoob-html-tables.html'), 'utf8')
    const upstream = new DOMParser().parseFromString(markup, 'text/html')
    const table = [...upstream.querySelectorAll('table')].find(table => table.querySelector('th'))!
    const { snapshot, group } = await submit(select(table.outerHTML + '<p>HTML 图像 / HTML 列表</p>'))
    expect(snapshot.parts.map(part => part.type)).toEqual(['table', 'text'])
    const card = buildCardViewModel({ referenceId: snapshot.referenceId, intentId: 'mixed', browserSessionId: 'browser:s', group,
      addedAt: 1, snapshot, deliveryState: 'prepared', failures: [] }, createAssetStore(memoryKV(), 's'))
    render(createElement(ReferenceCapsules, { sessionId: 's', cards: [card], actions: {}, labels: referenceLabels(), anchor: document.body }))
    const parts = document.querySelectorAll('[role="dialog"] [data-part-kind]')
    expect([...parts].map(node => node.getAttribute('data-part-kind'))).toEqual(['table', 'text'])
    expect(parts[0]!.querySelectorAll('tr')).toHaveLength(table.rows.length)
    expect(parts[0]!.textContent).toContain('<table>定义表格')
    expect(parts[0]!.textContent).toContain('<tfoot>定义表格的页脚')
    expect(parts[1]!.textContent).toBe('HTML 图像 / HTML 列表')
  })

  it('clips selected inline content and keeps the original ordered-list numbering', async () => {
    select('<ol start="7"><li>Unselected</li><li>prefix <strong>selected</strong> suffix</li></ol>')
    const range = document.createRange()
    const node = document.querySelector('strong')!.firstChild!
    range.setStart(node, 1)
    range.setEnd(node, 6)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    const { parts } = await submit(execute(captureScript()))
    expect(parts).toEqual([{ type: 'text', text: '8. **elect**\n' }])
  })

  it('uses identical map offsets for capture, locate and DOM highlighting across blocks and br', () => {
    const raw = select('<p>First <b>bold</b></p><p>Second<br>line 🦊</p>')
    const event = raw.events![0]!
    const page = execute<{ text: string }>(pageTextScript())
    expect(page.text).toContain(event.exact)
    const node = document.querySelectorAll('p')[1]!.lastChild!
    const start = page.text.indexOf('line')
    const setStart = vi.spyOn(Range.prototype, 'setStart')
    const setEnd = vi.spyOn(Range.prototype, 'setEnd')
    expect(execute(highlightScript(), { start, end: start + 'line 🦊'.length })).toMatchObject({ ok: true })
    expect(setStart).toHaveBeenCalledWith(node, 0)
    expect(setEnd).toHaveBeenCalledWith(node, 'line 🦊'.length)
  })

  it('keeps legacy unstructured snapshots locatable with their original map', () => {
    select('<p>First</p><p>Second</p>')
    expect(execute<{ text: string }>(pageTextScript(), { legacy: true }).text).toBe('FirstSecond')
    const node = document.querySelectorAll('p')[1]!.firstChild!
    const setStart = vi.spyOn(Range.prototype, 'setStart')
    expect(execute(highlightScript(), { legacy: true, start: 5, end: 11 })).toMatchObject({ ok: true })
    expect(setStart).toHaveBeenCalledWith(node, 0)
  })

  it('scrolls to the quoted range and keeps its guest highlight and selection until interaction', () => {
    document.body.innerHTML = '<p>quoted list item</p>'
    let scrollY = 0
    vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scrollY)
    vi.spyOn(window, 'scrollTo').mockImplementation(options => { scrollY = (options as ScrollToOptions).top ?? 0 })
    vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(() => [
      { ...box, top: 2400 - scrollY, bottom: 2420 - scrollY },
    ] as unknown as DOMRectList)
    vi.useFakeTimers()
    try {
      expect(execute(highlightScript(), { start: 0, end: 16 })).toEqual({ ok: true, rects: 1, scrolled: true })
      expect(scrollY).toBeGreaterThan(0)
      expect(2400 - scrollY).toBeGreaterThanOrEqual(0)
      expect(2420 - scrollY).toBeLessThan(window.innerHeight)
      const highlight = document.querySelector<HTMLElement>('#__dsh-ref-highlight > div')!
      expect(highlight.style.top).toBe('2400px')
      expect(highlight.style.background).not.toBe('')
      expect(window.getSelection()!.toString()).toBe('quoted list item')
      vi.advanceTimersByTime(7000)
      expect(document.querySelector('#__dsh-ref-highlight > div')).toBe(highlight)
      expect(window.getSelection()!.toString()).toBe('quoted list item')
      window.dispatchEvent(new Event('pointerdown'))
      expect(document.getElementById('__dsh-ref-highlight')).toBeNull()
    } finally { vi.useRealTimers() }
  })

  it.each(['empty', 'no geometry', 'scroll refused'])('does not acknowledge an invisible guest highlight: %s', failure => {
    document.body.innerHTML = '<p>quoted list item</p>'
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue(
      [failure === 'no geometry' ? { ...box, width: 0, height: 0 } : { ...box, top: 2400, bottom: 2420 }] as unknown as DOMRectList,
    )
    expect(execute(highlightScript(), { start: 0, end: failure === 'empty' ? 0 : 16 })).toMatchObject({ ok: false })
    expect(document.getElementById('__dsh-ref-highlight')).toBeNull()
  })

  it.each([3000, MAX_REFERENCE_TEXT])('admits %i characters through server and draft validation', async length => {
    const { group } = await submit(select(`<p>${'x'.repeat(length)}</p>`))
    expect(group.parts[0]!.text).toHaveLength(length)
    expect(isOrderedReferenceGroup(JSON.parse(JSON.stringify(group)))).toBe(true)
  })

  it('refuses content above the shared limit on both sides', async () => {
    const { outcome } = await stored(select(`<p>${'x'.repeat(MAX_REFERENCE_TEXT + 1)}</p>`))
    expect(outcome.reference).toBeUndefined()
    expect(outcome.failures).toContainEqual(expect.objectContaining({ reason: 'text-too-long' }))
    expect(isOrderedReferenceGroup({ referenceId: 'r', parts: [{ kind: 'text', referenceId: 'r', partId: 't', text: 'x'.repeat(MAX_REFERENCE_TEXT + 1) }] })).toBe(false)
  })

  it.each([MAX_REFERENCE_TEXT - 1, MAX_REFERENCE_TEXT + 1])('measures %i model-facing characters independently of formula MathML', async length => {
    const latex = '\\sqrt[3]{x}'
    const plain = 'x'.repeat(length - latex.length - 2)
    const raw = select(`<p>${plain}<math><mroot><mi>x</mi><mn>3</mn></mroot></math></p>`)
    const { outcome } = await stored(raw)
    if (length > MAX_REFERENCE_TEXT) {
      expect(outcome.reference).toBeUndefined()
      expect(outcome.failures).toContainEqual(expect.objectContaining({ reason: 'text-too-long' }))
      return
    }
    expect(outcome.failures).toEqual([])
    const part = outcome.reference!.parts[0]!
    expect(part.type).toBe('text')
    if (part.type !== 'text') throw new Error('missing text part')
    expect(renderReferenceText(part.content!)).toBe(`${plain}$${latex}$`)
    expect(renderReferenceText(part.content!)).toHaveLength(length)
    expect(isOrderedReferenceGroup(toOrderedGroup(outcome.reference!))).toBe(true)
    const markup = renderToStaticMarkup(createElement(ReferenceText, { content: part.content! }))
    expect(markup).toContain('<mroot>')
  })

  it('drops excessive auxiliary MathML but keeps source TeX and model text', async () => {
    const raw = select('<p><math><mroot><mi>x</mi><mn>3</mn></mroot></math></p>')
    const event = raw.events![0]!
    for (const mathml of ['<math>' + 'x'.repeat(64_000) + '</math>', 123]) {
      const { snapshot, parts } = await submit({ ...raw, events: [{ ...event,
        content: [{ type: 'math', latex: '\\sqrt[3]{x}', display: false, mathml } as never],
      }] })
      expect(snapshot.parts[0]).toMatchObject({ content: [{ type: 'math', latex: '\\sqrt[3]{x}', display: false }] })
      const part = snapshot.parts[0]!
      if (part.type !== 'text') throw new Error('missing text part')
      expect(part.content![0]).not.toHaveProperty('mathml')
      expect(parts).toEqual([{ type: 'text', text: '$\\sqrt[3]{x}$\n' }])
      expect(renderToStaticMarkup(createElement(ReferenceText, { content: part.content! }))).toContain('class="katex"')
    }
  })

  it('excludes hidden and executable content and refuses malformed semantic payloads', async () => {
    const raw = select('<p>safe<script>danger()</script><span style="display:none">hidden</span><a href="javascript:alert(1)"> text</a></p>')
    const { parts } = await submit(raw)
    expect(parts).toEqual([{ type: 'text', text: 'safe text\n' }])
    const event = raw.events![0]!
    const { outcome } = await stored({ ...raw, events: [{ ...event, content: [{ type: 'link', href: 'javascript:alert(1)', children: [{ type: 'text', text: event.exact! }] }] }] })
    expect(outcome.failures).toContainEqual({ kind: 'text', reason: 'invalid-text-content' })
    expect(isReferenceText([{ type: 'html', text: '<script>' }])).toBe(false)
  })

  it('escapes markup-like text while preserving code and treats an empty selection as empty', async () => {
    const { parts } = await submit(select('<p>&lt;img src=x&gt; [literal] <code>a*b</code></p><pre>one\n  two</pre>'))
    expect(parts).toEqual([{ type: 'text', text: '\\<img src=x\\> \\[literal\\] ` a*b `\n\n```\none\n  two\n```\n' }])
    window.getSelection()!.removeAllRanges()
    expect(execute(captureScript())).toMatchObject({ ok: false, reason: 'no-selection' })
    expect(renderReferenceText([])).toBe('')
    expect(wireSubmissionContent({ uploaded: [], text: '', groups: [], admitImage: () => undefined })).toEqual([])
  })

  it('preserves nested block boundaries without nesting paragraph elements', async () => {
    const { parts, group } = await submit(select('<main><section>Before<div><p>Inside</p><p>Next</p></div>After</section></main>'))
    expect(parts).toEqual([{ type: 'text', text: 'Before\n\nInside\n\nNext\n\nAfter\n' }])
    const html = renderToStaticMarkup(createElement(ReferenceText, { content: group.parts[0]!.content! }))
    expect(html).toContain('<div>Before<div><p>Inside</p><p>Next</p></div>After</div>')
  })

  it('uses the same structured capture in same-origin frames', async () => {
    const iframe = document.createElement('iframe')
    iframe.id = 'quote-frame'
    document.body.append(iframe)
    const frame = iframe.contentWindow!
    const frameDocument = iframe.contentDocument!
    vi.spyOn(frameDocument.body, 'getBoundingClientRect').mockReturnValue(box)
    frameDocument.body.innerHTML = '<p>Frame <strong>bold</strong></p><p>Next<br>line</p>'
    for (const element of frameDocument.querySelectorAll('*')) vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(box)
    const range = frameDocument.createRange()
    range.selectNodeContents(frameDocument.body)
    frame.getSelection()!.addRange(range)
    const raw = execute<RawCaptureResult>(frameCaptureScript(), { frameSelector: '#quote-frame' })
    expect(raw).toMatchObject({ ok: true, url: window.location.href, frameUrl: frame.location.href })
    const { parts } = await submit(raw)
    expect(parts).toEqual([{ type: 'text', text: 'Frame **bold**\n\nNext  \nline\n' }])
    frame.getSelection()!.removeAllRanges()
    expect(execute<{ ok: boolean; reason: string }>(frameCaptureScript(), { frameSelector: '#quote-frame' })).toMatchObject({ ok: false, reason: 'no-selection' })
    expect(execute<{ ok: boolean; reason: string }>(frameCaptureScript(), { frameSelector: '#missing' })).toMatchObject({ ok: false, reason: 'frame-not-found' })
  })
})
