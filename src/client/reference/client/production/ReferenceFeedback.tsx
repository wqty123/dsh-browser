/** Source-navigation feedback belongs to the shell, so clearing or switching the draft does not hide it. */
import { useRef, useState, type ReactNode } from 'react'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'

interface Notice { readonly status: string; readonly message: string }

/** Each new outcome restarts the native toast; unrelated polling never extends its lifetime. */
export function ReferenceFeedback({ notice }: { readonly notice?: Notice }): ReactNode {
  const last = useRef<{ readonly notice: Notice | undefined; readonly id: number }>({ notice: undefined, id: 0 })
  const [dismissed, setDismissed] = useState(0)
  if (last.current.notice !== notice) last.current = { notice, id: last.current.id + 1 }
  const id = last.current.id
  if (notice === undefined || notice.message === '' || id === dismissed) return null
  return <Toast key={id} text={notice.message} onDone={() => { setDismissed(id) }} />
}
