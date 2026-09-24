// What this worktree has changed: the list, the commit box and the commits, as a tab of the right
// panel; a row opens its diff in the centre. It rides the same invalidation as everything else.

import { useEffect, useRef, useState } from 'react'
import { harnessName } from '../../agents/harnesses'
import { ReviewBar } from '../../review/ReviewBar'
import { isViewedRow } from '../../review/reviewModel'
import { useReviewStore } from '../../review/reviewStore'
import { RowMenu, type RowMenuAnchor } from '../../sidebar/RowMenu'
import { openInBrowser } from '../../shell/openInBrowser'
import { commitScope, useWorkspaceStore, type PushState } from '../../state/workspaceStore'
import { KIND_LABEL, KIND_LETTER } from './changeKinds'
import { landLabel, landOffer, type LandOffer } from './landOffer'
import type { PaneNode, Terminal, WorktreeChange, WorktreeLog, WorktreeStatus } from '@shared/entities'
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
  const landing = useWorkspaceStore((state) => (worktreeId ? state.landings[worktreeId] : undefined))
  const openingPullRequest = useWorkspaceStore((state) => state.openingPullRequest)
  const createPullRequest = useWorkspaceStore((state) => state.createPullRequest)
  const removeWorktree = useWorkspaceStore((state) => state.removeWorktree)
  const openDialog = useWorkspaceStore((state) => state.openDialog)
  const openCommit = useWorkspaceStore((state) => state.openCommit)
  const updating = useWorkspaceStore((state) => state.updating)
  const updateError = useWorkspaceStore((state) => (worktreeId ? state.updateErrors[worktreeId] : undefined))
  const updateWorktree = useWorkspaceStore((state) => state.updateWorktree)
  const abortUpdate = useWorkspaceStore((state) => state.abortUpdate)
  const typeIntoPane = useWorkspaceStore((state) => state.typeIntoPane)
  const focusPane = useWorkspaceStore((state) => state.focusPane)
  const baseRef = useWorkspaceStore((state) => {
    const projectId = state.worktrees.find((worktree) => worktree.id === worktreeId)?.projectId
    return state.projects.find((project) => project.id === projectId)?.baseRef
  })
  const terminals = useWorkspaceStore((state) => state.terminals)
  const shownCommit = useWorkspaceStore((state) =>
    worktreeId ? shownCommitIn(state.layouts[worktreeId]?.root ?? null) : null
  )
  const viewed = useReviewStore((state) => (worktreeId ? state.viewed[worktreeId] : undefined))
  const [menu, setMenu] = useState<{ path: string; at: RowMenuAnchor } | null>(null)
  // Per worktree: the panel is not remounted on tab change, and a message could land on the wrong diff.
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const message = draftFor(drafts, worktreeId)

  if (!worktreeId) return null

  const setMessage = (next: string): void => setDrafts((current) => withDraft(current, worktreeId, next))

  const listed = changes?.changes ?? []
  // Conflicts get a list of their own; they cannot be ticked into a commit.
  const conflictRows = listed.filter((change) => change.kind === 'conflicted')
  const rows = listed.filter((change) => change.kind !== 'conflicted')
  const midway = status?.operation
  const base = baseRef ?? log?.baseRef
  const agentPane = agentPaneOf(terminals, worktreeId)
  const ticked = new Set(stagedPaths)
  const tick = (change: WorktreeChange): Tick => tickOf(change, ticked.has(change.path))
  const checked = (change: WorktreeChange): boolean => tick(change) === 'on' || tick(change) === 'index'
  const checkedCount = rows.filter(checked).length
  const allChecked = rows.length > 0 && checkedCount === rows.length
  const tickable = rows.filter((change) => tick(change) !== 'index')
  const allTicked = tickable.every((change) => ticked.has(change.path))
  const scope = commitScope(stagedPaths, rows)
  const canCommit = rows.length > 0 && message.trim().length > 0 && !committing

  const land = midway === undefined ? landOffer(landing, status) : null
  // Nothing is pushed from the middle of a rebase, nor once the branch has landed.
  const pushed = midway === undefined && land?.kind !== 'merged' ? pushOffer(status, push) : null
  // A pull request button is the review page, and more.
  const offer = pushed?.kind === 'review' && land !== null ? null : pushed
  const offersUpdate = updateFrom(status, base) !== null && conflictRows.length === 0
  // One primary at a time: commit what is uncommitted first, then send it, then land it.
  const pushIsNext = rows.length === 0 && (status?.ahead ?? 0) > 0 && land?.kind !== 'merge'
  const landIsNext = rows.length === 0 && !pushIsNext
  const landNow = (next: LandOffer): void => {
    if (next.kind === 'merge') openDialog({ kind: 'confirm-merge', worktreeId })
    else if (next.kind !== 'merged') void createPullRequest(worktreeId)
  }
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
          {offersUpdate ? (
            <button
              type="button"
              className="button button--small"
              disabled={updating !== null}
              onClick={() => void updateWorktree(worktreeId)}
            >
              {updating === worktreeId ? 'Updating…' : `Update from ${updateFrom(status, base)}`}
            </button>
          ) : null}
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
          {land?.kind === 'merged' ? (
            <>
              <span className="chip changes__merged">Merged</span>
              <button type="button" className="button button--small" onClick={() => void removeWorktree(worktreeId)}>
                Remove Worktree…
              </button>
            </>
          ) : land ? (
            <button
              type="button"
              className={`button button--small${landIsNext ? ' button--primary' : ''}`}
              disabled={land.kind === 'create-pr' && openingPullRequest}
              onClick={() => landNow(land)}
            >
              {land.kind === 'create-pr' && openingPullRequest ? 'Creating…' : landLabel(land)}
            </button>
          ) : null}
        </div>
      ) : null}
      {updateError === undefined ? null : (
        <p className="changes__updateFailed" role="alert">
          {updateError}
        </p>
      )}
      {conflictRows.length > 0 || midway !== undefined ? (
        <section className="changes__conflicts" aria-label="Conflicts">
          <h3 className="commits__title">
            Conflicts
            <span className="panel__count">{conflictRows.length}</span>
          </h3>
          <ul className="changes__list">
            {conflictRows.map((change) => (
              <li
                className={`changes__item${change.path === selectedPath ? ' changes__item--selected' : ''}`}
                key={change.path}
              >
                <button
                  type="button"
                  className="change"
                  aria-current={change.path === selectedPath ? 'true' : undefined}
                  title={change.path}
                  onClick={() => selectChange(change.path)}
                >
                  <span className="change__kind change__kind--conflicted" aria-label={KIND_LABEL.conflicted}>
                    {KIND_LETTER.conflicted}
                  </span>
                  <span className="change__path">
                    <span className="change__dir">{directoryOf(change.path)}</span>
                    <span className="change__name">{fileNameOf(change.path)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="changes__conflictActions">
            {agentPane !== undefined && conflictRows.length > 0 ? (
              <button
                type="button"
                className="button button--small button--primary"
                onClick={() => {
                  const paths = conflictRows.map((change) => change.path)
                  void typeIntoPane(agentPane.id, resolvePrompt(paths, midway, base))
                  focusPane(agentPane.id)
                }}
              >
                Ask {harnessName(agentPane.kind)} to Resolve
              </button>
            ) : null}
            {midway === undefined ? null : (
              <button type="button" className="button button--small" onClick={() => void abortUpdate(worktreeId)}>
                Abort
              </button>
            )}
          </div>
        </section>
      ) : null}
      {push?.phase === 'failed' ? (
        <PushFailed error={push.error} detail={push.detail} retry={() => void pushActiveWorktree()} busy={pushing} />
      ) : null}
      <ReviewBar worktreeId={worktreeId} changed={rows.length > 0} />
      {changes === undefined ? (
        <p className="changes__empty">Reading…</p>
      ) : rows.length === 0 ? (
        conflictRows.length > 0 ? null : (
          <p className="changes__empty">{emptyChangesLabel(log)}</p>
        )
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
                onDoubleClick={() => selectChange(change.path, true)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault()
                    selectChange(change.path, true)
                    return
                  }
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
                {isViewedRow(viewed?.[change.path], change) ? (
                  <span className="change__viewed" role="img" aria-label="Viewed" title="Viewed">
                    ✓
                  </span>
                ) : null}
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

      {rows.length > 0 && midway === undefined ? (
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

/** The running agent pane of this worktree, one started as an agent before one typed into a shell. */
export function agentPaneOf(
  terminals: Readonly<Record<string, Terminal>>,
  worktreeId: string
): { id: string; kind: NonNullable<Terminal['agent']> } | undefined {
  const panes = Object.values(terminals).filter((terminal) => terminal.worktreeId === worktreeId && terminal.running)
  const started = panes.find((terminal) => terminal.agent !== undefined)
  if (started?.agent !== undefined) return { id: started.id, kind: started.agent }
  const typed = panes.find((terminal) => terminal.foregroundAgent !== undefined)
  return typed?.foregroundAgent === undefined ? undefined : { id: typed.id, kind: typed.foregroundAgent }
}

/** One line for the agent, typed and not sent: the files, and how to finish without an editor. */
export function resolvePrompt(
  paths: readonly string[],
  operation: 'rebase' | 'merge' | undefined,
  base = 'the base'
): string {
  const files = paths.join(', ')
  if (operation === 'rebase') {
    return `Resolve the conflicts in ${files} from rebasing onto ${base}, then run GIT_EDITOR=true git rebase --continue`
  }
  if (operation === 'merge')
    return `Resolve the conflicts in ${files} from merging ${base}, then run git commit --no-edit`
  return `Resolve the conflicts in ${files}`
}

/** The base's branch name (`main` for `origin/main`) when the worktree is behind it and nothing is mid-way; else null. */
export function updateFrom(status: WorktreeStatus | undefined, baseRef: string | undefined): string | null {
  if (!status || status.missing || status.behind === 0 || status.operation !== undefined) return null
  if (baseRef === undefined) return 'base'
  const slash = baseRef.indexOf('/')
  return slash === -1 ? baseRef : baseRef.slice(slash + 1)
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

const PUSH_LABEL = { push: ['Push', 'Pushing…'], publish: ['Publish Branch', 'Publishing…'] } as const

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
