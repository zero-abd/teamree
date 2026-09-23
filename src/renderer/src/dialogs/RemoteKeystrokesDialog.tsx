// The question the owner is asked before somebody else's keystrokes run; its contents come from
// another machine. Not dismissible (only the buttons and the clock, which refuses), and it owns the
// keyboard while up (`useWorkspaceShortcuts` and `Modal`'s stack). `preview` arrives rendered by
// `writePreview.ts`, so a sender cannot paint it. It names who, which pane and what together, and the
// answer covers only the keystrokes shown; later ones come back as a new question.

import { useEffect, useState } from 'react'
import type { ConsentRequest } from '@shared/entities'
import { Modal } from './Modal'
import { useWorkspaceStore } from '../state/workspaceStore'

/** How often the countdown is redrawn. A second, because it counts seconds. */
const TICK_MS = 1_000

export function RemoteKeystrokesDialog({ request }: { request: ConsentRequest }): React.JSX.Element {
  const decideConsent = useWorkspaceStore((state) => state.decideConsent)
  const [now, setNow] = useState(() => Date.now())

  // The clock is the fourth answer: the runtime expires the request, and counting down here means no surprise.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [])

  const secondsLeft = Math.max(0, Math.ceil((request.expiresAt - now) / 1000))
  // "Allow once" is an answer about exactly this count.
  const shown = request.writes

  return (
    <Modal
      title={`${request.handle} wants to type in ${request.terminalId}`}
      // Deliberately nothing: a stray Escape does not answer somebody else's keystrokes.
      onClose={() => {}}
    >
      <div className="consent">
        <p className="consent__warning">Runs on your machine, as you</p>
        <p className="consent__meta">
          {shown === 1 ? '1 keystroke' : `${shown} keystrokes`}
          {' · '}
          {request.bytes === 1 ? '1 byte' : `${request.bytes} bytes`}
          {' · '}
          {secondsLeft > 0 ? `expires in ${secondsLeft}s` : 'expiring now'}
        </p>

        {/* Pre-wrapped rather than reflowed: whitespace a sender chose is part
            of what the owner is being asked to approve, and a line that looks
            like one command because it was wrapped into one would be the
            dialog choosing what the question says. */}
        <pre className="consent__preview">{request.preview}</pre>
        {request.clipped ? <p className="consent__clipped">Preview truncated · allowing allows all of it</p> : null}

        <p className="consent__who">
          {request.handle} · roster key {request.publicKey.slice(0, 12)}…
        </p>

        {/* Refuse first and plain, not red: it is the answer that changes
            nothing, which is the one a reflex should land on, and red is for
            the button that destroys something. Wrapping rather than
            scrolling: four answers is more than a row holds in a narrow
            window, and an answer off the edge is one the owner cannot give. */}
        <div className="modal__actions modal__actions--wrap">
          <button type="button" className="button" onClick={() => void decideConsent(request.id, 'deny', shown)}>
            Refuse
          </button>
          <button type="button" className="button" onClick={() => void decideConsent(request.id, 'once', shown)}>
            Allow this once
          </button>
          <button type="button" className="button" onClick={() => void decideConsent(request.id, 'session', shown)}>
            Allow until this session ends
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={() => void decideConsent(request.id, 'always', shown)}
          >
            Always allow {request.handle} here
          </button>
        </div>

        <p className="consent__note">Allowed keystrokes are logged on this machine</p>
      </div>
    </Modal>
  )
}
