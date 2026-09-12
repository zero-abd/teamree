import { afterEach, describe, expect, it } from 'vitest'
import type { Layout, Terminal } from '../../shared/entities'
import { ErrorCode } from '../../shared/protocol'
import type { TerminalEvent } from '../../shared/methods'
import { createTerminalService, registerTerminalHandlers } from './method-handlers'
import type { MethodRegistry, StreamChannel, TerminalService } from './method-handlers'
import { isProcessAlive } from './process-tree'
import { canSpawnPty, waitUntil } from './pty-test-support'
import { isTerminalServiceError } from './service-error'

// Driven through the handler surface the runtime will call, over real PTYs, so
// the seam itself is under test and not just the classes behind it.
const describePty = canSpawnPty() ? describe : describe.skip
const TEST_TIMEOUT_MS = 20_000

const WORKTREE = 'wt_alpha'
const services: TerminalService[] = []
const published: Array<{ subscription: string; event: TerminalEvent }> = []

function newService(): TerminalService {
  const service = createTerminalService({
    publish: (subscription, event) => published.push({ subscription, event }),
    resolveWorktreeCwd: (worktreeId) => (worktreeId === WORKTREE ? process.cwd() : undefined)
  })
  services.push(service)
  return service
}

function newTerminal(service: TerminalService, command = 'cat'): Promise<Terminal> {
  return service.handlers['terminal.create']({ worktreeId: WORKTREE, shell: '/bin/sh', command })
}

afterEach(async () => {
  published.length = 0
  await Promise.all(services.splice(0).map((service) => service.shutdown()))
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
      await service.handlers['terminal.create']({
        worktreeId: 'wt_other',
        shell: '/bin/sh',
        command: 'cat',
        cwd: process.cwd()
      })

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
        direction: 'row',
        command: 'cat'
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
      const terminal = await newTerminal(service, 'echo streamed; exit 3')
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

      const terminal = await service.handlers['terminal.create']({
        worktreeId: WORKTREE,
        shell: '/bin/sh',
        command: 'cat'
      })
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
      const terminal = await newTerminal(service, 'sleep 120 & echo child:$!; wait')
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
      'layout.get',
      'layout.set',
      'terminal.close',
      'terminal.create',
      'terminal.list',
      'terminal.read',
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
