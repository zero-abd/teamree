// Run Dev and Run Tests: a button per command the project has, in the strip, the row menu and the
// palette. While its pane runs the button shows that pane, beside Restart and Stop.

import type { Project, RunKind, Terminal } from '@shared/entities'
import { RUN_KINDS, RUN_LABEL, runCommandOf, runPaneOf, runState, type RunState } from '@shared/runCommands'
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
      return [{ label: `Run ${label}`, hint: offer.command, onChoose: () => actions.run(offer.kind, false) }]
    }
    return [
      { label: `Show ${label}`, onChoose: () => actions.run(offer.kind, false) },
      { label: `Restart ${label}`, onChoose: () => actions.run(offer.kind, true) },
      { label: `Stop ${label}`, onChoose: () => actions.stop(offer.kind) }
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
              title={`${running ? 'Show' : 'Run'} ${label} · ${offer.command}`}
              aria-label={`${running ? 'Show' : 'Run'} ${label}`}
              onClick={() => actions.run(offer.kind, false)}
            >
              {running ? <span className="run-buttons__dot" aria-hidden="true" /> : <PlayGlyph />}
              {label}
            </button>
            {running ? (
              <>
                <button
                  type="button"
                  className="tabs__action"
                  title={`Restart ${label}`}
                  aria-label={`Restart ${label}`}
                  onClick={() => actions.run(offer.kind, true)}
                >
                  <svg viewBox="0 0 12 12" aria-hidden="true">
                    <path d="M9.8 6 A3.8 3.8 0 1 1 8.7 3.3 M9 1.4 V3.6 H6.8" />
                  </svg>
                </button>
                <button
                  type="button"
                  className="tabs__action"
                  title={`Stop ${label}`}
                  aria-label={`Stop ${label}`}
                  onClick={() => actions.stop(offer.kind)}
                >
                  <svg viewBox="0 0 12 12" aria-hidden="true">
                    <path d="M3 3 H9 V9 H3 Z" />
                  </svg>
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
      title={pane?.exitCode === undefined ? 'Tests running' : `Tests exited ${pane.exitCode}`}
    >
      {text}
    </span>
  )
}

function PlayGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3.5 2.2 L9.5 6 L3.5 9.8 Z" />
    </svg>
  )
}
