// The one time teamree mentions a release by itself: a corner card, never a modal, since the news is
// never urgent. Quiet while a copy is fetched in the background; Download leaves it up so the notes stay readable.

import { useMemo, useState } from 'react'
import { useWorkspaceStore } from '../state/workspaceStore'
import { cliOffer } from '../dialogs/cliInstallModel'
import { modalOnScreen } from '../dialogs/modalLayer'
import { openInBrowser } from '../shell/openInBrowser'
import { InstallerButton } from './InstallerButton'
import { releaseNotesHtml } from './releaseNotes'
import { INSTALL_DOCUMENT, installerStep, updateNotice } from './updateNotice'

const LATER_KEY = 'teamree.updates.later'
const storage = typeof window === 'undefined' ? undefined : window.localStorage

/** The version put off, and when; an older entry is the bare version. */
type Later = { version: string; at: number }

function readLater(): Later | null {
  try {
    const stored = storage?.getItem(LATER_KEY) ?? null
    if (stored === null) return null
    const parsed: unknown = stored.startsWith('{') ? JSON.parse(stored) : { version: stored, at: 0 }
    const { version, at } = parsed as Partial<Later>
    return typeof version === 'string' && typeof at === 'number' ? { version, at } : null
  } catch {
    return null
  }
}

function writeLater(later: Later): void {
  try {
    storage?.setItem(LATER_KEY, JSON.stringify(later))
  } catch {
    // Blocked storage only costs the card coming back next launch.
  }
}

/** Links in the card go to the browser, never this window. */
function openLink(event: React.MouseEvent): void {
  const anchor = event.target instanceof Element ? event.target.closest('a') : null
  if (anchor === null) return
  event.preventDefault()
  openInBrowser(anchor.href)
}

export function UpdateAvailableCard(): React.JSX.Element | null {
  const update = useWorkspaceStore((state) => state.update)
  const cli = useWorkspaceStore((state) => state.cli)
  const dialog = useWorkspaceStore((state) => state.dialog)
  // A remote-keystrokes question is not in `dialog` but has a scrim, so the card waits under it.
  const consent = useWorkspaceStore((state) => state.consent)

  // Later is kept per version: a newer release, or a person checking again, brings the card back.
  const [later, setLater] = useState(readLater)

  const notice = updateNotice(update)
  const step = installerStep(update)
  const notes = notice?.notes ?? null
  const notesHtml = useMemo(() => (notes === null ? null : releaseNotesHtml(notes)), [notes])

  // Nothing to say, something modal on top, or the first-run question (asked first).
  if (notice === null || step === null || modalOnScreen({ dialog, consent }) || cliOffer(cli) !== null) return null
  if (update?.install?.state === 'downloading') return null
  const version = update?.available?.version ?? ''
  if (later?.version === version && (update?.askedAt ?? 0) <= later.at) return null

  return (
    // A status, so a screen reader says it once as it arrives rather than leaving it to be found.
    <aside
      className="update-card"
      role="status"
      aria-label="A newer version of teamree is available"
      onClick={openLink}
    >
      <p className="update-card__headline">{notice.headline}</p>
      {notice.detail === null ? null : <p className="update-card__detail">{notice.detail}</p>}

      {notesHtml === null ? null : (
        // Safe as HTML: `releaseNotesHtml` escapes every tag the body carries.
        <div className="update-card__notes" dangerouslySetInnerHTML={{ __html: notesHtml }} />
      )}

      {step.problem === null ? null : <p className="update-card__problem">{step.problem}</p>}

      <div className="update-card__actions">
        {notice.ready ? null : (
          <a className="update-card__link" href={INSTALL_DOCUMENT}>
            {notice.install}
          </a>
        )}
        <button
          type="button"
          className="button button--ghost"
          onClick={() => {
            const put = { version, at: Date.now() }
            writeLater(put)
            setLater(put)
          }}
        >
          Later
        </button>
        <InstallerButton step={step} className="button button--primary" />
      </div>
    </aside>
  )
}
