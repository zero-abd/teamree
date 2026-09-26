// Which command a Run button starts, and what its pane says about the run. This Mac's command wins,
// then `.teamree/project.json`'s (asked about once per exact string), then the detected one.

import type { Project, RunKind, Terminal } from './entities'

export const RUN_KINDS: readonly RunKind[] = ['dev', 'test']

/** What the pane of each kind is called, and what its buttons say. */
export const RUN_LABEL: Record<RunKind, string> = { dev: 'Dev', test: 'Tests' }

export type RunCommand = {
  command: string
  source: 'local' | 'repository' | 'detected'
  /** False for a repository command this Mac has not run yet: the first press asks. */
  approved: boolean
}

export function runCommandOf(project: Project, kind: RunKind): RunCommand | undefined {
  const local = project.runCommands?.[kind]
  if (local) return { command: local, source: 'local', approved: true }
  const shared = project.repository?.runCommands?.[kind]
  if (shared) return { command: shared, source: 'repository', approved: project.approvedRunCommands?.[kind] === shared }
  const detected = project.detectedRun?.[kind]
  return detected ? { command: detected, source: 'detected', approved: true } : undefined
}

/** The worktree's pane of this kind; the newest when a restart raced another window. */
export function runPaneOf(terminals: readonly Terminal[], worktreeId: string, kind: RunKind): Terminal | undefined {
  return terminals.filter((terminal) => terminal.worktreeId === worktreeId && terminal.run === kind).at(-1)
}

export type RunState = 'running' | 'passed' | 'failed' | 'stopped'

// SIGHUP, SIGINT and SIGTERM as a shell reports them: Stop, not a failure.
const STOPPED_CODES: ReadonlySet<number> = new Set([129, 130, 143])

/** What a run pane's process says: still going, or how it ended. */
export function runState(pane: Pick<Terminal, 'running' | 'exitCode'>): RunState {
  if (pane.running) return 'running'
  if (pane.exitCode === 0) return 'passed'
  return pane.exitCode !== undefined && STOPPED_CODES.has(pane.exitCode) ? 'stopped' : 'failed'
}
