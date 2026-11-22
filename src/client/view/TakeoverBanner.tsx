import type { ReactNode } from 'react'
import type { TakeoverNotice } from '../../takeover-protocol.ts'
import css from './Browser.module.css'

export function TakeoverBanner(props: {
  readonly notice?: TakeoverNotice
  readonly error?: boolean
  readonly label: string
  readonly done: string
  readonly skip: string
  readonly failure: string
  readonly answer: (outcome: 'done' | 'skipped') => void
}): ReactNode {
  if (!props.notice || props.notice.phase !== 'waiting') return null
  return <div className={css.takeover} role="status">
    <span className={css.takeoverReason} title={[props.label, props.notice.instructions].filter(Boolean).join('\n')}>{props.label}</span>
    <button type="button" className={css.takeoverDone} onClick={() => { props.answer('done') }}>{props.done}</button>
    <button type="button" className={css.takeoverSkip} onClick={() => { props.answer('skipped') }}>{props.skip}</button>
    {props.error && <span role="alert">{props.failure}</span>}
  </div>
}
