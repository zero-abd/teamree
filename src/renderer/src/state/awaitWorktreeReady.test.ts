import { describe, expect, it } from 'vitest'
import type { ClosedPane, Terminal, Worktree } from '@shared/entities'
import type { WorkspaceEvent } from '@shared/methods'
import { awaitSetup, awaitWorktreeReady, WorktreeNotReady, WorktreeReadyTimeout } from './awaitWorktreeReady'

const worktree = (state: Worktree['state'], error?: string): Worktree => ({
  id: 'wt_1',
  projectId: 'proj_1',
  name: 'rewrite the pager',
  branch: 'rewrite-the-pager',
  path: '/tmp/atlas/.worktrees/rewrite-the-pager',
  startedFrom: 'origin/main',
  state,
  createdAt: Date.now(),
  ...(error ? { error } : {})
})

/** A runtime that only moves when something tells it to, as the real one does. */
function fakeRuntime(initial: Worktree) {
  let current = initial
  let reads = 0
  const watchers = new Set<() => void>()
  return {
    get reads() {
      return reads
    },
    read: async (): Promise<Worktree> => {
      reads += 1
      return current
    },
    watch: (onChange: () => void) => {
      watchers.add(onChange)
      return {
        close: () => {
          watchers.delete(onChange)
        }
      }
    },
    get watcherCount() {
      return watchers.size
    },
    /** Stands in for the runtime finishing the job and announcing it. */
    settle: (next: Worktree): void => {
      current = next
      for (const watcher of [...watchers]) watcher()
    }
  }
}

describe('awaitWorktreeReady', () => {
  it('returns at once for a worktree that is already ready', async () => {
    const runtime = fakeRuntime(worktree('ready'))
    await expect(
      awaitWorktreeReady({ worktreeId: 'wt_1', read: runtime.read, watch: runtime.watch })
    ).resolves.toMatchObject({ state: 'ready' })
    expect(runtime.watcherCount).toBe(0)
  })

  it('resolves on the change stream, not on a timer', async () => {
    const runtime = fakeRuntime(worktree('creating'))
    const waiting = awaitWorktreeReady({ worktreeId: 'wt_1', read: runtime.read, watch: runtime.watch })
    // Nothing has changed yet, so nothing may resolve: a wait that came back
    // here would hand an agent a checkout that does not exist.
    expect(await Promise.race([waiting, Promise.resolve('still creating')])).toBe('still creating')

    runtime.settle(worktree('ready'))
    await expect(waiting).resolves.toMatchObject({ state: 'ready' })
    expect(runtime.watcherCount).toBe(0)
  })

  it('rejects with the reason creation failed', async () => {
    const runtime = fakeRuntime(worktree('creating'))
    const waiting = awaitWorktreeReady({ worktreeId: 'wt_1', read: runtime.read, watch: runtime.watch })
    runtime.settle(worktree('failed', "fatal: invalid reference 'origin/trunk'"))
    await expect(waiting).rejects.toThrow(WorktreeNotReady)
    await expect(waiting).rejects.toThrow("fatal: invalid reference 'origin/trunk'")
    expect(runtime.watcherCount).toBe(0)
  })

  it('ignores events that do not concern this worktree', async () => {
    const runtime = fakeRuntime(worktree('creating'))
    const waiting = awaitWorktreeReady({ worktreeId: 'wt_1', read: runtime.read, watch: runtime.watch })
    runtime.settle(worktree('creating'))
    runtime.settle(worktree('creating'))
    runtime.settle(worktree('ready'))
    await expect(waiting).resolves.toMatchObject({ state: 'ready' })
  })

  // The one race that would hang the composer forever: a worktree settles while
  // a read that started too early is still travelling. Nothing more is announced
  // afterwards, so that stale answer must not be the last word.
  it('re-reads when the worktree settles mid-read', async () => {
    let current = worktree('creating')
    const answering: Array<() => void> = []
    const watchers = new Set<() => void>()

    const read = (): Promise<Worktree> =>
      new Promise((resolve) => {
        // Captured at call time, as a real request's answer would be.
        const captured = current
        answering.push(() => resolve(captured))
      })

    const answerOne = async (): Promise<void> => {
      answering.shift()?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    const waiting = awaitWorktreeReady({
      worktreeId: 'wt_1',
      read,
      watch: (onChange) => {
        watchers.add(onChange)
        return {
          close: () => {
            watchers.delete(onChange)
          }
        }
      }
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    await answerOne()

    current = worktree('ready')
    for (const watcher of [...watchers]) watcher()
    // Answers the read that was already in flight, which still says "creating".
    await answerOne()
    await answerOne()

    await expect(waiting).resolves.toMatchObject({ state: 'ready' })
    expect(watchers.size).toBe(0)
  })

  it('gives up rather than leaving a subscription alive for the session', async () => {
    const runtime = fakeRuntime(worktree('creating'))
    const waiting = awaitWorktreeReady({
      worktreeId: 'wt_1',
      read: runtime.read,
      watch: runtime.watch,
      timeoutMs: 5
    })
    await expect(waiting).rejects.toThrow(WorktreeReadyTimeout)
    expect(runtime.watcherCount).toBe(0)
  })
})

const pane = (id: string, fields: Partial<Terminal> = {}): Terminal =>
  ({ id, worktreeId: 'wt_1', running: true, run: 'setup', label: 'setup', ...fields }) as Terminal

/** A ready worktree whose setup pane moves only when told to, announcing each move as the runtime does. */
function setupRuntime(initial: Worktree, panes: Terminal[]) {
  let current = initial
  let listed = panes
  let closed: ClosedPane[] = []
  const watchers = new Set<(event: WorkspaceEvent) => void>()
  const emit = (event: WorkspaceEvent): void => {
    for (const watcher of [...watchers]) watcher(event)
  }
  const closeWith = (terminalId: string, exitCode: number): void => {
    listed = listed.filter((one) => one.id !== terminalId)
    closed = [{ terminalId, worktreeId: 'wt_1', resumable: false, closedAt: 1, exitCode }, ...closed]
  }
  return {
    options: {
      worktreeId: 'wt_1',
      read: async () => current,
      panes: async () => listed,
      closed: async () => closed,
      watch: (onEvent: (event: WorkspaceEvent) => void) => {
        watchers.add(onEvent)
        return { close: () => void watchers.delete(onEvent) }
      }
    },
    get watcherCount() {
      return watchers.size
    },
    /** The pane's command ended: `terminalExited`, then the list without it when it passed and closed. */
    exit: (terminalId: string, exitCode: number, closes = exitCode === 0): void => {
      if (closes) closeWith(terminalId, exitCode)
      else listed = listed.map((one) => (one.id === terminalId ? { ...one, running: false, exitCode } : one))
      emit({ type: 'terminalExited', terminalId, exitCode })
      emit({ type: 'terminals' })
    },
    /** Closed with this exit on its record, announced only as `terminals`: the exit event is still coalescing. */
    closeQuietly: (terminalId: string, exitCode: number): void => {
      closeWith(terminalId, exitCode)
      emit({ type: 'terminals' })
    },
    setPanes: (next: Terminal[]): void => {
      listed = next
      emit({ type: 'terminals' })
    },
    setWorktree: (next: Worktree): void => {
      current = next
      emit({ type: 'worktrees' })
    }
  }
}

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function stillWaiting(waiting: Promise<unknown>): Promise<boolean> {
  await settled()
  return (await Promise.race([waiting, Promise.resolve('waiting')])) === 'waiting'
}

describe('awaitSetup', () => {
  const withSetup: Worktree = { ...worktree('ready'), setupTerminalId: 't_setup' }

  it('lets the agent go at once where the project runs no setup', async () => {
    const runtime = setupRuntime(worktree('ready'), [])
    await expect(awaitSetup(runtime.options)).resolves.toBe('passed')
    expect(runtime.watcherCount).toBe(0)
  })

  it('holds the agent until the setup command exits 0', async () => {
    const runtime = setupRuntime(withSetup, [pane('t_setup')])
    const waiting = awaitSetup(runtime.options)
    expect(await stillWaiting(waiting)).toBe(true)

    runtime.exit('t_other', 0)
    runtime.setPanes([pane('t_setup'), pane('t_other', { run: undefined, running: false, exitCode: 0 })])
    expect(await stillWaiting(waiting)).toBe(true)

    runtime.exit('t_setup', 0)
    await expect(waiting).resolves.toBe('passed')
    expect(runtime.watcherCount).toBe(0)
  })

  it('reports a failed setup, which starts no agent', async () => {
    const runtime = setupRuntime(withSetup, [pane('t_setup')])
    const waiting = awaitSetup(runtime.options)
    runtime.exit('t_setup', 127)
    await expect(waiting).resolves.toBe('failed')
    expect(runtime.watcherCount).toBe(0)
  })

  it('reads a setup pane already ended or gone on the first look', async () => {
    await expect(awaitSetup(setupRuntime(withSetup, []).options)).resolves.toBe('passed')
    const failed = setupRuntime(withSetup, [pane('t_setup', { running: false, exitCode: 1 })])
    await expect(awaitSetup(failed.options)).resolves.toBe('failed')
  })

  it('waits on the question a repository command asks, then on the setup Run starts', async () => {
    const runtime = setupRuntime({ ...worktree('ready'), setupAsk: 'npm ci' }, [])
    const waiting = awaitSetup(runtime.options)
    expect(await stillWaiting(waiting)).toBe(true)

    runtime.setPanes([pane('t_setup')])
    runtime.setWorktree(withSetup)
    expect(await stillWaiting(waiting)).toBe(true)

    runtime.exit('t_setup', 0)
    await expect(waiting).resolves.toBe('passed')
  })

  it('after a failure, settles only on a pass or on the pane being closed', async () => {
    const runtime = setupRuntime(withSetup, [pane('t_setup', { running: false, exitCode: 1 })])
    const again = awaitSetup({ ...runtime.options, failed: true })
    expect(await stillWaiting(again)).toBe(true)

    // Run Again, and it fails again: still held.
    runtime.setPanes([pane('t_setup')])
    runtime.exit('t_setup', 1)
    expect(await stillWaiting(again)).toBe(true)

    runtime.setPanes([pane('t_setup')])
    runtime.exit('t_setup', 0)
    await expect(again).resolves.toBe('passed')

    const closed = setupRuntime(withSetup, [pane('t_setup', { running: false, exitCode: 1 })])
    const given = awaitSetup({ ...closed.options, failed: true })
    closed.closeQuietly('t_setup', 1)
    await expect(given).resolves.toBe('closed')
    expect(closed.watcherCount).toBe(0)
  })

  // The exit event waits out the stream's coalescing window; a read in that window finds the pane already closed.
  it('after a failure, reads a pass whose exit event has not arrived from the closed pane’s record', async () => {
    const runtime = setupRuntime(withSetup, [pane('t_setup', { running: false, exitCode: 1 })])
    const again = awaitSetup({ ...runtime.options, failed: true })
    runtime.setPanes([pane('t_setup')])
    expect(await stillWaiting(again)).toBe(true)

    runtime.closeQuietly('t_setup', 0)
    await expect(again).resolves.toBe('passed')
  })

  it('reads a setup still running at the deadline as failed, so its agent is held rather than started', async () => {
    const runtime = setupRuntime(withSetup, [pane('t_setup')])
    await expect(awaitSetup({ ...runtime.options, timeoutMs: 5 })).resolves.toBe('failed')
    expect(runtime.watcherCount).toBe(0)
  })
})
