// The one time teamree mentions a release by itself.
//
// A card in the corner, not a modal, for the same reasons the first-run CLI
// offer is one — and one more that is specific to this. An update notice
// interrupts work to deliver news that is never urgent: the app the user is
// looking at goes on working perfectly whether or not they ever press this. A
// modal for that is a modal that teaches people to dismiss modals.
//
// So: nothing is focused, nothing is blocked, and both buttons are real
// answers. "Download" opens the browser and leaves the card up, because the
// download takes a minute and a card that vanished would leave nowhere to read
// the notes. "Stop checking" is the preference, put here because this is the
// moment somebody knows whether they want it.
//
// **The notes are text and only ever text.** They are a release body off the
// GitHub API — somebody else's words — and they are rendered as a React text
// child, which escapes. There is no `dangerouslySetInnerHTML` in this file and
// there must never be one: `plainText` in the main process has already taken
// out the control characters, and everything else a body can contain is
// harmless exactly as long as nothing here renders it as markup.

import { useState } from 'react'
import { useWorkspaceStore } from '../state/workspaceStore'
import { cliOffer } from '../dialogs/cliInstallModel'
import { modalOnScreen } from '../dialogs/modalLayer'
import { INSTALL_DOCUMENT, updateNotice } from './updateNotice'

export function UpdateAvailableCard(): React.JSX.Element | null {
  const update = useWorkspaceStore((state) => state.update)
  const cli = useWorkspaceStore((state) => state.cli)
  const dialog = useWorkspaceStore((state) => state.dialog)
  // The other half of what can be on top of the window, and the half this card
  // was written before: a question about a teammate's keystrokes. It is not in
  // `dialog` because nobody in this window opened it, but it is a modal with a
  // scrim all the same — and it is the one that refuses to be dismissed, so a
  // card drawn under it stays under it until somebody answers.
  const consent = useWorkspaceStore((state) => state.consent)
  const downloadUpdate = useWorkspaceStore((state) => state.downloadUpdate)
  const setAutomaticUpdates = useWorkspaceStore((state) => state.setAutomaticUpdates)

  // Which answer has been waved away, by the moment it was found. A dismissal
  // is about what was on screen when it was pressed: a check made afterwards is
  // a new answer — and by then the only checks left are ones somebody asked for
  // — so it shows again rather than being silenced forever by one click.
  const [dismissed, setDismissed] = useState<number | null>(null)

  const notice = updateNotice(update)
  // Nothing to say; something else is already on top of the window saying
  // something; or the first-run question is on screen. The two cards share a
  // corner, and the question that was asked first is the one that gets an
  // answer — an update notice will keep until the next launch, which is more
  // than can be said for a first run.
  if (notice === null || modalOnScreen({ dialog, consent }) || cliOffer(cli) !== null) return null
  if (dismissed !== null && dismissed === update?.checkedAt) return null

  return (
    <aside className="update-card" aria-label="A newer version of teamree is available">
      <p className="update-card__headline">{notice.headline}</p>
      <p className="update-card__detail">{notice.detail}</p>

      {notice.notes === null ? null : (
        // `pre-wrap` in the stylesheet rather than a `<pre>`: notes are prose
        // with line breaks in it, and this keeps the breaks without turning
        // every line into something that scrolls sideways.
        <p className="update-card__notes">{notice.notes}</p>
      )}

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
            // Both halves of what the button says: the card goes now, and
            // teamree stops going and looking. Turning the preference off is
            // what keeps this release from being offered again on every launch
            // — the runtime stops answering with what an earlier check found.
            setDismissed(update?.checkedAt ?? 0)
            void setAutomaticUpdates(false)
          }}
        >
          {notice.silence}
        </button>
        <button type="button" className="button button--primary" onClick={() => void downloadUpdate()}>
          {notice.action}
        </button>
      </div>
    </aside>
  )
}
