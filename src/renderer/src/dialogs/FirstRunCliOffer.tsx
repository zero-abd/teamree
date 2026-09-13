// The one time teamree brings this up by itself.
//
// Deliberately not a modal. A modal on first launch is the most annoying thing
// a program can do: it takes the keyboard from somebody who has not yet seen
// the window they just opened, and the fastest way past it is to agree with a
// sentence nobody read — which is a poor way to reach a question whose answer
// may put a password dialog on the screen. This is a card in the corner. The
// window is usable behind it, nothing is focused for you, and both buttons are
// real answers: the question is recorded as asked either way and is never put
// again, with the sidebar and the palette left as the way back in.
//
// It says the same two sentences the panel says — the destination and the
// password — before either button is pressed, because "Install CLI? [Yes]" with
// a system password prompt behind the yes is how an app teaches people to stop
// reading password prompts.

import { useWorkspaceStore } from '../state/workspaceStore'
import { cliOffer } from './cliInstallModel'

export function FirstRunCliOffer(): React.JSX.Element | null {
  const status = useWorkspaceStore((state) => state.cli)
  const dialog = useWorkspaceStore((state) => state.dialog)
  const openDialog = useWorkspaceStore((state) => state.openDialog)
  const dismissCliPrompt = useWorkspaceStore((state) => state.dismissCliPrompt)

  const offer = cliOffer(status)
  // Nothing to say, or something else is already on top of the window saying
  // something: a card behind a modal is a card being talked over.
  if (offer === null || dialog !== null) return null

  return (
    <aside className="cli-offer" aria-label="Put the teamree CLI on your PATH">
      <p className="cli-offer__headline">{offer.headline}</p>
      <p className="cli-offer__detail">{offer.detail}</p>
      <p className="cli-offer__promise">{offer.promise}</p>
      <p className="cli-offer__password">{offer.password}</p>
      <div className="cli-offer__actions">
        <button type="button" className="button button--ghost" onClick={() => void dismissCliPrompt()}>
          {offer.decline}
        </button>
        <button
          type="button"
          className="button button--primary"
          onClick={() => {
            // Opening the panel rather than linking from here, so that the one
            // place that makes the link is also the one place that reports
            // what it did — and so nobody meets the password dialog on a
            // single click from a card they were still reading.
            openDialog({ kind: 'install-cli' })
            void dismissCliPrompt()
          }}
        >
          {`${offer.accept}…`}
        </button>
      </div>
      <p className="cli-offer__once">{offer.once}</p>
    </aside>
  )
}
