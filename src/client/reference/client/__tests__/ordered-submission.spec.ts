import { describe, expect, it } from 'vitest'
import type { OrderedReferenceGroup, PromptContentPart } from '../types.ts'
import {
  projectOrderedContent,
  projectCompatibilityContent,
  createSubmissionProjector,
} from '../ordered-submission.ts'

const group: OrderedReferenceGroup = {
  referenceId: 'g1',
  parts: [
    { kind: 'text', partId: 't1', referenceId: 'g1', text: '文A' },
    { kind: 'image', partId: 'i1', referenceId: 'g1', assetKey: 'a1' },
    { kind: 'table', partId: 'tb1', referenceId: 'g1', text: '表格' },
    { kind: 'image', partId: 'i2', referenceId: 'g1', assetKey: 'a2' },
    { kind: 'text', partId: 't2', referenceId: 'g1', text: '文B' },
  ],
}
const uploaded: readonly PromptContentPart[] = [{ type: 'image', assetKey: 'up-1' }]
const orderedInput = { text: '用户补充', uploaded: [], groups: [group] }

describe('projectOrderedContent', () => {
  it('interleaves text/image/table in capture order (B18)', () => {
    const output = projectOrderedContent(orderedInput)
    expect(output.map(part => part.type)).toEqual(['text', 'image', 'table', 'image', 'text', 'text'])
    expect(output[0]).toEqual({ type: 'text', text: '文A' })
    expect(output[4]).toEqual({ type: 'text', text: '文B' })
    expect(output[5]).toEqual({ type: 'text', text: '用户补充' })
    expect(output[1]).toMatchObject({ type: 'image', assetKey: 'a1', partId: 'i1', referenceId: 'g1' })
  })

  it('supports a leading text position', () => {
    const output = projectOrderedContent(orderedInput, { textPosition: 'leading' })
    expect(output[0]).toEqual({ type: 'text', text: '用户补充' })
    expect(output.map(part => part.type)).toEqual(['text', 'text', 'image', 'table', 'image', 'text'])
  })

  it('keeps a failed image in its slot instead of silently dropping it (B20)', () => {
    const failed: OrderedReferenceGroup = {
      referenceId: 'g2',
      parts: [{ kind: 'image', partId: 'iX', referenceId: 'g2', status: 'failed' }],
    }
    const output = projectOrderedContent({ text: '', uploaded: [], groups: [failed] })
    expect(output).toEqual([{ type: 'text', text: '[image unavailable: iX]' }])
  })
})

describe('projectCompatibilityContent (default mode)', () => {
  it('reproduces the existing [...uploaded, ...text] shape (§4)', () => {
    expect(projectCompatibilityContent({ text: 'hi', uploaded, groups: [] })).toEqual([
      { type: 'image', assetKey: 'up-1' },
      { type: 'text', text: 'hi' },
    ])
    expect(projectCompatibilityContent({ text: '', uploaded, groups: [] })).toEqual([
      { type: 'image', assetKey: 'up-1' },
    ])
  })

  it('is byte-identical to ordered mode when the feature is disabled (groups empty)', () => {
    const input = { text: 'hi', uploaded, groups: [] }
    expect(projectOrderedContent(input)).toEqual(projectCompatibilityContent(input))
    expect(createSubmissionProjector().mode).toBe('compatibility')
  })
})

describe('createSubmissionProjector', () => {
  it('selects ordered vs compatibility mode through injection', () => {
    const ordered = createSubmissionProjector({ mode: 'ordered' })
    expect(ordered.mode).toBe('ordered')
    expect(ordered.project(orderedInput).map(part => part.type)).toEqual([
      'text', 'image', 'table', 'image', 'text', 'text',
    ])
    const compat = createSubmissionProjector({ mode: 'compatibility' })
    expect(compat.project(orderedInput)).toEqual(projectCompatibilityContent(orderedInput))
  })
})
