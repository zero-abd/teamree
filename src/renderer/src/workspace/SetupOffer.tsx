// The setup command a lockfile suggests, offered in the style of SetupAsk on a project's first two
// worktrees. Use saves it for new worktrees; Run starts it in this one. Nothing runs unless Run is pressed.

import { useEffect, useState } from 'react'
import type { Project, Worktree, WorktreeSetupCheck } from '@shared/entities'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from '../state/workspaceStore'
import {
  offeredOn,
  readDismissed,
  readOfferedOn,
  setupOfferFor,
  writeDismissed,
  writeOfferedOn
} from './setupOfferModel'

const storage = typeof window === 'undefined' ? undefined : window.localStorage
// Not Now on a worktree's Run lasts until the app quits.
const skipped = new Set<string>()

export function SetupOffer({ project, worktree }: { project: Project; worktree: Worktree }): React.JSX.Element | null {
  const setProjectPaths = useWorkspaceStore((state) => state.setProjectPaths)
  const showNotice = useWorkspaceStore((state) => state.showNotice)
  const [check, setCheck] = useState<WorktreeSetupCheck>({})
  const [dismissed, setDismissed] = useState(() => readDismissed(storage))
  const [offered, setOffered] = useState(() => readOfferedOn(storage))
  const [, setSkips] = useState(0)
  const [draft, setDraft] = useState<string | null>(null)

  const checkable = worktree.state === 'ready' && worktree.missing !== true
  useEffect(() => {
    setCheck({})
    if (!checkable) return
    let live = true
    runtimeClient
      .call('worktree.setupCheck', { worktreeId: worktree.id })
      .then((answer) => {
        if (live) setCheck(answer)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [worktree.id, checkable])

  const found = setupOfferFor({
    project,
    worktree,
    check,
    dismissed: dismissed.includes(project.id),
    skipped: skipped.has(worktree.id)
  })
  const record = found?.kind === 'project' ? offeredOn(offered, project.id, worktree.id) : offered
  useEffect(() => {
    if (record === null || record === offered) return
    writeOfferedOn(storage, record)
    setOffered(record)
  }, [record, offered])
  const offer = record === null ? null : found
  if (offer === null) return null

  const skip = (): void => {
    skipped.add(worktree.id)
    setSkips((count) => count + 1)
  }

  if (offer.kind === 'worktree') {
    const run = (): void => {
      skip()
      runtimeClient
        .call('worktree.runSetup', { worktreeId: worktree.id, command: offer.command })
        .catch((error: unknown) =>
          showNotice(
            `Could not run the setup command: ${error instanceof Error ? error.message : String(error)}`,
            'error'
          )
        )
    }
    return (
      <section className="setup-ask" aria-label="Setup">
        <span className="setup-ask__label">no {offer.missing}</span>
        <code className="setup-ask__command">{offer.command}</code>
        <button type="button" className="button button--primary button--tiny" onClick={run}>
          Run
        </button>
        <button type="button" className="button button--tiny" onClick={skip}>
          Not Now
        </button>
      </section>
    )
  }

  const save = (command: string): void => {
    setDraft(null)
    if (command.trim() !== '') void setProjectPaths(project.id, { setupCommand: command })
  }
  const notNow = (): void => {
    const next = [...dismissed, project.id]
    setDismissed(next)
    writeDismissed(storage, next)
  }

  return (
    <section className="setup-ask" aria-label="Setup">
      <span className="setup-ask__label">new worktrees</span>
      {draft === null ? (
        <code className="setup-ask__command">{offer.command}</code>
      ) : (
        <input
          className="setup-ask__command setup-ask__field"
          aria-label="Setup command"
          value={draft}
          autoFocus
          data-own-escape
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') save(draft)
            else if (event.key === 'Escape') setDraft(null)
          }}
        />
      )}
      <button
        type="button"
        className="button button--primary button--tiny"
        onClick={() => save(draft ?? offer.command)}
      >
        Use
      </button>
      {draft === null ? (
        <button type="button" className="button button--tiny" onClick={() => setDraft(offer.command)}>
          Edit…
        </button>
      ) : null}
      <button type="button" className="button button--tiny" onClick={notNow}>
        Not Now
      </button>
    </section>
  )
}
