import { renderToString } from 'katex'
import type { ReferenceTextNode } from '../../../../reference-text.ts'
import 'katex/dist/katex.min.css'

const mathTags = new Set('math mrow mi mn mo ms mtext mspace mfrac msqrt mroot msup msub msubsup munder mover munderover mmultiscripts mprescripts none mtable mtr mtd mstyle mpadded mphantom menclose semantics'.split(' '))
const mathAttributes = new Set('display mathvariant displaystyle scriptlevel stretchy symmetric largeop movablelimits accent accentunder columnalign rowalign columnspacing rowspacing linethickness notation width height depth lspace voffset'.split(' '))

function safeMathML(source: string): string | undefined {
  if (source.length > 64_000 || /<!/u.test(source) || typeof document === 'undefined') return undefined
  const parsed = new DOMParser().parseFromString(source, 'application/xml')
  if (parsed.querySelector('parsererror') || parsed.documentElement.localName !== 'math') return undefined
  let remaining = 1000
  const copy = (node: Node, depth: number): Node | undefined => {
    if (--remaining < 0 || depth > 32) throw new Error('MathML too large')
    if (node.nodeType === 3) return document.createTextNode(node.nodeValue ?? '')
    if (node.nodeType !== 1) return undefined
    const element = node as Element
    if (!mathTags.has(element.localName) || (element.namespaceURI !== null && element.namespaceURI !== 'http://www.w3.org/1998/Math/MathML')) return undefined
    const result = document.createElementNS('http://www.w3.org/1998/Math/MathML', element.localName)
    for (const attribute of [...element.attributes]) {
      if (attribute.namespaceURI === null && mathAttributes.has(attribute.name) && attribute.value.length <= 256) result.setAttribute(attribute.name, attribute.value)
    }
    for (const child of [...element.childNodes]) { const clean = copy(child, depth + 1); if (clean) result.appendChild(clean) }
    return result
  }
  const math = copy(parsed.documentElement, 0) as Element | undefined
  return math?.childNodes.length ? math.outerHTML : undefined
}

export function ReferenceMath({ node }: { readonly node: Extract<ReferenceTextNode, { type: 'math' }> }) {
  let html: string | undefined
  try {
    if (node.mathml !== undefined) html = safeMathML(node.mathml)
    else {
      const rendered = renderToString(node.latex, { displayMode: node.display, throwOnError: false, trust: false,
        strict: 'error', maxExpand: 1000, maxSize: 20, output: 'htmlAndMathml' })
      if (!rendered.includes('class="katex-error"')) html = rendered
    }
  } catch { /* source fallback */ }
  const props = { 'data-reference-math': node.display ? 'display' : 'inline', style: { display: node.display ? 'block' : 'inline' } as const }
  return html === undefined
    ? <code {...props} style={{ ...props.style, whiteSpace: 'pre-wrap' }}>{node.latex}</code>
    : <span {...props} dangerouslySetInnerHTML={{ __html: html }} />
}
