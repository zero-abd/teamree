// What this worktree has changed: the list, the commit box and the commits, as a tab of the right
// panel; a row opens its diff in the centre. It rides the same invalidation as everything else.

import { useEffect, useRef, useState } from 'react'
import { RowMenu, type RowMenuAnchor } from '../../sidebar/RowMenu'
import { openInBrowser } from '../../shell/openInBrowser'
import { commitScope, useWorkspaceStore, type PushState } from '../../state/workspaceStore'
import { KIND_LABEL, KIND_LETTER } from './changeKinds'
import type { PaneNode, WorktreeChange, WorktreeLog, WorktreeStatus } from '@shared/entities'
import { fileColumnIn, isCommitLeaf, shownTabId } from '@shared/filePane'

export function ChangesTab(): React.JSX.Element | null {
  const worktreeId = useWorkspaceStore((state) => state.activeWorktreeId)
  const changes = useWorkspaceStore((state) => (worktreeId ? state.changes[worktreeId] : undefined))
  const selectedPath = useWorkspaceStore((state) => state.selectedChangePath)
  const hunkPending = useWorkspaceStore((state) => state.hunkPending)
  const selectChange = useWorkspaceStore((state) => state.selectChange)
  const zoomed = useWorkspaceStore((state) => state.expandedTerminalId !== null)
  const toggleExpandedPane = useWorkspaceStore((state) => state.toggleExpandedPane)
  const stagedPaths = useWorkspaceStore((state) => state.stagedPaths)
  const toggleStaged = useWorkspaceStore((state) => state.toggleStaged)
  const unstagePath = useWorkspaceStore((state) => state.unstagePath)
  const setAllStaged = useWorkspaceStore((state) => state.setAllStaged)
  const commitStaged = useWorkspaceStore((state) => state.commitStaged)
  const committing = useWorkspaceStore((state) => state.committing)
  const log = useWorkspaceStore((state) => (worktreeId ? state.logs[worktreeId] : undefined))
  const status = useWorkspaceStore((state) => (worktreeId ? state.statuses[worktreeId] : undefined))
  const push = useWorkspaceStore((state) => (worktreeId ? state.pushes[worktreeId] : undefined))
  const pushing = useWorkspaceStore((state) => state.pushing)
  const pushActiveWorktree = useWorkspaceStore((state) => state.pushActiveWorktree)
  const openDialog = useWorkspaceStore((state) => state.openDialog)
  const openCommit = useWorkspaceStore((state) => state.openCommit)
  const shownCommit = useWorkspaceStore((state) =>
    worktreeId ? shownCommitIn(state.layouts[worktreeId]?.root ?? null) : null
  )
  const [menu, setMenu] = useState<{ path: string; at: RowMenuAnchor } | null>(null)
  // Per worktree: the panel is not remounted on tab change, and a message could land on the wrong diff.
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const message = draftFor(drafts, worktreeId)

  if (!worktreeId) return null

  const setMessage = (next: string): void => setDrafts((current) => withDraft(current, worktreeId, next))

  const rows = changes?.changes ?? []
  const ticked = new Set(stagedPaths)
  const tick = (change: WorktreeChange): Tick => tickOf(change, ticked.has(change.path))
  const checked = (change: WorktreeChange): boolean => tick(change) === 'on' || tick(change) === 'index'
  const checkedCount = rows.filter(checked).length
  const allChecked = rows.length > 0 && checkedCount === rows.length
  const tickable = rows.filter((change) => tick(change) !== 'index')
  const allTicked = tickable.every((change) => ticked.has(change.path))
  const scope = commitScope(stagedPaths, rows)
  const canCommit = rows.length > 0 && message.trim().length > 0 && !committing

  const offer = pushOffer(status, push)
  // One primary at a time: commit what is uncommitted first, then send it.
  const pushIsNext = rows.length === 0 && (status?.ahead ?? 0) > 0
  const discard = (path: string): void => openDialog({ kind: 'confirm-discard', worktreeId, path })

  const commit = (): void => {
    if (!canCommit) return
    // The message is the one thing the app cannot reconstruct; only a commit that landed clears it.
    void commitStaged(message).then((landed) => {
      if (landed) setMessage('')
    })
  }

  return (
    <section className="changes" aria-label="Changes in this worktree">
      {status && !status.missing ? (
        <div className="changes__head">
          <span className="changes__ref" title={`↑ ${status.upstream ?? log?.baseRef ?? ''}  ↓ ${log?.baseRef ?? ''}`}>
            <span className="changes__branch">{status.branch}</span>
            {aheadBehind(status)}
          </span>
          {offer?.kind === 'review' ? (
            <button type="button" className="button button--small" onClick={() => openInBrowser(offer.url)}>
              Open review
            </button>
          ) : offer ? (
            <button
              type="button"
              className={`button button--small${pushIsNext ? ' button--primary' : ''}`}
              disabled={pushing}
              onClick={() => void pushActiveWorktree()}
            >
              {PUSH_LABEL[offer.kind][push?.phase === 'pushing' ? 1 : 0]}
            </button>
          ) : null}
        </div>
      ) : null}
      {push?.phase === 'failed' ? (
        <PushFailed error={push.error} detail={push.detail} retry={() => void pushActiveWorktree()} busy={pushing} />
      ) : null}
      {changes === undefined ? (
        <p className="changes__empty">Reading…</p>
      ) : rows.length === 0 ? (
        <p className="changes__empty">{emptyChangesLabel(log)}</p>
      ) : (
        <ul className="changes__list">
          {rows.map((change, index) => (
            <li
              className={`changes__item${change.path === selectedPath ? ' changes__item--selected' : ''}`}
              key={change.path}
            >
              <input
                type="checkbox"
                className="change__tick"
                checked={checked(change)}
                ref={(box) => {
                  if (box) box.indeterminate = tick(change) === 'mixed'
                }}
                aria-label={`Include ${change.path} in the next commit`}
                onChange={() => {
                  // Unticking anything git holds takes the whole path out of the index.
                  if (checked(change) && change.staged) void unstagePath(worktreeId, change.path)
                  else toggleStaged(change.path)
                }}
              />
              <button
                type="button"
                className="change"
                aria-current={change.path === selectedPath ? 'true' : undefined}
                title={change.from === undefined ? change.path : `${change.from} → ${change.path}`}
                onClick={() => selectChange(change.path)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && zoomed) {
                    event.preventDefault()
                    toggleExpandedPane()
                    return
                  }
                  const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
                  const next = rows[index + step]
                  if (step === 0 || next === undefined) return
                  event.preventDefault()
                  selectChange(next.path)
                  const item = event.currentTarget.closest('li')
                  const sibling = step === 1 ? item?.nextElementSibling : item?.previousElementSibling
                  sibling?.querySelector<HTMLElement>('.change')?.focus()
                }}
                onContextMenu={(event) => {
                  if (!canDiscard(change)) return
                  event.preventDefault()
                  setMenu({ path: change.path, at: { x: event.clientX, y: event.clientY } })
                }}
              >
                <span className={`change__kind change__kind--${change.kind}`} aria-label={KIND_LABEL[change.kind]}>
                  {KIND_LETTER[change.kind]}
                </span>
                <span className="change__path">
                  <span className="change__dir">{directoryOf(change.path)}</span>
                  <span className="change__name">{fileNameOf(change.path)}</span>
                </span>
                {change.staged ? (
                  <span className="change__where" title={change.unstaged ? 'Staged, and edited since' : 'Staged'}>
                    {change.unstaged ? 'both' : 'staged'}
                  </span>
                ) : null}
                {change.added === undefined || change.removed === undefined ? null : (
                  <span className="change__stat">
                    +{change.added} −{change.removed}
                  </span>
                )}
              </button>
              {canDiscard(change) ? (
                <button
                  type="button"
                  className="change__discard"
                  aria-label={`Discard ${change.path}…`}
                  disabled={hunkPending}
                  onClick={() => discard(change.path)}
                >
                  Discard…
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {menu === null ? null : (
        <RowMenu
          label={`Actions for ${menu.path}`}
          anchor={menu.at}
          onClose={() => setMenu(null)}
          items={[{ label: 'Discard…', onChoose: () => discard(menu.path) }]}
        />
      )}

      {rows.length > 0 ? (
        <div className="changes__commit">
          <div className="changes__all">
            <label>
              <input
                type="checkbox"
                checked={allChecked}
                ref={(box) => {
                  if (box) box.indeterminate = !allChecked && rows.some((change) => tick(change) !== 'off')
                }}
                disabled={tickable.length === 0}
                onChange={() => setAllStaged(!allTicked)}
              />
              All
            </label>
            <span className="changes__allCount">
              {checkedCount}/{rows.length}
            </span>
          </div>
          <input
            className="changes__message"
            type="text"
            value={message}
            placeholder="Commit message"
            aria-label="Commit message"
            disabled={committing}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              commit()
            }}
          />
          <button type="button" className="button button--primary button--small" disabled={!canCommit} onClick={commit}>
            {committing ? 'Committing…' : COMMIT_LABEL[scope]}
          </button>
        </div>
      ) : null}

      {changes?.truncated ? (
        <p className="changes__note">
          {changes.limit} of {changes.total}
        </p>
      ) : null}

      {log?.unavailable !== undefined ? (
        <p className="commits__unknown" title={log.unavailable}>
          Could not read this branch’s commits
        </p>
      ) : null}

      {log && log.commits.length > 0 ? (
        <section className="commits" aria-label="Commits this worktree has made">
          <h3 className="commits__title" title={`Not in ${log.baseRef}`}>
            Commits
            <span className="panel__count">
              {log.commits.length}
              {log.truncated ? '+' : ''}
            </span>
          </h3>
          <ul className="commits__list">
            {log.commits.map((commit) => (
              <li className={`commit${commit.sha === shownCommit ? ' commit--selected' : ''}`} key={commit.sha}>
                <button
                  type="button"
                  className="commit__open"
                  aria-current={commit.sha === shownCommit ? 'true' : undefined}
                  title={`${commit.author} · ${commit.committedAt}`}
                  onClick={() => openCommit(worktreeId, commit)}
                >
                  <span className="commit__sha">{commit.shortSha}</span>{' '}
                  <span className="commit__subject">{commit.subject}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  )
}

/** A failed push as one line under the header: git's words behind Details, and Retry. */
function PushFailed({
  error,
  detail,
  retry,
  busy
}: {
  error: string
  detail: string
  retry: () => void
  busy: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const line = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent): void => {
      if (line.current?.contains(event.target as Node) !== true) setOpen(false)
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [open])
  return (
    <div className="changes__pushFailed" ref={line}>
      <span className="changes__pushFailedText" role="alert">
        {pushFailedText(error)}
      </span>
      <button type="button" className="button button--small" aria-expanded={open} onClick={() => setOpen(!open)}>
        Details
      </button>
      <button type="button" className="button button--small" disabled={busy} onClick={retry}>
        Retry
      </button>
      {open ? (
        <pre
          className="changes__pushDetail"
          role="dialog"
          aria-label="git output"
          tabIndex={-1}
          ref={(pre) => pre?.focus()}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            event.stopPropagation()
            setOpen(false)
          }}
        >
          {detail}
        </pre>
      ) : null}
    </div>
  )
}

/** `Push failed: origin not found`, or just `Push failed` when git gave no clause. */
export function pushFailedText(error: string): string {
  return error === 'Push failed' ? error : `Push failed: ${error}`
}

/** ` · ↑2 ↓1` with a zero side left out, and nothing when both are zero. */
function aheadBehind(status: WorktreeStatus): string {
  const arrows = [status.ahead > 0 ? `↑${status.ahead}` : '', status.behind > 0 ? `↓${status.behind}` : '']
  const shown = arrows.filter((arrow) => arrow !== '').join(' ')
  return shown === '' ? '' : ` · ${shown}`
}

/** The commit the file column is showing, if its shown tab is one. */
export function shownCommitIn(root: PaneNode | null): string | null {
  const column = fileColumnIn(root)
  if (column === null) return null
  const shown = column.children.find((child) => child.kind === 'leaf' && child.terminalId === shownTabId(column))
  return isCommitLeaf(shown) ? shown.commit : null
}

const COMMIT_LABEL = { ticked: 'Commit', staged: 'Commit Staged', all: 'Commit All' } as const

/** `index`: git already holds the whole change; unticking it unstages the path. */
type Tick = 'on' | 'off' | 'mixed' | 'index'

function tickOf(change: WorktreeChange, ticked: boolean): Tick {
  if (change.staged && !change.unstaged) return 'index'
  if (ticked) return 'on'
  return change.staged ? 'mixed' : 'off'
}

const PUSH_LABEL = { push: ['Push', 'Pushing…'], publish: ['Publish branch', 'Publishing…'] } as const

export type PushOffer = { kind: 'push' | 'publish' } | { kind: 'review'; url: string }

/** The header's one button: send commits the remote lacks, else open the review the last push made. */
export function pushOffer(status: WorktreeStatus | undefined, push: PushState | undefined): PushOffer | null {
  if (!status || status.missing) return null
  // Without a commit, a published branch would be its base under another name.
  if (status.upstream === null) return status.ahead > 0 || push?.phase === 'pushing' ? { kind: 'publish' } : null
  if (status.ahead > 0 || push?.phase === 'pushing') return { kind: 'push' }
  if (push?.phase === 'pushed' && push.reviewUrl !== undefined) return { kind: 'review', url: push.reviewUrl }
  return null
}

/** An unstaged change git can put back, or an untracked file the Trash can take. Intent-to-add is refused. */
export function canDiscard(change: WorktreeChange): boolean {
  if (!change.unstaged || change.kind === 'conflicted') return false
  return !(change.kind === 'added' && !change.staged)
}

/** The commit message for one worktree, kept when looking at another. */
export function draftFor(drafts: Record<string, string>, worktreeId: string | null): string {
  return worktreeId === null ? '' : (drafts[worktreeId] ?? '')
}

/** The same map with one worktree's message replaced; emptying it drops it. */
export function withDraft(drafts: Record<string, string>, worktreeId: string, message: string): Record<string, string> {
  const next = { ...drafts }
  if (message === '') delete next[worktreeId]
  else next[worktreeId] = message
  return next
}

/** What an empty changes list means; "No changes" is wrong when the base could not be compared. */
export function emptyChangesLabel(log: WorktreeLog | undefined): string {
  if (log?.unavailable !== undefined) return 'Nothing uncommitted'
  if ((log?.commits.length ?? 0) > 0) return 'All committed'
  return 'No changes'
}

/** The path up to the file name, kept dim so the name itself reads first. */
export function directoryOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut + 1)
}

export function fileNameOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? path : path.slice(cut + 1)
}
