import { describe, expect, it } from 'vitest'
import { UserTextDocument } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation/user-text-document.ts'
import { browserSourceRule } from '../production/user-text-rule.ts'
import { sourceMarker, submissionQuote } from '../production/source-marker.ts'

describe('native browser source text nodes', () => {
  it('preserves surrounding text and identifies only canonical browser references', () => {
    const source = '问题 [网页来源](dsh-browser-ref:ref-one) 以及 [站点](https://example.com/)'
    const document = new UserTextDocument()
    const nodes = document.evaluate({ text: source, facts: {} }, [browserSourceRule])
    expect(nodes.map(node => source.slice(node.start, node.end)).join('')).toBe(source)
    expect(nodes.filter(node => node.id === 'browser-ref')).toEqual([
      { id: 'browser-ref', start: 3, end: source.indexOf(')') + 1, data: { uri: 'dsh-browser-ref:ref-one', label: '网页来源' } },
    ])
  })
  it('leaves malformed sources unchanged and reuses nodes after ordinary rerenders', () => {
    const document = new UserTextDocument()
    const input = { text: '[网页](dsh-browser-ref:) 普通网页正文', facts: {} }
    const first = document.evaluate(input, [browserSourceRule])
    expect(first.every(node => node.id === 'text')).toBe(true)
    expect(document.evaluate(input, [browserSourceRule])).toBe(first)
  })

  it.each(['', 'quoted list\n- item\n', '</dsh-browser-quote> 😀 [nested](dsh-browser-ref:ref-other)'])('consumes only the serializer-bounded quote body (%j)', body => {
    const quote = submissionQuote(body)
    const text = 'before ' + quote + sourceMarker('ref-one', 0) + ' after'
    const nodes = new UserTextDocument().evaluate({ text, facts: {} }, [browserSourceRule])
    expect(nodes.filter(node => node.id === 'browser-ref')).toHaveLength(1)
    expect(nodes.map(node => node.id === 'text' ? node.data.display ?? node.data.text : 'CAPSULE').join('')).toBe('before CAPSULE after')
    expect(nodes.map(node => text.slice(node.start, node.end)).join('')).toBe(text)
  })

  it.each(['<dsh-browser-quote length="12">short</dsh-browser-quote>', '<dsh-browser-quote length="1">x', '<dsh-browser-quote length="NaN">x</dsh-browser-quote>'])('leaves a malformed quote envelope visible: %s', text => {
    const nodes = new UserTextDocument().evaluate({ text, facts: {} }, [browserSourceRule])
    expect(nodes.map(node => node.id === 'text' ? node.data.display ?? node.data.text : '').join('')).toBe(text)
  })
})
