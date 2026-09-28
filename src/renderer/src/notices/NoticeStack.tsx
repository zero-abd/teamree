// The corner stack above the status bar: teammates' popups, this window's notices, then the update card.
// A dismissed notice slides out in place before it goes, so the stack closes the gap rather than jumping.

import { useEffect, useRef, useState } from 'react'
import { copyText } from '../clipboard/clipboard'
import { Icon } from '../icons/Icon'
import { Button, IconButton } from '../ui/Button'
import { openInBrowser } from '../shell/openInBrowser'
import { useWorkspaceStore, type Notice } from '../state/workspaceStore'
import { HandoffPopups } from '../teamwork/HandoffPopups'
import { SharedNotePopups } from '../teamwork/SharedNotePopups'
import { UpdateAvailableCard } from '../updates/UpdateAvailableCard'
import { NOTICE_ICON, noticeLook, noticeParts } from './noticeView'
import { useAnnouncements } from './useAnnouncements'

/** The slide out is 180 ms; this is only for a card whose animation never ends (none running, a test). */
const LEAVE_CEILING_MS = 400

export function NoticeStack(): React.JSX.Element {
  const spoken = useAnnouncements()
  const notices = useWorkspaceStore((state) => state.notices)
  const leaving = useLeaving(notices)
  const shown = [...notices, ...leaving.cards].sort((left, right) => left.id - right.id)

  return (
    // Bottom right above the status bar: notices stack above the update card, never over it.
    <div className="corner-stack">
      <SharedNotePopups />
      <HandoffPopups />
      {/* Always mounted: a live region added with its first message is often not heard saying it. */}
      <div className="notices" role="status" aria-live="polite">
        <span className="notices__spoken" key={spoken.serial}>
          {spoken.text}
        </span>
        {shown.map((notice) =>
          leaving.cards.includes(notice) ? (
            <NoticeCard key={notice.id} notice={notice} onLeft={() => leaving.gone(notice.id)} />
          ) : (
            <NoticeCard key={notice.id} notice={notice} />
          )
        )}
      </div>
      <UpdateAvailableCard />
    </div>
  )
}

/** Notices just dropped from the store, kept drawn until their slide out ends. */
function useLeaving(notices: readonly Notice[]): { cards: Notice[]; gone: (id: number) => void } {
  const [cards, setCards] = useState<Notice[]>([])
  const last = useRef(notices)
  const ceilings = useRef(new Set<ReturnType<typeof setTimeout>>())
  useEffect(() => {
    const pending = ceilings.current
    return () => pending.forEach(clearTimeout)
  }, [])
  useEffect(() => {
    const dropped = last.current.filter((notice) => !notices.some((kept) => kept.id === notice.id))
    last.current = notices
    if (dropped.length === 0) return
    setCards((current) => [...current, ...dropped])
    const ceiling = setTimeout(() => {
      ceilings.current.delete(ceiling)
      setCards((current) => current.filter((card) => !dropped.includes(card)))
    }, LEAVE_CEILING_MS)
    ceilings.current.add(ceiling)
  }, [notices])
  return { cards, gone: (id) => setCards((current) => current.filter((card) => card.id !== id)) }
}

function NoticeCard({ notice, onLeft }: { notice: Notice; onLeft?: () => void }): React.JSX.Element {
  const dismissNotice = useWorkspaceStore((state) => state.dismissNotice)
  const hideRegion = useWorkspaceStore((state) => state.hideRegion)
  const undo = useWorkspaceStore((state) => state.undo)
  const look = noticeLook(notice)
  const { title, detail } = noticeParts(notice.text)
  const leaving = onLeft !== undefined
  // The first action of an error is the way out, so it is the one with a face.
  const actionVariant = look === 'error' ? 'secondary' : 'ghost'

  const act = (): void => {
    const action = notice.action
    if (action === undefined) return
    if ('url' in action) {
      openInBrowser(action.url)
      return
    }
    if ('copy' in action) {
      copyText(action.copy)
      return
    }
    dismissNotice(notice.id)
    if ('undo' in action) void undo(action.undo)
    else hideRegion(action.hide)
  }

  return (
    <div
      className={`notice notice--${look}${leaving ? ' notice--leaving' : ''}`}
      aria-hidden={leaving ? 'true' : undefined}
      inert={leaving}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) onLeft?.()
      }}
    >
      <span className="notice__icon" aria-hidden="true">
        <Icon name={NOTICE_ICON[look]} />
      </span>
      <div className="notice__body">
        <p className="notice__title">{title}</p>
        {detail === null ? null : <p className="notice__detail">{detail}</p>}
        {notice.action === undefined && notice.lock === undefined ? null : (
          <div className="notice__actions">
            {notice.action === undefined ? null : (
              // The verb is the whole button.
              <Button variant={actionVariant} size="sm" onClick={act}>
                {notice.action.label}
              </Button>
            )}
            {notice.lock === undefined ? null : <LockActions lock={notice.lock} />}
          </div>
        )}
      </div>
      <IconButton
        icon="close"
        label="Dismiss message"
        className="notice__close"
        onClick={() => dismissNotice(notice.id)}
      />
    </div>
  )
}

/** A held lock's notice: Retry, and Clear Lock once the runtime found it stale with no git running. */
function LockActions({ lock }: { lock: NonNullable<Notice['lock']> }): React.JSX.Element {
  const retryLocked = useWorkspaceStore((state) => state.retryLocked)
  const askClearLock = useWorkspaceStore((state) => state.askClearLock)
  return (
    <>
      <Button size="sm" onClick={() => void retryLocked(lock.worktreeId)}>
        Retry
      </Button>
      {lock.clearable ? (
        <Button
          variant="ghost"
          size="sm"
          title={lock.lockPath}
          onClick={() => askClearLock(lock.worktreeId, lock.lockPath)}
        >
          Clear Lock…
        </Button>
      ) : null}
    </>
  )
}
