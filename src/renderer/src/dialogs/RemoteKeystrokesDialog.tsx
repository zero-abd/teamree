// The question the owner is asked before somebody else's keystrokes run.
//
// This is the one dialog in the app whose contents are chosen by another
// machine, and everything about it is shaped by that:
//
// **It is not dismissible.** Escape and a click on the backdrop do nothing.
// Every other modal here closes on both, because every other modal is the
// user's own action and abandoning it means the action does not happen. This
// one is somebody else's action, already in flight, and a stray key must not be
// able to answer it either way. The four buttons and the clock are the only
// ways out, and the clock's answer is a refusal.
//
// Which is also why it has to own the keyboard outright while it is up, and why
// that takes two pieces of work elsewhere rather than none. It is not in the
// store's `dialog` — nobody in this window opened it — so `useWorkspaceShortcuts`
// names it separately, and `Modal` keeps a stack so that a panel this one
// rendered over goes inert rather than answering keys from underneath it. A
// dialog that refuses to close is the worst possible thing to leave a live
// chord under: whatever it did happened out of sight, on a window the person
// cannot reach until they have answered this.
//
// **The bytes are text and never markup.** `preview` arrives already rendered
// by `writePreview.ts` — control characters in caret notation, escape sequences
// shown rather than obeyed, the characters that reverse or hide text named
// instead of printed — and React escapes what is left. A sender cannot paint
// this dialog, which is the property the whole prompt rests on: a question
// somebody can repaint is a question they can answer for you.
//
// **It says who, which pane, and what, together.** Each of the three alone is
// answerable and wrong. "Ana wants to type" is not a question anybody can weigh
// up; "allow `rm -rf .`" with no name on it is worse.
//
// **It never asks twice for one burst.** The runtime gathers a run of
// keystrokes into one request and the preview grows underneath; what the owner
// clicks is an answer about the number of keystrokes they were shown, and
// anything that arrived after that comes back as a new question rather than
// riding in on this one.

import { useEffect, useState } from 'react'
import type { ConsentRequest } from '@shared/entities'
import { Modal } from './Modal'
import { useWorkspaceStore } from '../state/workspaceStore'

/** How often the countdown is redrawn. A second, because it counts seconds. */
const TICK_MS = 1_000

export function RemoteKeystrokesDialog({ request }: { request: ConsentRequest }): React.JSX.Element {
  const decideConsent = useWorkspaceStore((state) => state.decideConsent)
  const [now, setNow] = useState(() => Date.now())

  // The clock is the fourth answer: if nobody touches this, the request expires
  // on the runtime's own timer and the teammate is told so. Counting it down
  // here means the owner is never surprised by the dialog closing itself.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [])

  const secondsLeft = Math.max(0, Math.ceil((request.expiresAt - now) / 1000))
  // The count the owner is looking at, which is the whole of what "allow once"
  // is an answer about.
  const shown = request.writes

  return (
    <Modal
      title={`${request.handle} wants to type in ${request.terminalId}`}
      description={'This runs on your machine, as you. Nothing below has happened yet — read it, then decide.'}
      // Deliberately nothing. A question about somebody else's keystrokes is
      // not one a stray Escape gets to answer; the buttons and the clock are
      // the only ways this closes.
      onClose={() => {}}
    >
      <div className="consent">
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
        {request.clipped ? (
          <p className="consent__clipped">
            More is being held than fits here. Allowing it allows all of it — if that is not what you want, refuse and
            ask them what they sent.
          </p>
        ) : null}

        <p className="consent__who">
          {request.handle} is on this project’s roster as {request.publicKey.slice(0, 12)}…
        </p>

        <div className="consent__actions">
          <button
            type="button"
            className="button button--danger"
            onClick={() => void decideConsent(request.id, 'deny', shown)}
          >
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

        <p className="consent__note">
          “This session” lasts until teamree quits or the link to {request.handle} drops. “Always” lasts until you lift
          it or the pane closes — muting the pane lifts every permission on it. Whatever you choose, every keystroke
          that lands is recorded on this machine.
        </p>
      </div>
    </Modal>
  )
}
