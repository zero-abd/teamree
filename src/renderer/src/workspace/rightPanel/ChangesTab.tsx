// What this worktree has changed: the list, the commit box, the commits and the patch, as a tab of the
// right panel. It rides the same invalidation as everything else, so pane edits move it.

import { useState } from 'react'
import { openInBrowser } from '../../shell/openInBrowser'
import { useWorkspaceStore, type PushState } from '../../state/workspaceStore'
import { PatchView } from '../PatchView'
import { KIND_LABEL, KIND_LETTER } from './changeKinds'
import type { DiffLayout } from '../../state/preferences'
import type { WorktreeLog, WorktreeStatus } from '@shared/entities'

/** The two layouts, and the two words that offer them. */
const LAYOUTS: readonly [DiffLayout, string][] = [
  ['inline', 'Inline'],
  ['split', 'Side by side']
]

export function ChangesTab(): React.JSX.Element | null {
  const worktreeId = useWorkspaceStore((state) => state.activeWorktreeId)
  const changes = useWorkspaceStore((state) => (worktreeId ? state.changes[worktreeId] : undefined))
  const selectedPath = useWorkspaceStore((state) => state.selectedChangePath)
  const diff = useWorkspaceStore((state) => state.diff)
  const stagedDiff = useWorkspaceStore((state) => state.stagedDiff)
  const diffPending = useWorkspaceStore((state) => state.diffPending)
  const hunkPending = useWorkspaceStore((state) => state.hunkPending)
  const applyHunk = useWorkspaceStore((state) => state.applyHunk)
  const diffLayout = useWorkspaceStore((state) => state.diffLayout)
  const setDiffLayout = useWorkspaceStore((state) => state.setDiffLayout)
  const selectChange = useWorkspaceStore((state) => state.selectChange)
  const stagedPaths = useWorkspaceStore((state) => state.stagedPaths)
  const toggleStaged = useWorkspaceStore((state) => state.toggleStaged)
  const setAllStaged = useWorkspaceStore((state) => state.setAllStaged)
  const commitStaged = useWorkspaceStore((state) => state.commitStaged)
  const committing = useWorkspaceStore((state) => state.committing)
  const log = useWorkspaceStore((state) => (worktreeId ? state.logs[worktreeId] : undefined))
  const status = useWorkspaceStore((state) => (worktreeId ? state.statuses[worktreeId] : undefined))
  const push = useWorkspaceStore((state) => (worktreeId ? state.pushes[worktreeId] : undefined))
  const pushing = useWorkspaceStore((state) => state.pushing)
  const pushActiveWorktree = useWorkspaceStore((state) => state.pushActiveWorktree)
  // Per worktree: the panel is not remounted on tab change, and a message could land on the wrong diff.
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const message = draftFor(drafts, worktreeId)

  if (!worktreeId) return null

  const setMessage = (next: string): void => setDrafts((current) => withDraft(current, worktreeId, next))

  const rows = changes?.changes ?? []
  const ticked = new Set(stagedPaths)
  const allTicked = rows.length > 0 && rows.every((change) => ticked.has(change.path))
  const canCommit = ticked.size > 0 && message.trim().length > 0 && !committing

  const offer = pushOffer(status, push)

  const commit = (): void => {
    if (!canCommit) return
    // The message is the one thing the app cannot reconstruct; only a commit that landed clears it.
    void commitStaged(message).then(() => {
      if (useWorkspaceStore.getState().stagedPaths.length === 0) setMessage('')
    })
  }

  return (
    <section className="changes" aria-label="Changes in this worktree">
      {status && !status.missing ? (
        <div className="changes__head">
          <span className="changes__ref" title={`↑ ${status.upstream ?? log?.baseRef ?? ''}  ↓ ${log?.baseRef ?? ''}`}>
            <span className="changes__branch">{status.branch}</span>
            {` · ↑${status.ahead} ↓${status.behind}`}
          </span>
          {push?.phase === 'failed' ? (
            <p className="changes__pushError" role="alert" title={push.error}>
              {push.error}
            </p>
          ) : null}
          {offer?.kind === 'review' ? (
            <button type="button" className="button button--small" onClick={() => openInBrowser(offer.url)}>
              Open review
            </button>
          ) : offer ? (
            <button
              type="button"
              className="button button--primary button--small"
              disabled={pushing}
              onClick={() => void pushActiveWorktree()}
            >
              {PUSH_LABEL[offer.kind][push?.phase === 'pushing' ? 1 : 0]}
            </button>
          ) : null}
        </div>
      ) : null}
      {changes === undefined ? (
        <p className="changes__empty">Reading…</p>
      ) : rows.length === 0 ? (
        <p className="changes__empty">{emptyChangesLabel(log)}</p>
      ) : (
        <ul className="changes__list">
          {rows.map((change) => (
            <li className="changes__item" key={change.path}>
              <input
                type="checkbox"
                className="change__tick"
                checked={ticked.has(change.path)}
                aria-label={`Include ${change.path} in the next commit`}
                onChange={() => toggleStaged(change.path)}
              />
              <button
                type="button"
                className={`change${change.path === selectedPath ? ' change--selected' : ''}`}
                title={change.from === undefined ? change.path : `${change.from} → ${change.path}`}
                onClick={() => selectChange(change.path === selectedPath ? null : change.path)}
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
              </button>
            </li>
          ))}
        </ul>
      )}

      {rows.length > 0 ? (
        <div className="changes__commit">
          <div className="changes__all">
            <label>
              <input type="checkbox" checked={allTicked} onChange={() => setAllStaged(!allTicked)} />
              All
            </label>
            <span className="changes__allCount">
              {ticked.size}/{rows.length}
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
            {committing ? 'Committing…' : 'Commit'}
          </button>
        </div>
      ) : null}

      {changes?.truncated ? (
        <p className="changes__note">
          Showing {changes.limit} of {changes.total}.
        </p>
      ) : null}

      {log?.unavailable !== undefined ? (
        <p className="commits__unknown" title={log.unavailable}>
          Could not read what this branch has committed.
        </p>
      ) : null}

      {log && log.commits.length > 0 ? (
        <section className="commits" aria-label="Commits this worktree has made">
          <h3 className="commits__title">
            {log.commits.length}
            {log.truncated ? '+' : ''} commit{log.commits.length === 1 && !log.truncated ? '' : 's'} not in{' '}
            {log.baseRef}
          </h3>
          <ul className="commits__list">
            {log.commits.map((commit) => (
              <li className="commit" key={commit.sha} title={`${commit.author} · ${commit.committedAt}`}>
                <span className="commit__sha">{commit.shortSha}</span>
                <span className="commit__subject">{commit.subject}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {selectedPath === null ? null : (
        <>
          {/* Two words and no label. The panel is narrow enough that a column
              of explanation would cost more than the choice is worth, and the
              two labels say what each one does. Outside the scrolling area
              below it, so it is still there at line four hundred. */}
          <div className="changes__layout" role="group" aria-label="How to lay the patch out">
            {LAYOUTS.map(([value, label]) => (
              <button
                type="button"
                key={value}
                className={`changes__layoutPick${diffLayout === value ? ' changes__layoutPick--on' : ''}`}
                aria-pressed={diffLayout === value}
                onClick={() => setDiffLayout(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="changes__diff">
            {diffPending ? (
              <p className="changes__empty">Reading the patch…</p>
            ) : (diff === null || diff.patch === '') && stagedDiff === null ? (
              <p className="changes__empty">No patch for this path.</p>
            ) : (
              <>
                {/* The staged half first, because it is what the next commit
                    already contains and the working half is what is still being
                    decided. Headings only appear once there is something on
                    both sides of the line — a patch with nothing staged is the
                    ordinary case and reads better with nothing above it. */}
                {stagedDiff === null ? null : (
                  <>
                    <h3 className="changes__half">Staged</h3>
                    <PatchView
                      patch={stagedDiff.patch}
                      truncated={stagedDiff.truncated}
                      layout={diffLayout}
                      action="Unstage"
                      busy={hunkPending}
                      onHunk={(file, hunk) => void applyHunk(file.path, hunk, false)}
                    />
                  </>
                )}
                {diff === null || diff.patch === '' ? null : (
                  <>
                    {stagedDiff === null ? null : <h3 className="changes__half">Unstaged</h3>}
                    <PatchView
                      patch={diff.patch}
                      truncated={diff.truncated}
                      layout={diffLayout}
                      action="Stage"
                      busy={hunkPending}
                      onHunk={(file, hunk) => void applyHunk(file.path, hunk, true)}
                    />
                  </>
                )}
              </>
            )}
          </div>
        </>
      )}
    </section>
  )
}

const PUSH_LABEL = { push: ['Push', 'Pushing…'], publish: ['Publish branch', 'Publishing…'] } as const

export type PushOffer = { kind: 'push' | 'publish' } | { kind: 'review'; url: string }

/** The header's one button: send what the remote lacks, else open the review the last push made. */
export function pushOffer(status: WorktreeStatus | undefined, push: PushState | undefined): PushOffer | null {
  if (!status || status.missing) return null
  if (status.upstream === null) return { kind: 'publish' }
  if (status.ahead > 0 || push?.phase === 'pushing') return { kind: 'push' }
  if (push?.phase === 'pushed' && push.reviewUrl !== undefined) return { kind: 'review', url: push.reviewUrl }
  return null
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
