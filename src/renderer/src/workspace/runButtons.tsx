// Run Dev and Run Tests: a button per command the project has, in the strip, the row menu and the
// palette. While its pane runs the button shows that pane, beside Restart and Stop.

import type { Project, RunKind, Terminal } from '@shared/entities'
import { RUN_KINDS, RUN_LABEL, runCommandOf, runPaneOf, runState, type RunState } from '@shared/runCommands'
import { Icon } from '../icons/Icon'
import type { RowMenuItem } from '../sidebar/RowMenu'
import { useWorkspaceStore } from '../state/workspaceStore'

export type RunOffer = {
  kind: RunKind
  command: string
  /** The kind's pane, while this app has one. */
  pane?: Terminal
  state?: RunState
}

/** The kinds the project has a command for, each with its pane in this worktree. */
export function runOffers(
  project: Project | undefined,
  terminals: readonly Terminal[],
  worktreeId: string
): RunOffer[] {
  if (project === undefined) return []
  return RUN_KINDS.flatMap((kind) => {
    const run = runCommandOf(project, kind)
    if (run === undefined) return []
    const pane = runPaneOf(terminals, worktreeId, kind)
    return [{ kind, command: run.command, ...(pane === undefined ? {} : { pane, state: runState(pane) }) }]
  })
}

export type RunActions = { run: (kind: RunKind, restart: boolean) => void; stop: (kind: RunKind) => void }

/** `Run Dev`, or `Show Dev`, `Restart Dev` and `Stop Dev` while it runs. */
export function runMenuItems(offers: readonly RunOffer[], actions: RunActions): RowMenuItem[] {
  return offers.flatMap((offer): RowMenuItem[] => {
    const label = RUN_LABEL[offer.kind]
    if (offer.state !== 'running') {
      return [
        {
          label: `Run ${label}`,
          icon: <Icon name="play" size={14} />,
          hint: offer.command,
          onChoose: () => actions.run(offer.kind, false)
        }
      ]
    }
    return [
      { label: `Show ${label}`, onChoose: () => actions.run(offer.kind, false) },
      {
        label: `Restart ${label}`,
        icon: <Icon name="restart" size={14} />,
        onChoose: () => actions.run(offer.kind, true)
      },
      { label: `Stop ${label}`, icon: <Icon name="stop" size={14} />, onChoose: () => actions.stop(offer.kind) }
    ]
  })
}

export function useRunOffers(worktreeId: string | null): RunOffer[] {
  const project = useWorkspaceStore((state) => {
    const worktree = state.worktrees.find((entry) => entry.id === worktreeId)
    return state.projects.find((entry) => entry.id === worktree?.projectId)
  })
  const terminals = useWorkspaceStore((state) => state.terminals)
  return worktreeId === null ? [] : runOffers(project, Object.values(terminals), worktreeId)
}

export function useRunActions(worktreeId: string | null): RunActions {
  const runInWorktree = useWorkspaceStore((state) => state.runInWorktree)
  const stopRun = useWorkspaceStore((state) => state.stopRun)
  return {
    run: (kind, restart) => {
      if (worktreeId !== null) void runInWorktree(worktreeId, kind, restart)
    },
    stop: (kind) => {
      if (worktreeId !== null) void stopRun(worktreeId, kind)
    }
  }
}

/** The strip's Run buttons for the worktree on screen. */
export function RunButtons({ worktreeId }: { worktreeId: string }): React.JSX.Element | null {
  const offers = useRunOffers(worktreeId)
  const actions = useRunActions(worktreeId)
  if (offers.length === 0) return null
  return (
    <div className="run-buttons">
      {offers.map((offer) => {
        const label = RUN_LABEL[offer.kind]
        const running = offer.state === 'running'
        return (
          <div className="run-buttons__group" key={offer.kind}>
            <button
              type="button"
              className={`run-buttons__run${running ? ' run-buttons__run--running' : ''}`}
              data-tip={`${running ? 'Show' : 'Run'} ${label} · ${offer.command}`}
              aria-label={`${running ? 'Show' : 'Run'} ${label}`}
              onClick={() => actions.run(offer.kind, false)}
            >
              {running ? <span className="run-buttons__dot" aria-hidden="true" /> : <Icon name="play" size={14} />}
              {running ? label : `Run ${label}`}
            </button>
            {running ? (
              <>
                <button
                  type="button"
                  className="tabs__action"
                  data-tip={`Restart ${label}`}
                  aria-label={`Restart ${label}`}
                  onClick={() => actions.run(offer.kind, true)}
                >
                  <Icon name="restart" />
                </button>
                <button
                  type="button"
                  className="tabs__action"
                  data-tip={`Stop ${label}`}
                  aria-label={`Stop ${label}`}
                  onClick={() => actions.stop(offer.kind)}
                >
                  <Icon name="stop" />
                </button>
              </>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

export const TEST_CHIP: Partial<Record<RunState, string>> = { running: 'tests…', passed: '✓ tests', failed: '✗ tests' }

/** The row's word on its last test run, from the `test` pane's exit code; nothing once it is stopped or closed. */
export function RunChip({
  terminals,
  worktreeId
}: {
  terminals: readonly Terminal[]
  worktreeId: string
}): React.JSX.Element | null {
  const pane = runPaneOf(terminals, worktreeId, 'test')
  const state = pane === undefined ? undefined : runState(pane)
  const text = state === undefined ? undefined : TEST_CHIP[state]
  if (text === undefined || state === undefined) return null
  return (
    <span
      className={`chip worktree__run worktree__run--${state}`}
      data-tip={pane?.exitCode === undefined ? 'Tests running' : `Tests exited ${pane.exitCode}`}
    >
      {text}
    </span>
  )
}
