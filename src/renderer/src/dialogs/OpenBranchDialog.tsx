// A worktree on a branch as it is: a teammate's, or an open pull request's head.
// Pick one, optionally start one agent on it, Open. The row's work is `startTask`'s.

import { useEffect, useState } from 'react'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from '../state/workspaceStore'
import { AgentSteppers } from './AgentSteppers'
import { Modal } from './Modal'
import { branchRows, filterRows, pullRequestRows, reviewPrompt, type OpenableRow } from './openBranchModel'
import { fanOut, type AgentCounts } from './taskPlan'

type Listing = { phase: 'loading' } | { phase: 'ready'; rows: OpenableRow[] } | { phase: 'error'; message: string }

export const OPEN_BRANCH_TITLE = 'Open Branch'
export const OPEN_PULL_REQUEST_TITLE = 'Check Out Pull Request'

export function OpenBranchDialog({
  projectId,
  pullRequests
}: {
  projectId: string
  pullRequests: boolean
}): React.JSX.Element | null {
  const project = useWorkspaceStore((state) => state.projects.find((entry) => entry.id === projectId))
  const agents = useWorkspaceStore((state) => state.agents)
  const startTask = useWorkspaceStore((state) => state.startTask)
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)

  const [listing, setListing] = useState<Listing>({ phase: 'loading' })
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<string | null>(null)
  const [counts, setCounts] = useState<AgentCounts>({})
  const [prompt, setPrompt] = useState<string | null>(null)

  const baseRef = project?.baseRef ?? 'HEAD'
  useEffect(() => {
    let live = true
    const now = Date.now()
    const read = pullRequests
      ? runtimeClient.call('worktree.pullRequests', { projectId }).then((list) => {
          if (!list.available) throw new Error(`gh unavailable · ${list.reason ?? 'not installed'}`)
          return pullRequestRows(list.pullRequests, now)
        })
      : runtimeClient.call('worktree.branches', { projectId }).then((list) => branchRows(list.branches, baseRef, now))
    read.then(
      (rows) => live && setListing({ phase: 'ready', rows }),
      (error: unknown) =>
        live && setListing({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
    )
    return () => {
      live = false
    }
  }, [projectId, pullRequests, baseRef])

  if (!project) return null

  const rows = listing.phase === 'ready' ? filterRows(listing.rows, query) : []
  const row = rows.find((entry) => entry.key === chosen) ?? rows[0]
  const selection = fanOut(agents, counts)
  const agent = selection[0]
  const told = (prompt ?? reviewPrompt(row?.base ?? baseRef)).trim()

  const move = (by: number): void => {
    if (rows.length === 0) return
    const at = row === undefined ? -1 : rows.indexOf(row)
    setChosen(rows[(at + by + rows.length) % rows.length]?.key ?? null)
  }

  const submit = (): void => {
    if (row === undefined) return
    startTask({
      projectId,
      checkout: row.checkout,
      ...(pullRequests ? { base: row.base } : {}),
      creates: [
        agent === undefined ? { name: row.name, task: '' } : { name: row.name, task: told, agentCommand: agent.command }
      ]
    })
  }

  return (
    <Modal title={pullRequests ? OPEN_PULL_REQUEST_TITLE : OPEN_BRANCH_TITLE} onClose={closeDialog}>
      <form
        className="form palette"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <input
          className="palette__input"
          aria-label="Filter"
          placeholder={pullRequests ? 'Filter pull requests' : 'Filter branches'}
          value={query}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              move(event.key === 'ArrowDown' ? 1 : -1)
            }
          }}
        />
        {listing.phase === 'loading' ? <p className="palette__empty">Reading…</p> : null}
        {listing.phase === 'error' ? <p className="palette__empty">{listing.message}</p> : null}
        {listing.phase === 'ready' && rows.length === 0 ? (
          <p className="palette__empty">{pullRequests ? 'No open pull requests' : 'No branch to open'}</p>
        ) : null}
        {rows.length === 0 ? null : (
          <ul className="palette__list" role="listbox" aria-label={pullRequests ? 'Pull requests' : 'Branches'}>
            {rows.map((entry) => (
              <li key={entry.key} role="option" aria-selected={entry === row}>
                <button
                  type="button"
                  className={`palette__row open-branch__row${entry === row ? ' palette__row--selected' : ''}`}
                  onClick={() => setChosen(entry.key)}
                  onDoubleClick={() => {
                    setChosen(entry.key)
                    submit()
                  }}
                >
                  <span className="palette__label">{entry.title}</span>
                  <span className="palette__trailing">{entry.detail}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <AgentSteppers agents={agents} counts={counts} onChange={setCounts} most={1} />
        {agent === undefined ? null : (
          <label className="field">
            <span className="field__label">Prompt</span>
            <textarea
              className="field__input"
              rows={2}
              value={prompt ?? reviewPrompt(row?.base ?? baseRef)}
              onChange={(event) => setPrompt(event.target.value)}
              spellCheck={true}
            />
          </label>
        )}
        <footer className="modal__actions">
          <button type="button" className="button button--ghost" onClick={closeDialog}>
            Cancel
          </button>
          <button type="submit" className="button button--primary" disabled={row === undefined}>
            Open
          </button>
        </footer>
      </form>
    </Modal>
  )
}
