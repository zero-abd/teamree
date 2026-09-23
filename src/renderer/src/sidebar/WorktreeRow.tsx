// One worktree in the sidebar, in four shapes: ready, still being created,
// failed, and ready on paper but gone from disk. Everything a row can do besides
// being opened is in one menu: right-click, the `⋯`, or the context-menu key.

import { useEffect, useRef, useState } from 'react'
import { slugifyBranchName } from '@shared/branchName'
import {
  hasCheckout,
  type Terminal,
  type Worktree,
  type WorktreeMergePreview,
  type WorktreeStatus
} from '@shared/entities'
import { AgentGlyph } from '../agents/glyphs'
import type { PaneAttention } from '../state/paneAttention'
import { agentRows, dotClass, TONE_LABEL, worktreeTone, type WorktreeTitle } from './agentRows'
import { PaneRows } from './PaneRows'
import { GitStatusChips } from './GitStatusChips'
import { mergeBadge } from './mergeBadge'
import { RowMenu, type RowMenuAnchor, type RowMenuItem } from './RowMenu'
import { WorktreeNameField } from './WorktreeNameField'

type WorktreeRowProps = {
  worktree: Worktree
  /** How the name is drawn; the whole name when absent. See `worktreeTitles`. */
  title?: WorktreeTitle
  status: WorktreeStatus | undefined
  mergePreview: WorktreeMergePreview | undefined
  /** Every terminal in the workspace; the row picks out its own. */
  terminals: Terminal[]
  /** Last line read from each pane, keyed by terminal id. */
  evidence: Readonly<Record<string, string | null>>
  /**
   * Who is reading and typing into each pane, keyed by terminal id. Not
   * decoration: `docs/teamwork.md` rests on nothing being done invisibly.
   */
  watchers: Readonly<Record<string, PaneAttention>>
  /** Panes that have printed since last looked at; read once by the sidebar for every row. */
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
  onRename: (name: string) => void
  /** The Open in submenu, the project's editor first. */
  openIn: readonly { label: string; onChoose: () => void }[]
}

export function WorktreeRow({
  worktree,
  title = { text: worktree.name },
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
  onRename,
  openIn
}: WorktreeRowProps): React.JSX.Element {
  const creating = worktree.state === 'creating'
  const failed = worktree.state === 'failed'
  // The record says ready and the disk says otherwise: not ready for anything
  // that touches the checkout, and its own shape for what the row says.
  const missing = worktree.missing === true
  const ready = hasCheckout(worktree)
  const badge = ready ? mergeBadge(mergePreview) : null
  const [menuAt, setMenuAt] = useState<RowMenuAnchor | null>(null)
  const openControl = useRef<HTMLButtonElement | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const [renaming, setRenaming] = useState(false)
  const wasRenaming = useRef(false)

  // A field removed while focused leaves the focus on `document.body`; after a blur it is already elsewhere.
  useEffect(() => {
    if (wasRenaming.current && !renaming && document.activeElement === document.body) openControl.current?.focus()
    wasRenaming.current = renaming
  }, [renaming])

  const openMenu = (at: RowMenuAnchor, from: HTMLElement | null): void => {
    opener.current = from
    setMenuAt(at)
  }

  const closeMenu = (): void => {
    setMenuAt(null)
    // A menu that leaves the focus on `document.body` costs a keyboard user their place.
    ;(opener.current ?? openControl.current)?.focus()
  }

  /** Under the row, for a menu nobody pointed at. */
  const rowAnchor = (): RowMenuAnchor => {
    const rect = openControl.current?.getBoundingClientRect()
    return rect === undefined ? { x: 0, y: 0 } : { x: rect.left + 12, y: rect.bottom }
  }

  // Last, behind a rule, and it still asks the question naming the ignored files it would destroy.
  const remove: RowMenuItem = { label: 'Remove', onChoose: onRemove, separated: true, danger: true }
  // A directory that is not there has nothing to reveal, open or copy; removal is what is left.
  const items: RowMenuItem[] = missing
    ? [remove]
    : [
        { label: 'Rename…', onChoose: () => setRenaming(true) },
        { label: 'Reveal in Finder', onChoose: onReveal },
        { label: 'Copy path', onChoose: onCopyPath },
        { label: 'Copy branch', onChoose: onCopyBranch },
        { label: 'Open in', onChoose: () => {}, items: openIn },
        remove
      ]
  const rows = ready ? agentRows(terminals, worktree.id, now, evidence) : []
  const tone = worktreeTone(rows)
  // `scratch / scratch`: a branch that is the name slugified says nothing the name does not.
  const branchSaysMore = worktree.branch !== slugifyBranchName(worktree.name)
  // Rolled up: the collapsed row says something wants reading, the pane rows say which.
  const unreadHere = rows.some((row) => unread.has(row.terminalId))

  const body = (
    <>
      {/* The task name gets a line of its own but for the activity dot.
        Everything else is a small fact about the branch, and sharing the
        line below with the branch is what stops four badges from
        squeezing the one thing that identifies the row. */}
      <span className="worktree__title">
        {renaming ? (
          <WorktreeNameField name={worktree.name} onRename={onRename} onDone={() => setRenaming(false)} />
        ) : (
          <>
            {/* The one part that differs between runs of a task, so it is the part never cut. */}
            {title.agent ? (
              <span className="worktree__agent">
                <AgentGlyph kind={title.agent.kind} decorative />
                {title.agent.text}
              </span>
            ) : null}
            <span
              className={`worktree__name${unreadHere ? ' worktree__name--unread' : ''}`}
              title={worktree.task ?? worktree.name}
              onDoubleClick={() => setRenaming(true)}
            >
              {title.text}
            </span>
          </>
        )}
        {tone ? (
          <span
            className={dotClass(tone, unreadHere)}
            title={`${rows.length} pane${rows.length === 1 ? '' : 's'} here · ${TONE_LABEL[tone]}${
              unreadHere ? ' · unread' : ''
            }`}
            aria-label={TONE_LABEL[tone]}
          />
        ) : null}
      </span>
      <span className="worktree__meta">
        {/* Kept when empty: it is the slack that holds the chips to the right edge. */}
        <span className="worktree__branch">{branchSaysMore ? worktree.branch : null}</span>
        {ready ? <GitStatusChips status={status} /> : null}
        {badge?.tone === 'clean' ? (
          <span
            className="worktree__merge worktree__merge--clean"
            role="img"
            aria-label={badge.detail}
            title={badge.detail}
          >
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <circle cx="3.5" cy="2.5" r="1.3" />
              <circle cx="3.5" cy="9.5" r="1.3" />
              <circle cx="8.5" cy="5" r="1.3" />
              <path d="M3.5 3.8v4.4M8.5 6.3c0 1.6-2 2.2-5 2.2" />
            </svg>
          </span>
        ) : badge ? (
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
    </>
  )

  return (
    <li
      className={`worktree${active ? ' worktree--active' : ''} worktree--${missing ? 'missing' : worktree.state}`}
      onContextMenu={(event) => {
        event.preventDefault()
        // The context-menu key and Shift+F10 raise this same event with
        // Chromium reporting a detail of 0 and no coordinates; a menu placed
        // there would open in the corner of the window.
        const pointed = event.detail > 0 && (event.clientX > 0 || event.clientY > 0)
        openMenu(
          pointed ? { x: event.clientX, y: event.clientY } : rowAnchor(),
          document.activeElement instanceof HTMLElement ? document.activeElement : null
        )
      }}
      onKeyDown={(event) => {
        // The browser's default turns these keys into the `contextmenu` above;
        // `preventDefault` stops it arriving twice.
        if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
        event.preventDefault()
        openMenu(rowAnchor(), document.activeElement instanceof HTMLElement ? document.activeElement : null)
      }}
    >
      <div className="worktree__row">
        {/* A field cannot sit inside a button, so while renaming the row is a plain box. */}
        {renaming ? (
          <div className="worktree__open worktree__open--renaming">{body}</div>
        ) : (
          <button
            type="button"
            className="worktree__open"
            ref={openControl}
            onClick={onOpen}
            // As in Finder: Return renames, ⌘↓ opens. Space still opens, being the button's own key.
            onKeyDown={(event) => {
              const bare = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
              if (event.key === 'Enter' && bare) {
                event.preventDefault()
                setRenaming(true)
              } else if (event.key === 'ArrowDown' && event.metaKey && !event.ctrlKey && !event.altKey) {
                event.preventDefault()
                onOpen()
              }
            }}
            disabled={creating || failed || missing}
            aria-current={active ? 'true' : undefined}
          >
            {body}
          </button>
        )}
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
        <PaneRows
          rows={rows}
          worktreeName={worktree.name}
          watchers={watchers}
          unread={unread}
          now={now}
          onFocusTerminal={onFocusTerminal}
        />
      ) : null}

      {creating ? (
        <div className="worktree__progress" role="progressbar" aria-label={`Creating ${worktree.name}`}>
          <span className="worktree__progress-bar" />
        </div>
      ) : null}

      {failed ? (
        <div className="worktree__failure">
          <p className="worktree__error" title={worktree.error}>
            {failureLine(worktree.error)}
          </p>
          {worktree.retryable ? (
            <button type="button" className="button button--ghost button--tiny" onClick={onRetry}>
              Retry
            </button>
          ) : null}
          <button type="button" className="button button--ghost button--tiny" onClick={onRemove}>
            Remove
          </button>
        </div>
      ) : null}
    </li>
  )
}

const FAILURE_LINE_MAX = 60

/** git's own words from a failure, on one line of at most sixty characters. */
function failureLine(error: string | undefined): string {
  if (!error) return 'Creation failed'
  // A failed git command reads `git <args> exited with code N: <stderr>`; the stderr is the reason.
  const reason = error.replace(/^git .*? (?:exited with code \S+|timed out|cancelled): /s, '')
  const line = (reason.split('\n').find((part) => part.trim()) ?? reason).trim().replace(/^(?:fatal|error): /i, '')
  const sentence = line.charAt(0).toUpperCase() + line.slice(1)
  return sentence.length <= FAILURE_LINE_MAX ? sentence : `${sentence.slice(0, FAILURE_LINE_MAX - 1).trimEnd()}…`
}
