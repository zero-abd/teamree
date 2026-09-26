// A conflicted file in place of its diff: each block's two sides named by task, ↑/↓ between the
// blocks, and the file's three answers. Read from the file as it is, so a hand fix shows at once.

import { useEffect, useRef, useState } from 'react'
import { parseConflicts, type ConflictPart } from '@shared/conflictMarkers'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from '../state/workspaceStore'
import { updateSides } from '../workspace/rightPanel/conflictState'

/** Text runs longer than this show their ends and fold the middle. */
const SHOWN_TEXT = 8
const EDGE = 3

export function ConflictView({ worktreeId, path }: { worktreeId: string; path: string }): React.JSX.Element {
  const filesEpoch = useWorkspaceStore((state) => state.worktreeFilesEpoch)
  const operation = useWorkspaceStore((state) => state.statuses[worktreeId]?.operation)
  const worktrees = useWorkspaceStore((state) => state.worktrees)
  const projects = useWorkspaceStore((state) => state.projects)
  const resolveConflict = useWorkspaceStore((state) => state.resolveConflict)
  const [parts, setParts] = useState<ConflictPart[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [at, setAt] = useState(0)
  const scroller = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let alive = true
    runtimeClient
      .call('file.read', { worktreeId, path })
      .then((read) => {
        if (alive) setParts(parseConflicts(read.content))
      })
      .catch((failure: unknown) => {
        if (alive) setError(failure instanceof Error ? failure.message : String(failure))
      })
    return () => {
      alive = false
    }
  }, [worktreeId, path, filesEpoch])

  const sides = updateSides(worktrees, projects, worktreeId)
  // A rebase replays this task onto the other side, so git's HEAD is the incoming one there.
  const [oursName, theirsName] = operation === 'rebase' ? [sides.incoming, sides.task] : [sides.task, sides.incoming]
  const blocks = (parts ?? []).filter((part) => part.kind === 'conflict').length
  const current = Math.min(at, Math.max(0, blocks - 1))

  const go = (step: number): void => {
    const next = (current + step + blocks) % blocks
    setAt(next)
    scroller.current?.querySelector(`[data-conflict="${next}"]`)?.scrollIntoView?.({ block: 'center' })
  }

  let index = -1
  return (
    <div className="file__diffs">
      <div className="conflict__bar">
        <span className="conflict__count">
          {parts === null ? '' : blocks === 0 ? 'No markers left' : `${current + 1} of ${blocks}`}
        </span>
        <button
          type="button"
          className="file__icon"
          aria-label="Previous conflict"
          disabled={blocks < 2}
          onClick={() => go(-1)}
        >
          ↑
        </button>
        <button
          type="button"
          className="file__icon"
          aria-label="Next conflict"
          disabled={blocks < 2}
          onClick={() => go(1)}
        >
          ↓
        </button>
        <span className="conflict__answers">
          <button type="button" onClick={() => void resolveConflict(worktreeId, path)}>
            Mark Resolved
          </button>
          <button
            type="button"
            title={`${sides.task}’s version`}
            onClick={() => void resolveConflict(worktreeId, path, 'ours')}
          >
            Take Ours
          </button>
          <button
            type="button"
            title={`${sides.incoming}’s version`}
            onClick={() => void resolveConflict(worktreeId, path, 'theirs')}
          >
            Take Theirs
          </button>
        </span>
      </div>
      {parts === null ? (
        <p className="file__state">{error ?? 'Reading…'}</p>
      ) : (
        <div className="file__diff conflict" ref={scroller} tabIndex={-1}>
          {parts.map((part) => {
            if (part.kind === 'text') return <Text key={`text:${index}`} lines={part.lines} />
            index += 1
            return (
              <section
                key={`conflict:${part.line}`}
                className={`conflict__block${index === current ? ' conflict__block--current' : ''}`}
                data-conflict={index}
                aria-label={`Conflict at line ${part.line}`}
              >
                <Side kind="ours" name={oursName} lines={part.ours} />
                {part.base === undefined ? null : <Side kind="base" name="base" lines={part.base} />}
                <Side kind="theirs" name={theirsName} lines={part.theirs} />
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Side({ kind, name, lines }: { kind: string; name: string; lines: string[] }): React.JSX.Element {
  return (
    <div className={`conflict__side conflict__side--${kind}`}>
      <span className="conflict__label">{name}</span>
      <pre>{lines.join('\n')}</pre>
    </div>
  )
}

function Text({ lines }: { lines: string[] }): React.JSX.Element {
  if (lines.length <= SHOWN_TEXT) return <pre className="conflict__text">{lines.join('\n')}</pre>
  return (
    <>
      <pre className="conflict__text">{lines.slice(0, EDGE).join('\n')}</pre>
      <details className="conflict__fold">
        <summary>⋯ {lines.length - 2 * EDGE} lines</summary>
        <pre className="conflict__text">{lines.slice(EDGE, -EDGE).join('\n')}</pre>
      </details>
      <pre className="conflict__text">{lines.slice(-EDGE).join('\n')}</pre>
    </>
  )
}
