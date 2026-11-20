// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createElement } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToString } from 'katex'
import { isReferenceText, renderReferenceText } from '../../../../reference-text.ts'
import { ReferenceMath } from '../production/ReferenceMath.tsx'

vi.mock('katex', async importOriginal => {
  const actual = await importOriginal<typeof import('katex')>()
  return { ...actual, renderToString: vi.fn(actual.renderToString) }
})

afterEach(cleanup)

describe('locally bundled formula preview', () => {
  it.each([false, true])('typesets formulas with display=%s without changing model source', display => {
    const node = { type: 'math' as const, latex: '\\frac{x^2}{y}', display }
    const { container } = render(createElement(ReferenceMath, { node }))
    expect(container.querySelector('.katex')).not.toBeNull()
    expect(Boolean(container.querySelector('.katex-display'))).toBe(display)
    expect(container.querySelector('[data-reference-math]')?.getAttribute('style')).toBe(`display: ${display ? 'block' : 'inline'};`)
    expect(renderToString).toHaveBeenLastCalledWith(node.latex, expect.objectContaining({
      displayMode: display, throwOnError: false, trust: false, strict: 'error', maxExpand: 1000, maxSize: 20,
    }))
    expect(renderReferenceText([node])).toBe(display ? '$$\n\\frac{x^2}{y}\n$$' : '$\\frac{x^2}{y}$')
  })

  it.each(['\\frac{', ''])('retains code-styled source when KaTeX rejects a formula: %s', latex => {
    vi.mocked(renderToString).mockImplementationOnce(() => { throw new Error('render failed') })
    const { container } = render(createElement(ReferenceMath, { node: { type: 'math', latex, display: false } }))
    expect(container.querySelector('.katex')).toBeNull()
    expect(container.querySelector('code')?.textContent).toBe(latex)
  })

  it('uses source fallback for a non-throwing KaTeX parse error', () => {
    const { container } = render(createElement(ReferenceMath, { node: { type: 'math', latex: '\\frac{', display: true } }))
    expect(container.querySelector('code')?.textContent).toBe('\\frac{')
    expect(container.querySelector('.katex-error')).toBeNull()
  })

  it('does not trust formula commands or turn source fallback into HTML', () => {
    const { container } = render(createElement(ReferenceMath, { node: { type: 'math', latex: '\\href{javascript:alert(1)}{x}', display: false } }))
    expect(container.querySelector('a, script, img')).toBeNull()
  })

  it('renders only allowlisted native MathML, keeping model LaTeX unchanged', () => {
    const node = { type: 'math' as const, latex: 'x^{2}', display: false,
      mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" onclick="alert(1)"><msup style="background:url(https://evil.example/x)"><mi href="https://evil.example">x</mi><mn>2</mn></msup><annotation-xml encoding="text/html"><img src="https://evil.example/x"/></annotation-xml><script>alert(1)</script></math>' }
    const { container } = render(createElement(ReferenceMath, { node }))
    expect(container.querySelector('math msup mi')?.textContent).toBe('x')
    expect(container.querySelector('math')?.namespaceURI).toBe('http://www.w3.org/1998/Math/MathML')
    expect(container.querySelector('[onclick], [style], [href], img, script, annotation-xml')).toBe(container.firstElementChild)
    expect(container.querySelector('math')?.outerHTML).not.toContain('evil.example')
    expect(renderReferenceText([node])).toBe('$x^{2}$')
    expect(isReferenceText([node])).toBe(true)
    expect(isReferenceText([{ ...node, mathml: 42 }])).toBe(false)
    expect(isReferenceText([{ ...node, mathml: 'x'.repeat(64_001) }])).toBe(false)
  })

  it.each(['<math><mfrac></math>', '<!DOCTYPE math><math/>', '<math><unknown/></math>', '<math>' + '<mrow>'.repeat(40) + 'x' + '</mrow>'.repeat(40) + '</math>'])('falls back for malformed, unsafe or expensive MathML', mathml => {
    const { container } = render(createElement(ReferenceMath, { node: { type: 'math', latex: 'x', display: false, mathml } }))
    expect(container.querySelector('code')?.textContent).toBe('x')
  })

  it('ships CSS and all twenty WOFF2 fonts locally, without a CDN', () => {
    const file = createRequire(import.meta.url).resolve('katex/dist/katex.min.css')
    const css = readFileSync(file, 'utf8')
    expect(css.match(/@font-face/g)).toHaveLength(20)
    const fonts = [...css.matchAll(/url\(fonts\/([^)]+\.woff2)\)/g)]
    expect(fonts).toHaveLength(20)
    for (const [, font] of fonts) expect(readFileSync(join(dirname(file), 'fonts', font!)).length).toBeGreaterThan(0)
    expect(css).not.toMatch(/url\(["']?(?:https?:)?\/\//)
    expect(css).toContain('.katex')
  })
})
