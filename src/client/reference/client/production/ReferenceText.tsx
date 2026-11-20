import type { ReactNode } from 'react'
import type { ReferenceTextNode } from '../../../../reference-text.ts'
import { ReferenceMath } from './ReferenceMath.tsx'

export function ReferenceText({ content }: { readonly content: readonly ReferenceTextNode[] }): ReactNode {
  return content.map((node, index) => {
    if (node.type === 'text') return node.text
    if (node.type === 'break') return <br key={index} />
    if (node.type === 'rule') return <hr key={index} />
    if (node.type === 'math') return <ReferenceMath key={index} node={node} />
    const children = <ReferenceText content={node.children} />
    switch (node.type) {
      case 'block': return <div key={index}>{children}</div>
      case 'paragraph': return <p key={index}>{children}</p>
      case 'strong': return <strong key={index}>{children}</strong>
      case 'emphasis': return <em key={index}>{children}</em>
      case 'code': return <code key={index}>{children}</code>
      case 'pre': return <pre key={index} data-language={node.language}>{children}</pre>
      case 'heading': {
        const Heading = `h${node.level}` as 'h1'
        return <Heading key={index}>{children}</Heading>
      }
      case 'definition-list': return <dl key={index}>{children}</dl>
      case 'term': return <dt key={index}>{children}</dt>
      case 'definition': return <dd key={index}>{children}</dd>
      case 'sup': return <sup key={index}>{children}</sup>
      case 'sub': return <sub key={index}>{children}</sub>
      case 'ruby': return <ruby key={index}>{children}</ruby>
      case 'ruby-text': return <rt key={index}>{children}</rt>
      case 'blockquote': return <blockquote key={index}>{children}</blockquote>
      case 'list-item': return <li key={index} value={node.value}>{children}</li>
      case 'list': return node.ordered ? <ol key={index} start={node.start}>{children}</ol> : <ul key={index}>{children}</ul>
      case 'link': return <span key={index} title={node.href} data-reference-href={node.href}>{children}</span>
    }
  })
}
