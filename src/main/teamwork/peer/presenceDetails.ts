// Presence v2's git half: the paths a worktree changed against its base and the commits it is ahead.
// Read in the background and kept, so building a snapshot never waits on git. Paths only, never contents.

import { existsSync } from 'node:fs'
import type { Project, Worktree, WorktreeChange } from '../../../shared/entities'
import { effectiveProjectSettings } from '../../../shared/projectSettings'
import { MAX_PEER_PATHS } from '../../../shared/presenceExtras'
import type { GitRunner } from '../../git/gitProcess'
import { comparesAgainstItself } from '../../git/repository'
import { parseChangeRecords, UNTRACKED_LISTED_LIMIT, withoutPreparedPaths } from '../../git/worktreeChanges'
import type { PreparedPaths } from '../../git/worktreePreparation'

export type TaskGitDetails = {
  /** Repo-relative, uncommitted first, at most `MAX_PEER_PATHS`. */
  paths: string[]
  ahead: number
  /** Nothing uncommitted. */
  clean: boolean
}

export type TaskGitReadOptions = {
  worktreePath: string
  baseRef: string
  /** What the project carries into every worktree, and so is not a change. */
  prepared?: PreparedPaths
}

export async function readTaskGitDetails(runner: GitRunner, options: TaskGitReadOptions): Promise<TaskGitDetails> {
  const cwd = options.worktreePath
  // Listed as the Changes tab lists them: new files one by one, a crowd of them folded into its folder.
  const read = async (untracked: 'all' | 'normal'): Promise<WorktreeChange[]> => {
    const { stdout } = await runner.run({
      args: ['status', '--porcelain=v2', '-z', `--untracked-files=${untracked}`],
      cwd,
      readOnly: true,
      timeoutMs: 30_000
    })
    return withoutPreparedPaths(parseChangeRecords(stdout), options.prepared)
  }
  let changes = await read('all')
  if (changes.filter((change) => change.kind === 'untracked').length > UNTRACKED_LISTED_LIMIT) {
    changes = await read('normal')
  }
  const uncommitted = changes.map((change) => change.path)

  let ahead = 0
  let committed: string[] = []
  if (usableRef(options.baseRef)) {
    const counted = await runner.tryRun({
      args: ['rev-list', '--count', `${options.baseRef}..HEAD`],
      cwd,
      readOnly: true,
      timeoutMs: 30_000
    })
    ahead = counted.exitCode === 0 ? Number.parseInt(counted.stdout.trim(), 10) || 0 : 0
    if (ahead > 0) {
      const diff = await runner.tryRun({
        args: ['diff', '--name-only', '-z', '--no-renames', `${options.baseRef}...HEAD`, '--'],
        cwd,
        readOnly: true,
        timeoutMs: 30_000
      })
      if (diff.exitCode === 0) committed = diff.stdout.split('\0').filter((path) => path.length > 0)
    }
  }

  return {
    paths: [...new Set([...uncommitted, ...committed])].slice(0, MAX_PEER_PATHS),
    ahead,
    clean: uncommitted.length === 0
  }
}

function usableRef(ref: string): boolean {
  return ref !== '' && !ref.startsWith('-') && !ref.includes('..') && !/\s/.test(ref) && !comparesAgainstItself(ref)
}

/** The reader the runtime hands the peer service: the worktree's own base, else its project's. */
export function taskGitReader(
  runner: GitRunner,
  projectOf: (projectId: string) => Project | undefined
): (worktree: Worktree) => Promise<TaskGitDetails | undefined> {
  return async (worktree) => {
    const project = projectOf(worktree.projectId)
    if (project === undefined || worktree.state !== 'ready' || !existsSync(worktree.path)) return undefined
    return readTaskGitDetails(runner, {
      worktreePath: worktree.path,
      baseRef: worktree.baseRef ?? project.baseRef,
      prepared: effectiveProjectSettings(project)
    })
  }
}

/** How long a burst of workspace changes is gathered before git is asked again. */
export const TASK_DETAILS_REFRESH_MS = 1_000

export type TaskDetailsOptions = {
  read: (worktree: Worktree) => Promise<TaskGitDetails | undefined>
  setTimer: (run: () => void, delayMs: number) => () => void
  /** Something a teammate would see has moved. */
  onChange: () => void
}

/** The latest git details per worktree, re-read at most once per burst and never two reads at once. */
export class TaskDetails {
  readonly #options: TaskDetailsOptions
  readonly #known = new Map<string, TaskGitDetails>()
  #worktrees: () => readonly Worktree[] = () => []
  #scheduled = false
  #running = false
  #again = false

  constructor(options: TaskDetailsOptions) {
    this.#options = options
  }

  get(worktreeId: string): TaskGitDetails | undefined {
    return this.#known.get(worktreeId)
  }

  /** `worktrees` is asked when the read starts, so it lists what exists then. */
  request(worktrees: () => readonly Worktree[]): void {
    this.#worktrees = worktrees
    if (this.#running) {
      this.#again = true
      return
    }
    if (this.#scheduled) return
    this.#scheduled = true
    this.#options.setTimer(() => {
      this.#scheduled = false
      void this.#run()
    }, TASK_DETAILS_REFRESH_MS)
  }

  async #run(): Promise<void> {
    this.#running = true
    let changed = false
    try {
      const worktrees = this.#worktrees()
      const listed = new Set(worktrees.map((worktree) => worktree.id))
      for (const id of [...this.#known.keys()]) if (!listed.has(id)) this.#known.delete(id)
      for (const worktree of worktrees) {
        // A checkout git cannot read has no details, rather than the last ones it had.
        const next = await this.#options.read(worktree).catch(() => undefined)
        const previous = this.#known.get(worktree.id)
        if (JSON.stringify(previous) === JSON.stringify(next)) continue
        if (next === undefined) this.#known.delete(worktree.id)
        else this.#known.set(worktree.id, next)
        changed = true
      }
    } finally {
      this.#running = false
    }
    if (changed) this.#options.onChange()
    if (this.#again) {
      this.#again = false
      this.request(this.#worktrees)
    }
  }
}
