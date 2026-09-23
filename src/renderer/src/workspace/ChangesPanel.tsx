// What this worktree has actually changed, beside the terminals that changed it.
//
// The sidebar chips answer "is there anything here". This answers "what", which
// is the question you have the moment you are about to commit — and the one an
// agent's work leaves you with when you come back to a worktree it has been
// busy in for ten minutes.
//
// It rides the same invalidation as everything else, so an edit made in a pane
// two inches to the left moves this list without anyone asking it to.

import { useState } from 'react'
import { useWorkspaceStore } from '../state/workspaceStore'
import { PatchView } from './PatchView'
import type { DiffLayout } from '../state/preferences'
import type { WorktreeChange, WorktreeLog } from '@shared/entities'

/** One letter per kind, the way git itself abbreviates them. */
const KIND_LETTER: Record<WorktreeChange['kind'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  typeChanged: 'T',
  untracked: '?',
  conflicted: '!'
}

/** The two layouts, and the two words that offer them. */
const LAYOUTS: readonly [DiffLayout, string][] = [
  ['inline', 'Inline'],
  ['split', 'Side by side']
]

const KIND_LABEL: Record<WorktreeChange['kind'], string> = {
  modified: 'Modified',
  added: 'Added',
  deleted: 'Deleted',
  renamed: 'Renamed',
  copied: 'Copied',
  typeChanged: 'Type changed',
  untracked: 'Untracked',
  conflicted: 'Conflicted'
}

export function ChangesPanel(): React.JSX.Element | null {
  const open = useWorkspaceStore((state) => state.changesOpen)
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
  const toggleChanges = useWorkspaceStore((state) => state.toggleChanges)
  const stagedPaths = useWorkspaceStore((state) => state.stagedPaths)
  const toggleStaged = useWorkspaceStore((state) => state.toggleStaged)
  const setAllStaged = useWorkspaceStore((state) => state.setAllStaged)
  const commitStaged = useWorkspaceStore((state) => state.commitStaged)
  const committing = useWorkspaceStore((state) => state.committing)
  const log = useWorkspaceStore((state) => (worktreeId ? state.logs[worktreeId] : undefined))
  // Kept per worktree, because this panel is never remounted when the tabs
  // change under it. A message typed for one worktree, still in the box over
  // another one's diff, is a sentence about work that is not there — and the
  // commit button beside it will happily put it on the change that is.
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const message = draftFor(drafts, worktreeId)

  if (!open || !worktreeId) return null

  const setMessage = (next: string): void => setDrafts((current) => withDraft(current, worktreeId, next))

  const rows = changes?.changes ?? []
  const ticked = new Set(stagedPaths)
  const allTicked = rows.length > 0 && rows.every((change) => ticked.has(change.path))
  const canCommit = ticked.size > 0 && message.trim().length > 0 && !committing

  const commit = (): void => {
    if (!canCommit) return
    // The message is the one thing on this screen the app cannot reconstruct,
    // and a commit can be refused for a reason the user has to go and fix —
    // an unset git identity, a conflict, nothing staged. Clearing the box on
    // the way out would make them type it again to try. A commit that landed
    // is the one that empties the selection, so that is what is asked.
    void commitStaged(message).then(() => {
      if (useWorkspaceStore.getState().stagedPaths.length === 0) setMessage('')
    })
  }

  return (
    <aside className="changes" aria-label="Changes in this worktree">
      <header className="changes__head">
        <h2 className="changes__title">Changes</h2>
        {changes ? <span className="changes__count">{changes.total}</span> : null}
        <button type="button" className="changes__close" aria-label="Hide changes" onClick={toggleChanges}>
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 3 L9 9 M9 3 L3 9" />
          </svg>
        </button>
      </header>

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
          <label className="changes__all">
            <input
              type="checkbox"
              checked={allTicked}
              aria-label={allTicked ? 'Clear every file' : 'Include every file'}
              onChange={() => setAllStaged(!allTicked)}
            />
            <span>
              {ticked.size} of {rows.length} selected
            </span>
          </label>
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
    </aside>
  )
}

/**
 * The commit message for one worktree, which is the only worktree it is about.
 *
 * Held rather than cleared on the way out. The panel already refuses to empty
 * the box when a commit is refused, for the reason that a message is the one
 * thing on this screen the app cannot reconstruct; going to look at another
 * worktree's diff is a weaker reason to throw it away than a failed commit, so
 * it is not one either.
 */
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

/**
 * What an empty changes list means, which is three different things.
 *
 * "Nothing changed here yet" is a claim about the worktree, and it is the wrong
 * one to make when the base could not be compared against at all: an agent that
 * has just committed a day of work leaves exactly this screen behind, and the
 * sentence would tell somebody the work is gone.
 */
export function emptyChangesLabel(log: WorktreeLog | undefined): string {
  if (log?.unavailable !== undefined) return 'Nothing uncommitted here.'
  if ((log?.commits.length ?? 0) > 0) return 'Everything here is committed.'
  return 'Nothing changed here yet.'
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
