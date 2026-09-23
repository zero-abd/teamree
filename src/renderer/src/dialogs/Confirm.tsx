// A question with two answers, in the one shape every such question takes.
//
// Everything a confirm in this app is made of is decided here and nowhere
// else: the frame is `Modal`'s, the title is the question, the body is one
// line, and the two buttons sit in one right-aligned row with the answer that
// changes nothing first and the answer that goes through with it last. When
// going through with it destroys something the last button is red.
//
// The keyboard follows the same rule. Escape is always the cancel — `Modal`
// already does that — and Enter is whichever answer is safe to give without
// reading: the cancel when the confirm destroys something, the confirm when it
// does not. That is done by putting the focus there on open, so the key that
// activates a focused button is the key, and there is no second handler that
// could disagree with what the focus ring shows.
//
// The two confirms that existed before this used to lay themselves out — each
// with its own actions row and neither with the padding the frame gave its
// title, so their sentence started further left than the question above it.

import { Modal } from './Modal'

type ConfirmProps = {
  /** The question, short. It is the dialog's title and its accessible name. */
  title: string
  /** One line: what is there, and what going through with it costs. */
  body: string
  /** The answer that changes nothing. A verb phrase, never "Cancel" alone. */
  cancel: string
  /** The answer that goes through with it. Names the act, never "OK". */
  confirm: string
  /** `danger` when the confirm destroys something; it is drawn red and Enter goes to the cancel. */
  tone?: 'danger' | 'primary'
  onCancel: () => void
  onConfirm: () => void
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
  children
}: ConfirmProps): React.JSX.Element {
  const destructive = tone === 'danger'
  return (
    <Modal title={title} onClose={onCancel}>
      <div className="confirm">
        <p className="confirm__body">{body}</p>
        {children}
        <div className="modal__actions">
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
