// A question with two answers, in one shape: `Modal`'s frame, the question as title, one body line, and
// the no-op answer before the one that acts (red when it destroys). Focus starts on the safe answer,
// so Enter never needs a second handler. A Save question adds Don't Save, alone on the left as on macOS.

import { useMemo } from 'react'
import { detectPlatform, matchesChord, resolvePlatformModifier } from '../keyboard/platformModifier'
import { Modal } from './Modal'

type ConfirmProps = {
  /** The question, short. It is the dialog's title and its accessible name. */
  title: string
  /** One line: what is there, and what going through with it costs. Absent when the children say it. */
  body?: string
  /** The answer that changes nothing. A verb phrase; "Cancel" only beside Save, as macOS writes it. */
  cancel: string
  /** The answer that goes through with it. Names the act, never "OK". */
  confirm: string
  /** `danger` when the confirm destroys something; it is drawn red and Enter goes to the cancel. */
  tone?: 'danger' | 'primary'
  onCancel: () => void
  onConfirm: () => void
  /** A third answer that goes on without the confirm's act, e.g. Don't Save; ⌘D chooses it, as in a macOS sheet. */
  decline?: { label: string; onChoose: () => void }
  /** Anything under the body line — a count, a path — that the question needs shown. */
  children?: React.ReactNode
}

export function Confirm({
  title,
  body,
  cancel,
  confirm,
  tone = 'danger',
  onCancel,
  onConfirm,
  decline,
  children
}: ConfirmProps): React.JSX.Element {
  const destructive = tone === 'danger'
  const modifier = useMemo(
    () =>
      resolvePlatformModifier(
        detectPlatform(window.teamree?.platform, typeof navigator === 'undefined' ? undefined : navigator.userAgent)
      ),
    []
  )
  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (decline === undefined || !matchesChord(event, { key: 'd' }, modifier)) return
    event.preventDefault()
    decline.onChoose()
  }
  return (
    <Modal title={title} onClose={onCancel}>
      <div className="confirm" onKeyDown={onKeyDown}>
        {body === undefined ? null : <p className="confirm__body">{body}</p>}
        {children}
        <div className="modal__actions">
          {decline === undefined ? null : (
            <button type="button" className="button confirm__decline" onClick={decline.onChoose}>
              {decline.label}
            </button>
          )}
          <button type="button" className="button" data-default={destructive ? 'true' : undefined} onClick={onCancel}>
            {cancel}
          </button>
          <button
            type="button"
            className={`button ${destructive ? 'button--danger' : 'button--primary'}`}
            data-default={destructive ? undefined : 'true'}
            onClick={onConfirm}
          >
            {confirm}
          </button>
        </div>
      </div>
    </Modal>
  )
}
