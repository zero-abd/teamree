// One worktree in the sidebar. The row carries four different shapes — ready,
// still being created, failed, and ready on paper but gone from disk — because
// a worktree is a background job and hiding that would make the sidebar lie.
//
// Everything a row can do besides being opened is in one menu, reached by
// right-clicking the row, by the `⋯` beside it, or by the context-menu key on
// the focused row. That is a change of shape as much as an addition: the row's
// only control used to be a `×` that destroyed the checkout, so the most
// destructive thing in the app was the easiest thing on the row to hit, and the
// ordinary things — where is this on disk, what is the branch called, open it
// in my editor — could not be reached from here at all. Remove is still here,
// last, under a rule, and still asks the same question it always did.

import { useRef, useState } from 'react'
import {
  hasCheckout,
  type Terminal,
  type Worktree,
  type WorktreeMergePreview,
  type WorktreeStatus
} from '@shared/entities'
import type { PaneAttention } from '../state/paneAttention'
import { ACTIVITY_LABEL, agentRows, worktreeActivity } from './agentRows'
import { PaneRows } from './PaneRows'
import { GitStatusChips } from './GitStatusChips'
import { mergeBadge } from './mergeBadge'
import { RowMenu, type RowMenuAnchor, type RowMenuItem } from './RowMenu'

type WorktreeRowProps = {
  worktree: Worktree
  status: WorktreeStatus | undefined
  mergePreview: WorktreeMergePreview | undefined
  /** Every terminal in the workspace; the row picks out its own. */
  terminals: Terminal[]
  /** Last line read from each pane, keyed by terminal id. */
  evidence: Readonly<Record<string, string | null>>
  /**
   * Who is reading and typing into each of these panes, keyed by terminal id.
   *
   * Not decoration. The argument in `docs/teamwork.md` for why a project where
   * anyone can type is survivable is that nothing can be done invisibly, and
   * this row is where a pane nobody is looking at says it anyway.
   */
  watchers: Readonly<Record<string, PaneAttention>>
  /**
   * Panes that have printed since this person last had them in front of them.
   *
   * Passed in rather than read here, because the sidebar asks the store once
   * for every row: one reading of "what is unread" for the whole window, which
   * is the same bargain `evidence` above makes.
   */
  unread: ReadonlySet<string>
  now: number
  onFocusTerminal: (terminalId: string) => void
  active: boolean
  onOpen: () => void
  onRetry: () => void
  onRemove: () => void
  onReveal: () => void
  onCopyPath: () => void
  onCopyBranch: () => void
  onOpenInEditor: () => void
  /**
   * What the Open in item is called — the editor this project would use.
   *
   * A word rather than a name when teamree has not found one, because the item
   * is offered either way: choosing it is how somebody finds out that nothing
   * is set up, and the refusal that comes back says what to do about it. A
   * hidden item would have been a silence.
   */
  editorLabel: string
}

export function WorktreeRow({
  worktree,
  status,
  mergePreview,
  terminals,
  evidence,
  watchers,
  unread,
  now,
  active,
  onFocusTerminal,
  onOpen,
  onRetry,
  onRemove,
  onReveal,
  onCopyPath,
  onCopyBranch,
  onOpenInEditor,
  editorLabel
}: WorktreeRowProps): React.JSX.Element {
  const creating = worktree.state === 'creating'
  const failed = worktree.state === 'failed'
  // The record says ready and the disk says otherwise. Treated as not ready
  // for everything below that reads or starts something in the checkout, and
  // as its own shape for what the row says.
  const missing = worktree.missing === true
  const ready = hasCheckout(worktree)
  const badge = ready ? mergeBadge(mergePreview) : null
  const [menuAt, setMenuAt] = useState<RowMenuAnchor | null>(null)
  const openControl = useRef<HTMLButtonElement | null>(null)
  const opener = useRef<HTMLElement | null>(null)

  const openMenu = (at: RowMenuAnchor, from: HTMLElement | null): void => {
    opener.current = from
    setMenuAt(at)
  }

  const closeMenu = (): void => {
    setMenuAt(null)
    // Back where it came from, which is the whole reason the opener is kept: a
    // menu that leaves the focus on `document.body` costs a keyboard user their
    // place in the sidebar every time they open one.
    ;(opener.current ?? openControl.current)?.focus()
  }

  /** Under the row, for a menu nobody pointed at. */
  const rowAnchor = (): RowMenuAnchor => {
    const rect = openControl.current?.getBoundingClientRect()
    return rect === undefined ? { x: 0, y: 0 } : { x: rect.left + 12, y: rect.bottom }
  }

  // Last, and behind a rule, and it still opens the question it always did —
  // the one that names the ignored files the removal would destroy.
  const remove: RowMenuItem = { label: 'Remove', onChoose: onRemove, separated: true, danger: true }
  // A directory that is not there has nothing to reveal, open or copy a path
  // to. Removal is the one thing left, and it is the thing wanted.
  const items: RowMenuItem[] = missing
    ? [remove]
    : [
        { label: 'Reveal in Finder', onChoose: onReveal },
        { label: 'Copy path', onChoose: onCopyPath },
        { label: 'Copy branch', onChoose: onCopyBranch },
        { label: `Open in ${editorLabel}`, onChoose: onOpenInEditor },
        remove
      ]
  const rows = ready ? agentRows(terminals, worktree.id, now, evidence) : []
  const overall = worktreeActivity(rows)
  // Rolled up the way the dot is: the collapsed row says that something under
  // it wants reading, and the pane rows say which.
  const unreadHere = rows.some((row) => unread.has(row.terminalId))

  return (
    <li
      className={`worktree${active ? ' worktree--active' : ''} worktree--${missing ? 'missing' : worktree.state}`}
      onContextMenu={(event) => {
        event.preventDefault()
        // A right-click puts the menu where the pointer is. The context-menu key
        // and Shift+F10 raise this same event with nothing pointing anywhere —
        // Chromium reports a detail of 0 — and a menu placed at those
        // coordinates would open in the corner of the window rather than on the
        // row somebody is standing on.
        const pointed = event.detail > 0 && (event.clientX > 0 || event.clientY > 0)
        openMenu(
          pointed ? { x: event.clientX, y: event.clientY } : rowAnchor(),
          document.activeElement instanceof HTMLElement ? document.activeElement : null
        )
      }}
      onKeyDown={(event) => {
        // Said here as well as left to the browser's own default, because that
        // default is what turns these keys into the `contextmenu` above and
        // `preventDefault` is what stops it arriving twice. A second arrival
        // would only reopen the menu that is already open, which is why this is
        // written the harmless way round rather than guarded.
        if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
        event.preventDefault()
        openMenu(rowAnchor(), document.activeElement instanceof HTMLElement ? document.activeElement : null)
      }}
    >
      <div className="worktree__row">
        <button
          type="button"
          className="worktree__open"
          ref={openControl}
          onClick={onOpen}
          disabled={creating || failed || missing}
          aria-current={active ? 'true' : undefined}
        >
          {/* The task name gets a line of its own but for the activity dot.
              Everything else is a small fact about the branch, and sharing the
              line below with the branch is what stops four badges from
              squeezing the one thing that identifies the row. */}
          <span className="worktree__title">
            <span
              className={`worktree__name${unreadHere ? ' worktree__name--unread' : ''}`}
              title={worktree.task ?? worktree.name}
            >
              {worktree.name}
            </span>
            {overall ? (
              <span
                className={`activity activity--${overall}`}
                title={`${rows.length} pane${rows.length === 1 ? '' : 's'} here · ${ACTIVITY_LABEL[overall]}`}
                aria-label={ACTIVITY_LABEL[overall]}
              />
            ) : null}
            {/* Beside the dot rather than instead of it: what a pane is doing
                and whether you have read it are two facts, and a pane can be
                finished and unread, or working and already seen. */}
            {unreadHere ? <span className="pip" title="unread" /> : null}
          </span>
          <span className="worktree__meta">
            <span className="worktree__branch">{worktree.branch}</span>
            {ready ? <GitStatusChips status={status} /> : null}
            {badge ? (
              <span className={`chip worktree__merge worktree__merge--${badge.tone}`} title={badge.detail}>
                {badge.label}
              </span>
            ) : null}
            {creating ? <span className="chip worktree__tag">creating</span> : null}
            {failed ? <span className="chip worktree__tag worktree__tag--failed">failed</span> : null}
            {missing ? (
              <span className="chip worktree__tag worktree__tag--missing" title={`${worktree.path} is not on disk`}>
                missing
              </span>
            ) : null}
          </span>
        </button>
        {/* The only button on the row besides the row itself, and it opens the
            same menu the right button does. Named for what it opens rather than
            for what it looks like: "More" is what a `⋯` is called by anybody
            who cannot see it. */}
        <button
          type="button"
          className="worktree__action"
          title={`More for ${worktree.name}`}
          aria-label={`More for ${worktree.name}`}
          aria-haspopup="menu"
          aria-expanded={menuAt !== null}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            openMenu({ x: rect.right - 8, y: rect.bottom + 2 }, event.currentTarget)
          }}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <circle cx="2.5" cy="6" r="1" />
            <circle cx="6" cy="6" r="1" />
            <circle cx="9.5" cy="6" r="1" />
          </svg>
        </button>
      </div>

      {menuAt === null ? null : (
        <RowMenu label={`Actions for ${worktree.name}`} items={items} anchor={menuAt} onClose={closeMenu} />
      )}

      {rows.length > 0 ? (
        <PaneRows rows={rows} watchers={watchers} unread={unread} now={now} onFocusTerminal={onFocusTerminal} />
      ) : null}

      {creating ? (
        <div className="worktree__progress" role="progressbar" aria-label={`Creating ${worktree.name}`}>
          <span className="worktree__progress-bar" />
        </div>
      ) : null}

      {failed ? (
        <div className="worktree__failure">
          <p className="worktree__error">{worktree.error ?? 'Creation failed'}</p>
          <button type="button" className="button button--ghost button--tiny" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : null}
    </li>
  )
}
