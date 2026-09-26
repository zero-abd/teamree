// One worktree in the sidebar, in four shapes: ready, still being created,
// failed, and ready on paper but gone from disk. Everything a row can do besides
// being opened is in one menu: right-click, the `⋯`, or the context-menu key.

import { useEffect, useId, useRef, useState } from 'react'
import {
  hasCheckout,
  type Terminal,
  type Worktree,
  type WorktreeLanding,
  type WorktreeMergePreview,
  type WorktreeStatus
} from '@shared/entities'
import { AgentGlyph } from '../agents/glyphs'
import type { PaneAttention } from '../state/paneAttention'
import { agentRows, dotClass, TONE_LABEL, worktreeTone, type DotTone } from './agentRows'
import { PaneRows } from './PaneRows'
import { GitStatusChips } from './GitStatusChips'
import { mergeBadge } from './mergeBadge'
import { endNestDrag, NEST_DRAG_TYPE, startNestDrag, useNestDrag, useNestDrop } from './nestDrag'
import { RowMenu, type RowMenuAnchor, type RowMenuItem } from './RowMenu'
import { WorktreeNameField } from './WorktreeNameField'
import { agentName, worktreeDisplay, worktreeLabel, type WorktreeDisplay } from './worktreeDisplay'

/** A task with child tasks: they sit under it in its box and fold with its panes. */
export type TaskFold = {
  collapsed: boolean
  onCollapse: (collapsed: boolean) => void
  /** The most urgent dot in its tree, drawn while folded, and the child task it comes from. */
  rolled: { tone: DotTone; from?: string } | null
  tally: { done: number; total: number }
  /** A line per child, its name and stage, for the tally's hover. */
  children: readonly string[]
}

type WorktreeRowProps = {
  worktree: Worktree
  /** How the name is drawn; see `worktreeDisplay`. */
  display?: WorktreeDisplay
  status: WorktreeStatus | undefined
  mergePreview: WorktreeMergePreview | undefined
  /** Where its branch can land, and whether it has. */
  landing?: WorktreeLanding
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
  onFocusTerminal: (terminalId: string) => void | Promise<void>
  active: boolean
  onOpen: () => void
  onRetry: () => void
  /** Delete Worktree…: deletes the checkout, a copy kept for Undo. */
  onRemove: () => void
  /** Remove from teamree: forgets the row; the checkout stays. */
  onForget: () => void
  onReveal: () => void
  onCopyPath: () => void
  onCopyBranch: () => void
  onRename: (name: string) => void
  /** Set when the name field is asked for from elsewhere; `onRenameShown` takes the request back. */
  renameAsked?: boolean
  onRenameShown?: () => void
  /** The Open in submenu, the project's editor first. */
  openIn: readonly { label: string; onChoose: () => void }[]
  /** The Compare with submenu: the task's other runs. None leaves the item out. */
  compareWith?: readonly { label: string; onChoose: () => void }[]
  /** Keeps this run and removes the task's others; absent without any. */
  onKeep?: () => void
  /** Another run of the task runs the same agent, so the glyph alone would not tell the rows apart. */
  twinRun?: boolean
  /** Levels under its top-level task. */
  depth?: number
  task?: TaskFold
  /** New Child Task…; absent leaves the item out. */
  onNewChild?: () => void
  /** Move Under…; with it the row can be dragged onto another to nest there. */
  onMoveUnder?: () => void
  /** Move to Top Level; given only to a child. */
  onMoveToTop?: () => void
}

export function WorktreeRow({
  worktree,
  display = worktreeDisplay(worktree),
  status,
  mergePreview,
  landing,
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
  onForget,
  onReveal,
  onCopyPath,
  onCopyBranch,
  onRename,
  renameAsked = false,
  onRenameShown,
  openIn,
  compareWith = [],
  onKeep,
  twinRun = false,
  depth = 0,
  task,
  onNewChild,
  onMoveUnder,
  onMoveToTop
}: WorktreeRowProps): React.JSX.Element {
  const creating = worktree.state === 'creating'
  const failed = worktree.state === 'failed'
  // The record says ready and the disk says otherwise: not ready for anything
  // that touches the checkout, and its own shape for what the row says.
  const missing = worktree.missing === true
  const ready = hasCheckout(worktree)
  // Still focusable when it cannot open, so the tree's arrows reach its menu.
  const openable = !creating && !failed && !missing
  // Landed: whether it would merge again says nothing.
  const merged = ready && landing?.merged === true
  const badge = ready && !merged ? mergeBadge(mergePreview) : null
  const pullRequest = landing?.pullRequest?.state === 'open' ? landing.pullRequest : undefined
  const [menuAt, setMenuAt] = useState<RowMenuAnchor | null>(null)
  const openControl = useRef<HTMLButtonElement | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const [renaming, setRenaming] = useState(false)
  useEffect(() => {
    if (!renameAsked) return
    setRenaming(true)
    onRenameShown?.()
  }, [renameAsked, onRenameShown])
  const [panesShown, setPanesShown] = useState(true)
  const wasRenaming = useRef(false)
  const describedBy = useId()
  const drop = useNestDrop({ parentId: worktree.id }, true)
  const dragged = useNestDrag((state) => state.dragging === worktree.id)
  const draggable = ready && !renaming && onMoveUnder !== undefined

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

  // Last, behind a rule; both ask before anything goes. First once the work has landed: done is what is left.
  const remove: RowMenuItem[] = [
    { label: 'Remove from teamree', onChoose: onForget, separated: !merged },
    { label: 'Delete Worktree…', onChoose: onRemove, danger: true }
  ]
  if (merged) remove.reverse()
  const rest: RowMenuItem[] = [
    ...(failed && worktree.retryable ? [{ label: 'Retry', onChoose: onRetry }] : []),
    ...(onNewChild !== undefined && ready ? [{ label: 'New Child Task…', onChoose: onNewChild }] : []),
    ...(onMoveUnder !== undefined && ready ? [{ label: 'Move Under…', onChoose: onMoveUnder }] : []),
    ...(onMoveToTop !== undefined && ready ? [{ label: 'Move to Top Level', onChoose: onMoveToTop }] : []),
    { label: 'Rename…', onChoose: () => setRenaming(true), separated: merged },
    { label: 'Reveal in Finder', onChoose: onReveal },
    { label: 'Copy Path', onChoose: onCopyPath },
    { label: 'Copy Branch', onChoose: onCopyBranch },
    { label: 'Open in', onChoose: () => {}, items: openIn },
    ...(compareWith.length === 0 ? [] : [{ label: 'Compare with', onChoose: () => {}, items: compareWith }]),
    ...(onKeep === undefined ? [] : [{ label: 'Keep This Run…', onChoose: onKeep }])
  ]
  // A directory that is not there has nothing to reveal, open or copy; removal is what is left.
  const items: RowMenuItem[] = missing ? remove : merged ? [...remove, ...rest] : [...rest, ...remove]
  const rows = ready ? agentRows(terminals, worktree, now, evidence) : []
  const expandable = rows.length > 0 || task !== undefined
  const shown = task === undefined ? panesShown : !task.collapsed
  const show = (next: boolean): void => (task === undefined ? setPanesShown(next) : task.onCollapse(!next))
  // Folded, a task's dot speaks for its whole tree.
  const rolled = task?.collapsed === true ? task.rolled : null
  const tone = rolled?.tone ?? worktreeTone(rows)
  const label = worktreeLabel(display)
  // The glyph names the agent; words only where it cannot tell two runs apart.
  const agentWord = display.agent?.kind === undefined || twinRun
  // A task's tally needs the second line too, or its chips squeeze the name.
  const twoLines = display.branch !== undefined || task !== undefined
  // Rolled up: the collapsed row says something wants reading, the pane rows say which.
  const unreadHere = rows.some((row) => unread.has(row.terminalId))
  const stateId = `${describedBy}-state`
  const factsId = `${describedBy}-facts`

  const facts = (
    <>
      {/* One group, so the open row can hide what its status bar and Changes badge already say. */}
      <span className="worktree__git">
        {ready ? <GitStatusChips status={status} /> : null}
        {merged ? <span className="chip worktree__merged">Merged</span> : null}
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
        ) : badge?.tone === 'conflicts' ? (
          <span
            className="worktree__merge worktree__merge--conflicts"
            role="img"
            aria-label={badge.detail}
            title={badge.detail}
          >
            {/* The clean mark with its join broken by a cross. */}
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <circle cx="3.5" cy="2.5" r="1.3" />
              <circle cx="3.5" cy="9.5" r="1.3" />
              <circle cx="8.5" cy="2.5" r="1.3" />
              <path d="M3.5 3.8v4.4M8.5 3.8v1.4M7 7.5l3 3M10 7.5l-3 3" />
            </svg>
          </span>
        ) : badge ? (
          <span className={`chip worktree__merge worktree__merge--${badge.tone}`} title={badge.detail}>
            {badge.label}
          </span>
        ) : null}
      </span>
      {task === undefined ? null : (
        <span className="chip worktree__tally" title={task.children.join('\n')}>
          {`${task.tally.done}/${task.tally.total} done`}
        </span>
      )}
      {creating ? <span className="chip worktree__tag">creating</span> : null}
      {failed ? <span className="chip worktree__tag worktree__tag--failed">failed</span> : null}
      {missing ? (
        <span className="chip worktree__tag" title={`${worktree.path} is not on disk`}>
          missing
        </span>
      ) : null}
    </>
  )

  const body = (
    <>
      {/* The task name gets a line of its own but for the activity dot. The
        small facts about the branch share the line below with the branch, so
        four badges cannot squeeze the name; with no branch to show they sit
        beside the dot instead of alone on a line. */}
      <span className="worktree__title">
        {renaming ? (
          <WorktreeNameField name={worktree.name} onRename={onRename} onDone={() => setRenaming(false)} />
        ) : (
          <>
            {/* The one part that differs between runs of a task, so it is the part never cut. */}
            {display.agent ? (
              <span className="worktree__agent">
                {display.agent.kind === undefined ? null : <AgentGlyph kind={display.agent.kind} decorative />}
                {agentWord ? agentName(display.agent) : null}
              </span>
            ) : null}
            <span
              className={`worktree__name${unreadHere ? ' worktree__name--unread' : ''}`}
              title={pullRequest === undefined ? label : `${label} · Pull Request #${pullRequest.number}`}
              onDoubleClick={() => setRenaming(true)}
            >
              {display.title}
            </span>
          </>
        )}
        {/* Slides over the title's tail when the ⋯ shows, so the title never reflows under the pointer. */}
        <span className="worktree__end">
          {twoLines ? null : (
            <span className="worktree__facts" id={factsId}>
              {facts}
            </span>
          )}
          {tone ? (
            <span
              id={stateId}
              className={dotClass(tone)}
              role="img"
              title={
                rolled?.from === undefined
                  ? `${rows.length} pane${rows.length === 1 ? '' : 's'} here · ${TONE_LABEL[tone]}${
                      unreadHere ? ' · unread' : ''
                    }`
                  : `${TONE_LABEL[tone]} · ${rolled.from}`
              }
              aria-label={TONE_LABEL[tone]}
            />
          ) : null}
        </span>
      </span>
      {twoLines ? (
        <span className="worktree__meta" id={factsId}>
          <span className="worktree__branch">{display.branch ?? ''}</span>
          {facts}
        </span>
      ) : null}
    </>
  )

  return (
    <li
      className={`worktree${active ? ' worktree--active' : ''} worktree--${missing ? 'missing' : worktree.state}${
        dragged ? ' worktree--dragging' : ''
      }${drop.target === null ? '' : drop.target.allowed ? ' worktree--drop' : ' worktree--no-drop'}`}
      style={depth === 0 ? undefined : ({ '--depth': depth } as React.CSSProperties)}
      role="none"
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
      <div
        className="worktree__row"
        draggable={draggable}
        {...drop.handlers}
        {...(draggable
          ? {
              onDragStart: (event: React.DragEvent) => {
                event.dataTransfer.setData(NEST_DRAG_TYPE, worktree.id)
                event.dataTransfer.effectAllowed = 'move'
                startNestDrag(worktree.id)
              },
              onDragEnd: endNestDrag
            }
          : {})}
      >
        {task === undefined ? null : (
          <button
            type="button"
            className="worktree__fold"
            tabIndex={-1}
            aria-label={`${task.collapsed ? 'Expand' : 'Collapse'} ${label}`}
            aria-expanded={!task.collapsed}
            onClick={() => task.onCollapse(!task.collapsed)}
          >
            <svg className={`chevron${task.collapsed ? '' : ' chevron--open'}`} viewBox="0 0 12 12" aria-hidden="true">
              <path d="M4.5 2.5 L8.5 6 L4.5 9.5" />
            </svg>
          </button>
        )}
        {/* A field cannot sit inside a button, so while renaming the row is a plain box. */}
        {renaming ? (
          <div className="worktree__open worktree__open--renaming">{body}</div>
        ) : (
          <button
            type="button"
            className="worktree__open"
            ref={openControl}
            role="treeitem"
            aria-level={2 + depth}
            aria-expanded={expandable ? shown : undefined}
            tabIndex={-1}
            onClick={openable ? onOpen : undefined}
            // As in Finder: Return renames, ⌘↓ opens. Space still opens, being the button's own key.
            onKeyDown={(event) => {
              const bare = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
              if (bare && expandable && event.key === (shown ? 'ArrowLeft' : 'ArrowRight')) {
                event.preventDefault()
                show(!shown)
              }
              if (!openable) return
              if (event.key === 'Enter' && bare) {
                event.preventDefault()
                setRenaming(true)
              } else if (event.key === 'ArrowDown' && event.metaKey && !event.ctrlKey && !event.altKey) {
                event.preventDefault()
                onOpen()
              }
            }}
            aria-disabled={openable ? undefined : true}
            aria-current={active ? 'true' : undefined}
            aria-label={label}
            aria-describedby={tone ? `${stateId} ${factsId}` : factsId}
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
          tabIndex={-1}
          title={`More for ${label}`}
          aria-label={`More for ${label}`}
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

      {drop.target === null ? null : (
        <DropHint text={drop.target.allowed ? drop.target.hint : drop.target.reason} refused={!drop.target.allowed} />
      )}

      {menuAt === null ? null : (
        <RowMenu label={`Actions for ${label}`} items={items} anchor={menuAt} onClose={closeMenu} />
      )}

      {rows.length > 0 && shown ? (
        <PaneRows
          tree
          level={3 + depth}
          rows={rows}
          worktreeName={display.title}
          watchers={watchers}
          unread={unread}
          now={now}
          onFocusTerminal={onFocusTerminal}
        />
      ) : null}

      {creating ? (
        <div className="worktree__progress" role="progressbar" aria-label={`Creating ${label}`}>
          <span className="worktree__progress-bar" />
        </div>
      ) : null}

      {failed ? (
        <div className="worktree__failure">
          <p className="worktree__error" title={worktree.error}>
            {failureLine(worktree.error)}
          </p>
          {worktree.retryable ? (
            <button type="button" className="button button--ghost button--tiny" tabIndex={-1} onClick={onRetry}>
              Retry
            </button>
          ) : null}
          <button type="button" className="button button--ghost button--tiny" tabIndex={-1} onClick={onRemove}>
            Remove
          </button>
        </div>
      ) : null}
    </li>
  )
}

/** What a drop target says while a row is over it: why not, or what the move will also do. */
export function DropHint({ text, refused }: { text: string | null; refused: boolean }): React.JSX.Element | null {
  if (text === null) return null
  return <span className={`drop-hint${refused ? ' drop-hint--refused' : ''}`}>{text}</span>
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
