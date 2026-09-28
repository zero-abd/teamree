// The corner stack above the status bar: teammates' popups, agents asking out of sight, this window's notices,
// then the update card.
// A dismissed notice slides out in place before it goes, so the stack closes the gap rather than jumping.

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { copyText } from '../clipboard/clipboard'
import { Icon } from '../icons/Icon'
import { Button, IconButton } from '../ui/Button'
import { openInBrowser } from '../shell/openInBrowser'
import { focusRegion, requestRegionFocus } from '../shell/regions'
import { usePaneEvidence } from '../sidebar/usePaneEvidence'
import { useWorkspaceStore, type Notice } from '../state/workspaceStore'
import { HandoffPopups } from '../teamwork/HandoffPopups'
import { ReviewPopups } from '../teamwork/ReviewPopups'
import { SharedNotePopups } from '../teamwork/SharedNotePopups'
import { UpdateAvailableCard } from '../updates/UpdateAvailableCard'
import { askForYou, useMessageStore } from '../state/messages'
import { focusAfterAnswer } from '../panes/askCards'
import { hiddenAsks, type HiddenAsk } from './askingNotices'
import { SendBlockToAgent } from '../workspace/rightPanel/CommitBlocked'
import { liveAction, NOTICE_ICON, noticeLook, noticeParts } from './noticeView'
import { StoreProblemCards } from './StoreProblemCards'
import { useAnnouncements } from './useAnnouncements'

/** The slide out is 180 ms; this is only for a card whose animation never ends (none running, a test). */
const LEAVE_CEILING_MS = 400

const MOST_ASKING = 3

export function NoticeStack(): React.JSX.Element {
  const spoken = useAnnouncements()
  const notices = useWorkspaceStore((state) => state.notices)
  const leaving = useLeaving(notices)
  const shown = [...notices, ...leaving.cards].sort((left, right) => left.id - right.id)
  const stack = useRef<HTMLDivElement | null>(null)
  useKeyboardStays(stack)

  return (
    // Bottom right above the status bar: notices stack above the update card, never over it.
    <div className="corner-stack" data-region="notices" ref={stack}>
      <StoreProblemCards />
      <SharedNotePopups />
      <HandoffPopups />
      <ReviewPopups />
      <AskingCards />
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

/** A card that goes, or goes inert, while it holds the keyboard hands it to the next card, else to the panes. */
function useKeyboardStays(stack: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = stack.current
    if (root === null) return
    let held: Element | null = null
    const track = (event: FocusEvent): void => {
      held = event.target instanceof Element && root.contains(event.target) ? event.target : null
    }
    const watch = new MutationObserver(() => {
      if (held === null || (held.isConnected && held.closest('[inert]') === null)) return
      const active = document.activeElement
      if (active !== null && active !== document.body && active !== held) return
      held = null
      if (!focusRegion('notices')) focusAfterAnswer(null)
    })
    watch.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['inert'] })
    document.addEventListener('focusin', track)
    return () => {
      watch.disconnect()
      document.removeEventListener('focusin', track)
    }
  }, [stack])
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
  const resumeAgents = useWorkspaceStore((state) => state.resumeAgents)
  const action = useWorkspaceStore((state) => liveAction(notice.action, state.bases))
  const look = noticeLook(notice)
  const { title, detail } = noticeParts(notice.text)
  const leaving = onLeft !== undefined
  // The first action of an error is the way out, so it is the one with a face.
  const actionVariant = look === 'error' ? 'secondary' : 'ghost'

  const act = (): void => {
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
    else if ('resume' in action) void resumeAgents(action.resume)
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
        {action === undefined && notice.lock === undefined && notice.commitBlock === undefined ? null : (
          <div className="notice__actions">
            {action === undefined ? null : (
              // The verb is the whole button.
              <Button variant={actionVariant} size="sm" onClick={act}>
                {action.label}
              </Button>
            )}
            {notice.lock === undefined ? null : <LockActions lock={notice.lock} />}
            {notice.commitBlock === undefined ? null : (
              <CommitBlockActions worktreeId={notice.commitBlock.worktreeId} onSent={() => dismissNotice(notice.id)} />
            )}
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

/** A refused commit's notice: its whole output, or the agent to fix it. */
function CommitBlockActions({ worktreeId, onSent }: { worktreeId: string; onSent: () => void }): React.JSX.Element {
  const openDialog = useWorkspaceStore((state) => state.openDialog)
  return (
    <>
      <Button size="sm" onClick={() => openDialog({ kind: 'commit-output', worktreeId })}>
        Details
      </Button>
      <SendBlockToAgent worktreeId={worktreeId} variant="ghost" onSent={onSent} />
    </>
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

/** A card per agent asking where it cannot be seen; one it was dismissed for comes back with the next question. */
function AskingCards(): React.JSX.Element | null {
  const terminals = useWorkspaceStore((store) => store.terminals)
  const worktrees = useWorkspaceStore((store) => store.worktrees)
  const layouts = useWorkspaceStore((store) => store.layouts)
  const activeWorktreeId = useWorkspaceStore((store) => store.activeWorktreeId)
  const expandedTerminalId = useWorkspaceStore((store) => store.expandedTerminalId)
  const focusedWatchId = useWorkspaceStore((store) => store.focusedWatchId)
  const covered = useWorkspaceStore((store) => store.settingsOpen || store.helpOpen || store.teamworkProjectId !== null)
  // All Panes lists every ask with its answers already.
  const board = useWorkspaceStore((store) => store.dashboardOpen)
  const state = useMemo(
    () => ({ terminals, worktrees, layouts, activeWorktreeId, expandedTerminalId, focusedWatchId, covered }),
    [terminals, worktrees, layouts, activeWorktreeId, expandedTerminalId, focusedWatchId, covered]
  )
  const asks = useMemo(() => hiddenAsks(state), [state])
  const askingPanes = useMemo(() => asks.map((ask) => ask.terminal), [asks])
  const evidence = usePaneEvidence(askingPanes, state.terminals)
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  // Three at most: the status bar counts the rest, and the corner stays a corner.
  const shown = hiddenAsks(state, evidence)
    .filter((ask) => !dismissed.has(ask.key))
    .slice(0, MOST_ASKING)
  if (shown.length === 0 || board) return null
  return (
    <div className="notices notices--asking">
      {shown.map((ask) => (
        <AskingCard
          key={ask.terminal.id}
          ask={ask}
          onDismiss={() => setDismissed((current) => new Set(current).add(ask.key))}
        />
      ))}
    </div>
  )
}

function AskingCard({ ask, onDismiss }: { ask: HiddenAsk; onDismiss: () => void }): React.JSX.Element {
  const answerPane = useWorkspaceStore((state) => state.answerPane)
  const revealPane = useWorkspaceStore((state) => state.revealPane)
  const { terminal } = ask
  // A question put to you with `msg ask` is the message's own words and options, not the screen's.
  const put = useMessageStore((state) =>
    terminal.askingYou === undefined ? undefined : askForYou(state.messages, terminal.worktreeId)
  )
  const answer = useMessageStore((state) => state.answer)
  const allow = put === undefined ? terminal.screenMenu?.choices[0] : undefined
  const options = put?.options ?? []
  const question = put?.text ?? ask.question
  return (
    <div className="notice notice--asking" role="group" aria-label={`${ask.worktreeName} needs you`}>
      <span className="notice__icon" aria-hidden="true">
        <Icon name="alert" />
      </span>
      <div className="notice__body">
        <p className="notice__title">{`${ask.worktreeName} needs you`}</p>
        {question === null ? null : (
          <p className="notice__detail notice__detail--ask" title={question}>
            {question}
          </p>
        )}
        <div className="notice__actions">
          {put === undefined
            ? null
            : options.map((option, index) => (
                <Button
                  key={option}
                  variant={index === 0 ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => void answer(put, option)}
                >
                  {option}
                </Button>
              ))}
          {allow === undefined ? null : (
            <Button variant="primary" size="sm" title={allow.label} onClick={() => void answerPane(terminal.id, allow)}>
              Allow
            </Button>
          )}
          <Button
            variant={allow === undefined && options.length === 0 ? 'primary' : 'ghost'}
            size="sm"
            onClick={() =>
              void Promise.resolve(revealPane(terminal.worktreeId, terminal.id)).then(() => requestRegionFocus('panes'))
            }
          >
            Open
          </Button>
        </div>
      </div>
      <IconButton icon="close" label="Dismiss message" className="notice__close" onClick={onDismiss} />
    </div>
  )
}
