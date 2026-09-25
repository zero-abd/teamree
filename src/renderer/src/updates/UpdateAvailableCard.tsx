// The one time teamree mentions a release by itself: a corner card, never a modal, since the news is
// never urgent. Quiet while a copy is fetched in the background; Download leaves it up so the notes stay readable.

import { useMemo, useState } from 'react'
import { APP_MANAGEMENT_SETTINGS } from '@shared/entities'
import { useWorkspaceStore } from '../state/workspaceStore'
import { cliOffer } from '../dialogs/cliInstallModel'
import { modalOnScreen } from '../dialogs/modalLayer'
import { openInBrowser } from '../shell/openInBrowser'
import { InstallerButton } from './InstallerButton'
import { releaseNotesHtml } from './releaseNotes'
import { INSTALL_DOCUMENT, installerStep, updateNotice } from './updateNotice'

const LATER_KEY = 'teamree.updates.later'
/** The version whose card was shrunk to a pill. */
const MINIMIZED_KEY = 'teamree.updates.minimized'
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

function readMinimized(): string | null {
  try {
    return storage?.getItem(MINIMIZED_KEY) ?? null
  } catch {
    return null
  }
}

function writeMinimized(version: string | null): void {
  try {
    if (version === null) storage?.removeItem(MINIMIZED_KEY)
    else storage?.setItem(MINIMIZED_KEY, version)
  } catch {
    // Blocked storage only costs the pill opening back up next launch.
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
  const [minimized, setMinimized] = useState(readMinimized)

  const notice = updateNotice(update)
  const step = installerStep(update)
  const notes = notice?.notes ?? null
  const notesHtml = useMemo(() => (notes === null ? null : releaseNotesHtml(notes)), [notes])

  // Nothing to say, something modal on top, or the first-run question (asked first).
  if (notice === null || step === null || modalOnScreen({ dialog, consent }) || cliOffer(cli) !== null) return null
  if (update?.install?.state === 'downloading') return null
  const version = update?.available?.version ?? ''
  if (later?.version === version && (update?.askedAt ?? 0) <= later.at) return null

  const minimize = (shrunk: boolean): void => {
    const value = shrunk ? version : null
    writeMinimized(value)
    setMinimized(value)
  }
  const button = <InstallerButton step={step} className="button button--primary" />

  if (minimized === version) {
    return (
      <aside
        className="update-card update-card--pill"
        role="status"
        aria-label="A newer version of teamree is available"
      >
        <button type="button" className="update-card__expand" title="Show Update" onClick={() => minimize(false)}>
          {`${version} ${notice.ready ? 'ready' : 'available'}`}
        </button>
        {button}
      </aside>
    )
  }

  return (
    // A status, so a screen reader says it once as it arrives rather than leaving it to be found.
    <aside
      className="update-card"
      role="status"
      aria-label="A newer version of teamree is available"
      onClick={openLink}
    >
      <div className="update-card__head">
        <p className="update-card__headline">{notice.headline}</p>
        <button
          type="button"
          className="button button--ghost button--icon"
          aria-label="Minimize"
          title="Minimize"
          onClick={() => minimize(true)}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2.5 6h7" />
          </svg>
        </button>
      </div>
      {notice.detail === null ? null : <p className="update-card__detail">{notice.detail}</p>}

      {notesHtml === null ? null : (
        // Safe as HTML: `releaseNotesHtml` escapes every tag the body carries.
        <div
          className="update-card__notes update-card__notes--clipped"
          dangerouslySetInnerHTML={{ __html: notesHtml }}
        />
      )}

      {step.problem === null ? null : (
        <div className="update-card__problem">
          <p>{step.problem}</p>
          {step.settings ? (
            <button
              type="button"
              className="button button--small"
              onClick={() => openInBrowser(APP_MANAGEMENT_SETTINGS)}
            >
              Open Settings
            </button>
          ) : null}
        </div>
      )}

      <div className="update-card__actions">
        <span className="update-card__links">
          <a className="update-card__link" href={update?.available?.releaseUrl}>
            Release Notes
          </a>
          {notice.ready ? null : (
            <a className="update-card__link" href={INSTALL_DOCUMENT}>
              {notice.install}
            </a>
          )}
        </span>
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
        {button}
      </div>
    </aside>
  )
}
