import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Layout, Terminal } from '../../shared/entities'
import { ErrorCode } from '../../shared/protocol'
import type { TerminalEvent } from '../../shared/methods'
import { createTerminalService, registerTerminalHandlers } from './method-handlers'
import type { MethodRegistry, StreamChannel, TerminalService } from './method-handlers'
import { isProcessAlive } from './process-tree'
import { canSpawnPty, printThenExit, waitUntil, writeFakeAgent, writeProcessTreeProbe } from './pty-test-support'
import type { TerminalRecord } from './session-restore'
import { isTerminalServiceError } from './service-error'

// Driven through the handler surface the runtime will call, over real PTYs, so
// the seam itself is under test and not just the classes behind it.
const describePty = canSpawnPty() ? describe : describe.skip
const TEST_TIMEOUT_MS = 20_000

const WORKTREE = 'wt_alpha'
const services: TerminalService[] = []
const scratchDirs: string[] = []
const published: Array<{ subscription: string; event: TerminalEvent }> = []

function newService(): TerminalService {
  const service = createTerminalService({
    publish: (subscription, event) => published.push({ subscription, event }),
    resolveWorktreeCwd: (worktreeId) => (worktreeId === WORKTREE ? process.cwd() : undefined)
  })
  services.push(service)
  return service
}

/**
 * A pane on this platform's own shell. With no command that is an interactive
 * shell, which is what every test here that is not about a command wants: it
 * stays open, and the pty echoes what is typed into it, on Windows as on unix.
 */
function newTerminal(service: TerminalService, command?: string): Promise<Terminal> {
  return service.handlers['terminal.create']({
    worktreeId: WORKTREE,
    ...(command === undefined ? {} : { command })
  })
}

afterEach(async () => {
  published.length = 0
  await Promise.all(services.splice(0).map((service) => service.shutdown()))
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describePty('terminal handlers', () => {
  it(
    'creates a terminal and gives it the whole layout',
    async () => {
      const service = newService()
      const terminal = await newTerminal(service)

      expect(terminal).toMatchObject({ worktreeId: WORKTREE, cwd: process.cwd(), running: true })
      expect(await service.handlers['terminal.list']({})).toHaveLength(1)

      const layout = await service.handlers['layout.get']({ worktreeId: WORKTREE })
      expect(layout).toEqual({
        worktreeId: WORKTREE,
        root: { kind: 'leaf', terminalId: terminal.id },
        focusedTerminalId: terminal.id
      })
    },
    TEST_TIMEOUT_MS
  )

  it(
    'scopes the list to one worktree',
    async () => {
      const service = newService()
      const mine = await newTerminal(service)
      await service.handlers['terminal.create']({ worktreeId: 'wt_other', cwd: process.cwd() })

      const scoped = await service.handlers['terminal.list']({ worktreeId: WORKTREE })
      expect(scoped.map((terminal) => terminal.id)).toEqual([mine.id])
      expect(await service.handlers['terminal.list']({})).toHaveLength(2)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'writes to a terminal and reads it back',
    async () => {
      const service = newService()
      const terminal = await newTerminal(service)

      expect(await service.handlers['terminal.write']({ terminalId: terminal.id, data: 'round-trip\n' })).toEqual({
        written: true
      })
      await waitUntil(async () => {
        const { data } = await service.handlers['terminal.read']({ terminalId: terminal.id })
        return data.includes('round-trip')
      }, 'the written text to come back')

      const tail = await service.handlers['terminal.read']({ terminalId: terminal.id, tailBytes: 4 })
      expect(Buffer.byteLength(tail.data, 'utf8')).toBeLessThanOrEqual(4)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'resizes and reports the new size',
    async () => {
      const service = newService()
      const terminal = await newTerminal(service)

      const resized = await service.handlers['terminal.resize']({ terminalId: terminal.id, cols: 132, rows: 43 })
      expect(resized).toMatchObject({ id: terminal.id, cols: 132, rows: 43 })
    },
    TEST_TIMEOUT_MS
  )

  it(
    'splits a pane and puts the new terminal beside it',
    async () => {
      const service = newService()
      const first = await newTerminal(service)
      const { terminal: second, layout } = await service.handlers['terminal.split']({
        terminalId: first.id,
        direction: 'row'
      })

      expect(second.worktreeId).toBe(WORKTREE)
      expect(second.cwd).toBe(first.cwd)
      expect(layout.root).toEqual({
        kind: 'split',
        direction: 'row',
        sizes: [0.5, 0.5],
        children: [
          { kind: 'leaf', terminalId: first.id },
          { kind: 'leaf', terminalId: second.id }
        ]
      })
      expect(layout.focusedTerminalId).toBe(second.id)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'collapses the layout when a split pane is closed',
    async () => {
      const service = newService()
      const first = await newTerminal(service)
      const { terminal: second } = await service.handlers['terminal.split']({
        terminalId: first.id,
        direction: 'column'
      })

      expect(await service.handlers['terminal.close']({ terminalId: second.id })).toEqual({ closed: true })

      const layout = await service.handlers['layout.get']({ worktreeId: WORKTREE })
      expect(layout.root).toEqual({ kind: 'leaf', terminalId: first.id })
      expect(layout.focusedTerminalId).toBe(first.id)
      expect(await service.handlers['terminal.list']({ worktreeId: WORKTREE })).toHaveLength(1)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'empties the layout when the last pane is closed',
    async () => {
      const service = newService()
      const terminal = await newTerminal(service)
      await service.handlers['terminal.close']({ terminalId: terminal.id })

      expect(await service.handlers['layout.get']({ worktreeId: WORKTREE })).toEqual({
        worktreeId: WORKTREE,
        root: null,
        focusedTerminalId: null
      })
      expect(await service.handlers['terminal.list']({})).toEqual([])
    },
    TEST_TIMEOUT_MS
  )

  it(
    'streams data and exit to a subscriber, and stops on unsubscribe',
    async () => {
      const service = newService()
      const terminal = await newTerminal(service, printThenExit('streamed', 3))
      const { subscription } = await service.handlers['terminal.subscribe']({ terminalId: terminal.id })

      await waitUntil(
        () => published.some(({ event }) => event.type === 'exit'),
        'the exit event to reach the subscriber'
      )
      expect(published.every((entry) => entry.subscription === subscription)).toBe(true)
      const data = published
        .filter((entry) => entry.event.type === 'data')
        .map((entry) => (entry.event.type === 'data' ? entry.event.data : ''))
        .join('')
      expect(data).toContain('streamed')
      expect(published.at(-1)?.event).toEqual({ type: 'exit', exitCode: 3 })

      expect(service.unsubscribe(subscription)).toBe(true)
      expect(service.unsubscribe(subscription)).toBe(false)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'hands a subscription to the connection hub when one is configured',
    async () => {
      // Mirrors SubscriptionHub: it owns the id and the teardown, and the source
      // it starts is this service's stream.
      const emitted: TerminalEvent[] = []
      let teardown = (): void => {}
      let closedByProducer = false
      const hub = {
        subscribe(connectionId: string, source: (channel: StreamChannel) => () => void): string {
          expect(connectionId).toBe('conn-1')
          teardown = source({
            emit: (event) => emitted.push(event),
            close: () => {
              closedByProducer = true
              teardown()
            }
          })
          return 'hub_sub_1'
        }
      }

      const service = createTerminalService({
        subscriptions: hub,
        resolveWorktreeCwd: () => process.cwd()
      })
      services.push(service)

      const terminal = await service.handlers['terminal.create']({ worktreeId: WORKTREE })
      const result = await service.handlers['terminal.subscribe'](
        { terminalId: terminal.id },
        { connectionId: 'conn-1' }
      )
      expect(result).toEqual({ subscription: 'hub_sub_1' })

      await service.handlers['terminal.write']({ terminalId: terminal.id, data: 'hubbub\n' })
      await waitUntil(
        () => emitted.some((event) => event.type === 'data' && event.data.includes('hubbub')),
        'the hub to receive data'
      )

      // Closing the terminal has to end the stream from the producer side.
      await service.handlers['terminal.close']({ terminalId: terminal.id })
      expect(closedByProducer).toBe(true)
      expect(published).toHaveLength(0)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'drops subscriptions when their terminal closes',
    async () => {
      const service = newService()
      const terminal = await newTerminal(service)
      const { subscription } = await service.handlers['terminal.subscribe']({ terminalId: terminal.id })

      await service.handlers['terminal.close']({ terminalId: terminal.id })
      expect(service.unsubscribe(subscription)).toBe(false)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'reports a not_found for a terminal that is gone',
    async () => {
      const service = newService()
      const terminal = await newTerminal(service)
      await service.handlers['terminal.close']({ terminalId: terminal.id })

      const failure = await service.handlers['terminal.read']({ terminalId: terminal.id }).catch(
        (error: unknown) => error
      )
      expect(isTerminalServiceError(failure)).toBe(true)
      expect(isTerminalServiceError(failure) ? failure.code : undefined).toBe(ErrorCode.NotFound)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'refuses to create a terminal with no resolvable cwd',
    async () => {
      const service = newService()
      const failure = await service.handlers['terminal.create']({ worktreeId: 'wt_unknown' }).catch(
        (error: unknown) => error
      )
      expect(isTerminalServiceError(failure) ? failure.code : undefined).toBe(ErrorCode.InvalidParams)

      const missingCwd = await service.handlers['terminal.create']({
        worktreeId: WORKTREE,
        cwd: '/definitely/not/a/directory'
      }).catch((error: unknown) => error)
      expect(isTerminalServiceError(missingCwd) ? missingCwd.code : undefined).toBe(ErrorCode.NotFound)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'kills every process tree on shutdown',
    async () => {
      const service = newService()
      const scratch = await mkdtemp(path.join(os.tmpdir(), 'teamree-process-tree-'))
      scratchDirs.push(scratch)
      const terminal = await newTerminal(service, await writeProcessTreeProbe(scratch))
      const { subscription } = await service.handlers['terminal.subscribe']({ terminalId: terminal.id })
      expect(subscription).toMatch(/^sub_/)

      let grandchild = 0
      await waitUntil(() => {
        const text = published.map((entry) => (entry.event.type === 'data' ? entry.event.data : '')).join('')
        grandchild = Number(/child:(\d+)/.exec(text)?.[1] ?? 0)
        return grandchild > 0
      }, 'the grandchild pid')
      expect(isProcessAlive(grandchild)).toBe(true)

      await service.shutdown()

      await waitUntil(() => !isProcessAlive(grandchild), 'the grandchild to be reaped')
      expect(await service.handlers['terminal.list']({})).toEqual([])
    },
    TEST_TIMEOUT_MS
  )
})

/**
 * The pane a person comes back to and finds dead — an agent that crashed, hit a
 * rate limit, was quit, or came back to resume a conversation that was not
 * there. What they do next never varies: that program, in that directory,
 * again. These are about doing it without the pane moving.
 */
describePty('running an exited pane again', () => {
  /** A service whose records are readable, which is where a session id lives. */
  function serviceWithRecords(): { service: TerminalService; records: Map<string, TerminalRecord> } {
    const records = new Map<string, TerminalRecord>()
    const service = createTerminalService({
      publish: (subscription, event) => published.push({ subscription, event }),
      resolveWorktreeCwd: (worktreeId) => (worktreeId === WORKTREE ? process.cwd() : undefined),
      sessions: {
        listTerminals: () => [...records.values()],
        putTerminal: (record) => {
          records.set(record.id, record)
          return record
        },
        removeTerminal: (terminalId) => records.delete(terminalId)
      }
    })
    services.push(service)
    return { service, records }
  }

  async function scratchDir(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'teamree-relaunch-'))
    scratchDirs.push(directory)
    return directory
  }

  const hasExited = async (service: TerminalService, terminalId: string): Promise<boolean> => {
    const list = await service.handlers['terminal.list']({})
    return list.some((terminal) => terminal.id === terminalId && !terminal.running)
  }

  it(
    'refuses a pane that has not exited, and says why',
    async () => {
      const service = newService()
      const terminal = await newTerminal(service)

      const failure = await service.handlers['terminal.relaunch']({ terminalId: terminal.id }).catch(
        (error: unknown) => error
      )
      expect(isTerminalServiceError(failure) ? failure.code : undefined).toBe(ErrorCode.Conflict)
      expect(isTerminalServiceError(failure) ? failure.message : '').toContain('has not exited')
    },
    TEST_TIMEOUT_MS
  )

  it(
    'starts the same agent over, in the same pane, under a session id of its own',
    async () => {
      const { service, records } = serviceWithRecords()
      const command = await writeFakeAgent(await scratchDir())
      const terminal = await service.handlers['terminal.create']({ worktreeId: WORKTREE, command })
      expect(terminal.agent).toBe('claude')

      await waitUntil(() => hasExited(service, terminal.id), 'the agent pane to exit')
      const first = records.get(terminal.id)?.agentSessionId
      expect(first).toBeDefined()
      const before = await service.handlers['terminal.read']({ terminalId: terminal.id })
      expect(before.data).toContain(first)

      const again = await service.handlers['terminal.relaunch']({ terminalId: terminal.id })

      // The same pane: a different id here would be a different leaf, and the
      // layout would have to move to hold it.
      expect(again.id).toBe(terminal.id)
      expect(again.cwd).toBe(terminal.cwd)
      expect(again.agent).toBe('claude')
      expect(again.running).toBe(true)
      // Not the conversation that ended. Starting over is the whole claim.
      const second = records.get(terminal.id)?.agentSessionId
      expect(second).toBeDefined()
      expect(second).not.toBe(first)
      expect(records.get(terminal.id)?.typed).toBe(false)

      await waitUntil(async () => {
        const { data } = await service.handlers['terminal.read']({ terminalId: terminal.id })
        return data.includes(second as string)
      }, 'the second run to say which session it was given')

      // And what the dead pane printed is still there, above the line that says
      // where this run starts, rather than replaced by it.
      const after = (await service.handlers['terminal.read']({ terminalId: terminal.id })).data
      const banner = after.indexOf('claude starts again below')
      expect(banner).toBeGreaterThan(-1)
      expect(after.indexOf(first as string)).toBeLessThan(banner)
      expect(after.indexOf(second as string)).toBeGreaterThan(banner)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'brings a pane that was not running an agent back as a shell, not as its command again',
    async () => {
      const { service, records } = serviceWithRecords()
      const terminal = await newTerminal(service, printThenExit('one-shot', 4))
      await waitUntil(() => hasExited(service, terminal.id), 'the command pane to exit')

      const again = await service.handlers['terminal.relaunch']({ terminalId: terminal.id })
      expect(again.id).toBe(terminal.id)
      expect(again.agent).toBeUndefined()
      // Re-running whatever a pane was left holding is the thing `restoreLaunch`
      // refuses to do at startup, for the same reason: nobody asked for it twice.
      expect(records.get(terminal.id)?.command).toBeUndefined()

      const after = (await service.handlers['terminal.read']({ terminalId: terminal.id })).data
      expect(after).toContain('a new shell starts below')
      expect(after.indexOf('one-shot')).toBeLessThan(after.indexOf('a new shell starts below'))
    },
    TEST_TIMEOUT_MS
  )

  it(
    'leaves the split tree exactly where it was',
    async () => {
      const { service } = serviceWithRecords()
      const command = await writeFakeAgent(await scratchDir())
      const first = await service.handlers['terminal.create']({ worktreeId: WORKTREE })
      const { terminal: second } = await service.handlers['terminal.split']({
        terminalId: first.id,
        direction: 'row',
        command
      })

      await waitUntil(() => hasExited(service, second.id), 'the split pane to exit')
      const before = await service.handlers['layout.get']({ worktreeId: WORKTREE })

      await service.handlers['terminal.relaunch']({ terminalId: second.id })

      expect(await service.handlers['layout.get']({ worktreeId: WORKTREE })).toEqual(before)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'keeps a subscription open across the relaunch, and says in it where the new run starts',
    async () => {
      const { service } = serviceWithRecords()
      const command = await writeFakeAgent(await scratchDir())
      const terminal = await service.handlers['terminal.create']({ worktreeId: WORKTREE, command })
      await service.handlers['terminal.subscribe']({ terminalId: terminal.id })
      await waitUntil(() => hasExited(service, terminal.id), 'the agent pane to exit')

      published.length = 0
      await service.handlers['terminal.relaunch']({ terminalId: terminal.id })

      // A subscription is to the pane, not to the process: a window that was
      // open when the pane died must not be left watching something that can
      // never speak again.
      await waitUntil(
        () =>
          published.some(({ event }) => event.type === 'data' && event.data.includes('claude starts again below')) &&
          published.some(({ event }) => event.type === 'data' && event.data.includes('agent args:')),
        'the banner and the second run to reach the subscriber'
      )
    },
    TEST_TIMEOUT_MS
  )
})

describe('layout handlers', () => {
  it('stores a tree wholesale and normalises its sizes', async () => {
    const service = createTerminalService()
    const stored = await service.handlers['layout.set']({
      worktreeId: WORKTREE,
      root: {
        kind: 'split',
        direction: 'row',
        sizes: [3, 1],
        children: [
          { kind: 'leaf', terminalId: 'a' },
          { kind: 'leaf', terminalId: 'b' }
        ]
      },
      focusedTerminalId: 'b'
    })

    expect(stored.root).toEqual({
      kind: 'split',
      direction: 'row',
      sizes: [0.75, 0.25],
      children: [
        { kind: 'leaf', terminalId: 'a' },
        { kind: 'leaf', terminalId: 'b' }
      ]
    })
    expect(stored.focusedTerminalId).toBe('b')
    expect(await service.handlers['layout.get']({ worktreeId: WORKTREE })).toEqual(stored)
  })

  it('clears focus that names a pane the tree does not have', async () => {
    const service = createTerminalService()
    const stored = await service.handlers['layout.set']({
      worktreeId: WORKTREE,
      root: { kind: 'leaf', terminalId: 'a' },
      focusedTerminalId: 'ghost'
    })
    expect(stored.focusedTerminalId).toBeNull()
  })

  it('accepts an empty layout', async () => {
    const service = createTerminalService()
    expect(await service.handlers['layout.set']({ worktreeId: WORKTREE, root: null, focusedTerminalId: null })).toEqual(
      {
        worktreeId: WORKTREE,
        root: null,
        focusedTerminalId: null
      }
    )
  })

  it('rejects a tree that is not a tree', async () => {
    const service = createTerminalService()
    const failure = await service.handlers['layout.set']({
      worktreeId: WORKTREE,
      root: { kind: 'leaf' },
      focusedTerminalId: null
    }).catch((error: unknown) => error)
    expect(isTerminalServiceError(failure) ? failure.code : undefined).toBe(ErrorCode.InvalidParams)
  })

  it('hands the stored tree out as a copy', async () => {
    const service = createTerminalService()
    const first = await service.handlers['layout.get']({ worktreeId: WORKTREE })
    await service.handlers['layout.set']({
      worktreeId: WORKTREE,
      root: { kind: 'leaf', terminalId: 'a' },
      focusedTerminalId: 'a'
    })
    expect(first.root).toBeNull()

    const stored = await service.handlers['layout.get']({ worktreeId: WORKTREE })
    if (stored.root?.kind === 'leaf') stored.root.terminalId = 'tampered'
    expect(await service.handlers['layout.get']({ worktreeId: WORKTREE })).toEqual({
      worktreeId: WORKTREE,
      root: { kind: 'leaf', terminalId: 'a' },
      focusedTerminalId: 'a'
    })
  })
})

describe('layout persistence', () => {
  it('reads and writes through an external repository', async () => {
    // The workspace store already has this shape, which is how a layout outlives
    // the process that made it.
    const saved = new Map<string, Layout>()
    const service = createTerminalService({
      layouts: {
        getLayout: (worktreeId) => saved.get(worktreeId),
        putLayout: (layout) => {
          saved.set(layout.worktreeId, layout)
          return layout
        }
      }
    })

    await service.handlers['layout.set']({
      worktreeId: WORKTREE,
      root: { kind: 'leaf', terminalId: 'a' },
      focusedTerminalId: 'a'
    })
    expect(saved.get(WORKTREE)).toEqual({
      worktreeId: WORKTREE,
      root: { kind: 'leaf', terminalId: 'a' },
      focusedTerminalId: 'a'
    })

    // A layout that was already there is what a fresh service starts from.
    const restored = createTerminalService({
      layouts: { getLayout: (id) => saved.get(id), putLayout: (layout) => layout }
    })
    expect(await restored.handlers['layout.get']({ worktreeId: WORKTREE })).toEqual(saved.get(WORKTREE))
  })
})

describe('registerTerminalHandlers', () => {
  it('registers every terminal and layout method with its schema', () => {
    const service = createTerminalService()
    const registered = new Map<string, unknown>()
    const registry: MethodRegistry = {
      register: (method, schema) => {
        registered.set(method, schema)
      }
    }

    registerTerminalHandlers(registry, service)

    expect([...registered.keys()].sort()).toEqual([
      'agent.list',
      'layout.get',
      'layout.set',
      'terminal.close',
      'terminal.create',
      'terminal.list',
      'terminal.read',
      'terminal.relaunch',
      'terminal.resize',
      'terminal.split',
      'terminal.subscribe',
      'terminal.write'
    ])
    // The schemas come from the contract, so the dispatcher validates against the
    // same declaration the CLI and the renderer are typed from.
    expect(registered.get('terminal.create')).toBe(service.schemas['terminal.create'])
  })
})
