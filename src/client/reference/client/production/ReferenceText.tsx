import type { ReactNode } from 'react'
import type { ReferenceTextNode } from '../../../../reference-text.ts'

export function ReferenceText({ content }: { readonly content: readonly ReferenceTextNode[] }): ReactNode {
  return content.map((node, index) => {
    if (node.type === 'text') return node.text
    if (node.type === 'break') return <br key={index} />
    const children = <ReferenceText content={node.children} />
    switch (node.type) {
      case 'block': return <div key={index}>{children}</div>
      case 'paragraph': return <p key={index}>{children}</p>
      case 'strong': return <strong key={index}>{children}</strong>
      case 'emphasis': return <em key={index}>{children}</em>
      case 'code': return <code key={index}>{children}</code>
      case 'pre': return <pre key={index}>{children}</pre>
      case 'blockquote': return <blockquote key={index}>{children}</blockquote>
      case 'list-item': return <li key={index}>{children}</li>
      case 'list': return node.ordered ? <ol key={index} start={node.start}>{children}</ol> : <ul key={index}>{children}</ul>
      case 'link': return <span key={index} title={node.href} data-reference-href={node.href}>{children}</span>
    }
  })
}
