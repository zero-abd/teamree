// Under the Changes header: the pull request's state, review and checks, and the failures handed to the agent.

import { useState } from 'react'
import type { PullRequestCheck, WorktreeLanding } from '@shared/entities'
import { checksTone, checksWords, reviewWord } from '../../sidebar/pullRequestChip'
import { openInBrowser } from '../../shell/openInBrowser'
import { useWorkspaceStore } from '../../state/workspaceStore'
import { idleAgentPane, sendCheckFailure } from './checkFailure'

const GLYPH: Record<PullRequestCheck['state'], string> = { pass: '✓', fail: '✗', pending: '○' }
const STATE_WORD = { open: 'Open', merged: 'Merged', closed: 'Closed' } as const

export function PullRequestChecks({
  worktreeId,
  pull
}: {
  worktreeId: string
  pull: NonNullable<WorktreeLanding['pullRequest']>
}): React.JSX.Element {
  const idle = useWorkspaceStore((state) =>
    idleAgentPane(state.terminals, worktreeId, state.layouts[worktreeId]?.focusedTerminalId ?? null)
  )
  const focusPane = useWorkspaceStore((state) => state.focusPane)
  const showNotice = useWorkspaceStore((state) => state.showNotice)
  const [sending, setSending] = useState(false)
  const open = pull.state === 'open'
  const checks = open ? pull.checks : undefined
  const review = open ? reviewWord(pull.review) : undefined
  const words = checksWords(checks)

  const send = async (): Promise<void> => {
    const target = idle?.id
    setSending(true)
    const outcome = await sendCheckFailure(worktreeId).finally(() => setSending(false))
    if (outcome === 'sent' && target !== undefined) focusPane(target)
    else if (outcome === 'refused') showNotice('The agent is busy', 'info')
    else if (outcome === 'failed') showNotice('Could not type into the pane', 'error')
  }

  return (
    <section className="changes__pr" aria-label={`Pull Request #${pull.number}`}>
      <div className="changes__prLine">
        <button type="button" className="changes__prLink" title={pull.url} onClick={() => openInBrowser(pull.url)}>
          #{pull.number}
        </button>
        <span className="changes__prState">{open && pull.draft === true ? 'Draft' : STATE_WORD[pull.state]}</span>
        {words === undefined ? null : (
          <button
            type="button"
            className={`changes__prLink prcheck--${checksTone(checks)}`}
            onClick={() => openInBrowser(`${pull.url}/checks`)}
          >
            {words}
          </button>
        )}
        {review === undefined ? null : (
          <button
            type="button"
            className={`changes__prLink${pull.review === 'changes' ? ' prcheck--fail' : ''}`}
            onClick={() => openInBrowser(`${pull.url}/files`)}
          >
            {review}
          </button>
        )}
      </div>
      {checks === undefined ? null : (
        <ul className="changes__checks" aria-label="Checks">
          {checks.list.map((check) => (
            <li key={check.name} className="changes__check">
              <span className={`changes__checkGlyph prcheck--${check.state}`} aria-label={check.state}>
                {GLYPH[check.state]}
              </span>
              {check.url === undefined ? (
                <span className="changes__checkName">{check.name}</span>
              ) : (
                <button
                  type="button"
                  className="changes__checkName changes__prLink"
                  title={check.url}
                  onClick={() => openInBrowser(check.url as string)}
                >
                  {check.name}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {checks === undefined || checks.failing === 0 ? null : (
        <button
          type="button"
          className="button button--small changes__sendFailure"
          disabled={idle === undefined || sending}
          title={idle === undefined ? 'No idle agent' : undefined}
          onClick={() => void send()}
        >
          {sending ? 'Reading Logs…' : 'Send Failure to Agent'}
        </button>
      )}
    </section>
  )
}
