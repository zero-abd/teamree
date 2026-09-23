// The one time teamree mentions a release by itself: a corner card, never a modal, since the news is
// never urgent. Download leaves the card up so the notes stay readable. The notes are somebody else's
// words: render them only as a text child, never as markup (`plainText` already stripped controls).

import { useState } from 'react'
import { useWorkspaceStore } from '../state/workspaceStore'
import { cliOffer } from '../dialogs/cliInstallModel'
import { modalOnScreen } from '../dialogs/modalLayer'
import { InstallerButton } from './InstallerButton'
import { INSTALL_DOCUMENT, installerStep, updateNotice } from './updateNotice'

export function UpdateAvailableCard(): React.JSX.Element | null {
  const update = useWorkspaceStore((state) => state.update)
  const cli = useWorkspaceStore((state) => state.cli)
  const dialog = useWorkspaceStore((state) => state.dialog)
  // A remote-keystrokes question is not in `dialog` but has a scrim, so the card waits under it.
  const consent = useWorkspaceStore((state) => state.consent)
  const setAutomaticUpdates = useWorkspaceStore((state) => state.setAutomaticUpdates)

  // Dismissal is keyed by the check it saw; a later check is a new answer and shows again.
  const [dismissed, setDismissed] = useState<number | null>(null)

  const notice = updateNotice(update)
  const step = installerStep(update)
  // Nothing to say, something modal on top, or the first-run question (same corner, asked first).
  if (notice === null || step === null || modalOnScreen({ dialog, consent }) || cliOffer(cli) !== null) return null
  if (dismissed !== null && dismissed === update?.checkedAt) return null

  return (
    <aside className="update-card" aria-label="A newer version of teamree is available">
      <p className="update-card__headline">{notice.headline}</p>
      <p className="update-card__detail">{notice.detail}</p>

      {notice.notes === null ? null : (
        // `pre-wrap` in the stylesheet keeps the breaks without sideways scrolling.
        <p className="update-card__notes">{notice.notes}</p>
      )}

      {step.problem === null ? null : <p className="update-card__problem">{step.problem}</p>}

      <p className="update-card__install">
        {notice.install}{' '}
        <a className="update-card__link" href={INSTALL_DOCUMENT} target="_blank" rel="noreferrer">
          Open it
        </a>
      </p>

      <div className="update-card__actions">
        <button
          type="button"
          className="button button--ghost"
          onClick={() => {
            // Turning the preference off stops the runtime offering this release on every launch.
            setDismissed(update?.checkedAt ?? 0)
            void setAutomaticUpdates(false)
          }}
        >
          {notice.silence}
        </button>
        <InstallerButton step={step} className="button button--primary" />
      </div>
    </aside>
  )
}
