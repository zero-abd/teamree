// A subagent's transcript, read-only, re-read while it runs. The text is the agent's, drawn as text only.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Subagent, SubagentTranscript } from '@shared/entities'
import { Modal } from '../dialogs/Modal'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { elapsedLabel, subagentElapsed } from './subagentTree'

/** How often a running subagent's transcript is read again. */
export const TRANSCRIPT_REFRESH_MS = 3_000

type Props = {
  terminalId: string
  subagent: Subagent
  /** Whether the pane still lists it. */
  running: boolean
  now: number
  onClose: () => void
}

/** Drawn on the body, not inside the sidebar row that opened it. */
export function SubagentTranscriptDialog({ terminalId, subagent, running, now, onClose }: Props): React.ReactPortal {
  const [read, setRead] = useState<SubagentTranscript | null>(null)
  const [error, setError] = useState<string | null>(null)
  const list = useRef<HTMLOListElement | null>(null)
  const pinned = useRef(true)

  useEffect(() => {
    let alive = true
    const load = (): void => {
      runtimeClient.call('terminal.subagentTranscript', { terminalId, agentId: subagent.id }).then(
        (next) => {
          if (!alive) return
          setRead(next)
          setError(null)
        },
        (failure: unknown) => {
          if (alive) setError(failure instanceof Error ? failure.message : String(failure))
        }
      )
    }
    load()
    const timer = running ? setInterval(load, TRANSCRIPT_REFRESH_MS) : undefined
    return () => {
      alive = false
      if (timer !== undefined) clearInterval(timer)
    }
  }, [terminalId, subagent.id, running])

  // Follows the tail unless the reader has scrolled up.
  useLayoutEffect(() => {
    const node = list.current
    if (node !== null && pinned.current) node.scrollTop = node.scrollHeight
  }, [read])

  const facts = [subagent.agentType, running ? elapsedLabel(subagentElapsed(subagent, now)) : 'ended', subagent.branch]
  return createPortal(
    <Modal title={subagent.description} titleHint={subagent.worktreePath} onClose={onClose}>
      <div className="subagent-log">
        <p className="subagent-log__meta">{facts.filter((fact) => fact !== undefined).join(' · ')}</p>
        {error !== null ? (
          <p className="subagent-log__meta subagent-log__meta--error">{error}</p>
        ) : read === null ? (
          <p className="subagent-log__meta">Loading</p>
        ) : read.lines.length === 0 ? (
          <p className="subagent-log__meta">Nothing yet</p>
        ) : (
          <ol
            className="subagent-log__lines"
            ref={list}
            onScroll={(event) => {
              const node = event.currentTarget
              pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24
            }}
          >
            {read.truncated ? (
              <li className="subagent-log__line subagent-log__line--note">Earlier lines left out</li>
            ) : null}
            {read.lines.map((line, index) => (
              <li key={index} className={`subagent-log__line subagent-log__line--${line.kind}`}>
                <pre>{line.text}</pre>
              </li>
            ))}
          </ol>
        )}
        <div className="modal__actions">
          <button type="button" className="button" data-default onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Modal>,
    document.body
  )
}
