import type { ReactNode } from 'react'
import { ReferenceCapsules, type ReferenceCapsulesProps } from './ReferenceCapsules.tsx'

export function ReferenceDock(props: Omit<ReferenceCapsulesProps, 'readOnly' | 'anchor'>): ReactNode {
  return <ReferenceCapsules {...props} readOnly={false} />
}
