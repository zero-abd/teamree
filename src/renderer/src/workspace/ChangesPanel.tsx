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
import type { WorktreeChange } from '@shared/entities'

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
  const diffPending = useWorkspaceStore((state) => state.diffPending)
  const selectChange = useWorkspaceStore((state) => state.selectChange)
  const toggleChanges = useWorkspaceStore((state) => state.toggleChanges)
  const stagedPaths = useWorkspaceStore((state) => state.stagedPaths)
  const toggleStaged = useWorkspaceStore((state) => state.toggleStaged)
  const setAllStaged = useWorkspaceStore((state) => state.setAllStaged)
  const commitStaged = useWorkspaceStore((state) => state.commitStaged)
  const committing = useWorkspaceStore((state) => state.committing)
  const [message, setMessage] = useState('')

  if (!open || !worktreeId) return null

  const rows = changes?.changes ?? []
  const ticked = new Set(stagedPaths)
  const allTicked = rows.length > 0 && rows.every((change) => ticked.has(change.path))
  const canCommit = ticked.size > 0 && message.trim().length > 0 && !committing

  const commit = (): void => {
    if (!canCommit) return
    void commitStaged(message).then(() => setMessage(''))
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
        <p className="changes__empty">Nothing changed here yet.</p>
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

      {selectedPath === null ? null : (
        <div className="changes__diff">
          {diffPending ? (
            <p className="changes__empty">Reading the patch…</p>
          ) : diff && diff.patch !== '' ? (
            <pre className="patch">
              {diff.patch.split('\n').map((line, index) => (
                // The index is the only identity a diff line has: two lines of a
                // patch can be byte-identical and still be different lines.
                <span className={`patch__line patch__line--${lineKind(line)}`} key={index}>
                  {line === '' ? ' ' : line}
                </span>
              ))}
              {diff.truncated ? <span className="patch__line patch__line--note">… cut short</span> : null}
            </pre>
          ) : (
            <p className="changes__empty">No patch for this path.</p>
          )}
        </div>
      )}
    </aside>
  )
}

/**
 * Which part of a unified diff a line belongs to. Deliberately positional, the
 * way the format is: the first character decides, and `---`/`+++` are headers
 * rather than a removal and an addition.
 */
export function lineKind(line: string): 'added' | 'removed' | 'header' | 'hunk' | 'context' {
  if (line.startsWith('+++') || line.startsWith('---')) return 'header'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('new file')) return 'header'
  if (line.startsWith('+')) return 'added'
  if (line.startsWith('-')) return 'removed'
  return 'context'
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
