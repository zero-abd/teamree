// The one time teamree offers the CLI by itself: a corner card, never a modal, asked once either way.
// It says where the link goes and that a password is coming before either button is pressed.

import { useWorkspaceStore } from '../state/workspaceStore'
import { cliOffer } from './cliInstallModel'
import { modalOnScreen } from './modalLayer'

export function FirstRunCliOffer(): React.JSX.Element | null {
  const status = useWorkspaceStore((state) => state.cli)
  const dialog = useWorkspaceStore((state) => state.dialog)
  // A remote-keystrokes question is not in `dialog` but has a scrim; the card must not draw under it.
  const consent = useWorkspaceStore((state) => state.consent)
  const openDialog = useWorkspaceStore((state) => state.openDialog)
  const dismissCliPrompt = useWorkspaceStore((state) => state.dismissCliPrompt)

  const offer = cliOffer(status)
  // Nothing to say, or something modal on top.
  if (offer === null || modalOnScreen({ dialog, consent })) return null

  return (
    <aside className="cli-offer" aria-label="Put the teamree CLI on your PATH">
      <p className="cli-offer__headline">{offer.headline}</p>
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
            // Opens the panel, which makes and reports the link; no password prompt one click from a card.
            openDialog({ kind: 'install-cli' })
            void dismissCliPrompt()
          }}
        >
          {`${offer.accept}…`}
        </button>
      </div>
    </aside>
  )
}
