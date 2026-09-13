// Terminal and layout failures as a caller actually receives them.
//
// Driven through the dispatcher on purpose. That is the seam where an error's
// code was being lost — a handler's thrown object can carry a perfectly good
// `not_found` and still reach the wire as `internal`, and a test that asserts on
// the throw rather than on the response cannot tell the difference. The
// protocol promises callers branch on these codes and never on message text, so
// what matters is what comes back out of `dispatch`.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Terminal } from '../../shared/entities'
import { ErrorCode, type ErrorResponse, type Response } from '../../shared/protocol'
import { createTerminalService, registerTerminalHandlers } from '../terminals/method-handlers'
import type { TerminalService } from '../terminals/method-handlers'
import { canSpawnPty, waitUntil } from '../terminals/pty-test-support'
import { WorkspaceStore } from '../store/workspaceStore'
import { createDispatcher, type Dispatcher } from './dispatcher'
import { MethodRegistry } from './methodRegistry'
import { createRuntimeContext } from './runtimeContext'
import { SubscriptionHub } from './subscriptionHub'

const describePty = canSpawnPty() ? describe : describe.skip
const TEST_TIMEOUT_MS = 20_000
const WORKTREE = 'wt_codes'
const MISSING = 'term_nope'

type Harness = {
  terminals: TerminalService
  dispatch: Dispatcher
  checkout: string
}

const temporaryDirs: string[] = []
const services: TerminalService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()))
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function harness(): Promise<Harness> {
  const checkout = await mkdtemp(join(tmpdir(), 'teamree-error-codes-'))
  temporaryDirs.push(checkout)
  const store = await WorkspaceStore.open(join(checkout, 'workspace.json'))
  const hub = new SubscriptionHub()
  // terminal.subscribe goes through the hub, and the hub refuses a connection it
  // has never seen — so without this the subscribe case would prove nothing
  // about the terminal service.
  hub.openConnection('c1', () => {})
  const context = createRuntimeContext({ version: 'test', store, subscriptions: hub })
  const registry = new MethodRegistry(context)

  const terminals = createTerminalService({
    subscriptions: hub,
    resolveWorktreeCwd: (worktreeId) => (worktreeId === WORKTREE ? checkout : undefined),
    layouts: store
  })
  services.push(terminals)
  registerTerminalHandlers(registry, terminals)
  return { terminals, dispatch: createDispatcher(registry), checkout }
}

/** The error a caller sees, or a failure saying the call unexpectedly worked. */
async function errorFrom(dispatch: Dispatcher, method: string, params: unknown): Promise<ErrorResponse['error']> {
  const response = (await dispatch({ id: 'r1', method, params }, { connectionId: 'c1' })) as Response
  if (response.ok) throw new Error(`${method} was expected to fail but returned ${JSON.stringify(response.result)}`)
  return response.error
}

describe('terminal error codes on the wire', () => {
  it('reports a pane that is gone as not_found, on every method that takes one', async () => {
    const { dispatch } = await harness()

    const calls: [string, unknown][] = [
      ['terminal.read', { terminalId: MISSING }],
      ['terminal.close', { terminalId: MISSING }],
      ['terminal.write', { terminalId: MISSING, data: 'x' }],
      ['terminal.resize', { terminalId: MISSING, cols: 80, rows: 24 }],
      ['terminal.split', { terminalId: MISSING, direction: 'row' }],
      ['terminal.subscribe', { terminalId: MISSING }]
    ]

    for (const [method, params] of calls) {
      const error = await errorFrom(dispatch, method, params)
      expect(error.code, method).toBe(ErrorCode.NotFound)
    }
  })

  it('reports a worktree with no checkout as invalid_params rather than an internal bug', async () => {
    const { dispatch } = await harness()

    const error = await errorFrom(dispatch, 'terminal.create', { worktreeId: 'wt_nope' })
    expect(error.code).toBe(ErrorCode.InvalidParams)
    expect(error.message).toContain('wt_nope')
  })

  it('reports a cwd that is not a directory as not_found', async () => {
    const { dispatch, checkout } = await harness()
    const file = join(checkout, 'a-file')
    await writeFile(file, 'not a directory', 'utf8')

    const error = await errorFrom(dispatch, 'terminal.create', { worktreeId: WORKTREE, cwd: file })
    expect(error.code).toBe(ErrorCode.NotFound)
  })

  it('reports a pane tree that is not one as invalid_params', async () => {
    const { dispatch } = await harness()

    const error = await errorFrom(dispatch, 'layout.set', {
      worktreeId: WORKTREE,
      root: { kind: 'split', direction: 'vertical' },
      focusedTerminalId: null
    })
    expect(error.code).toBe(ErrorCode.InvalidParams)
  })
})

describePty('terminal error codes over a real pty', () => {
  it(
    'reports writing to a pane that has exited as conflict, not as internal',
    async () => {
      const { terminals, dispatch } = await harness()
      const opened = (await dispatch(
        {
          id: 'open',
          method: 'terminal.create',
          params: { worktreeId: WORKTREE, shell: '/bin/sh', command: 'exit 3' }
        },
        { connectionId: 'c1' }
      )) as Response
      if (!opened.ok) throw new Error('terminal.create failed')
      const pane = opened.result as Terminal

      // Waited out rather than raced: the write has to land after the exit has
      // settled, or the pty simply swallows it and nothing is proved.
      await waitUntil(
        () => terminals.manager.list(WORKTREE).some((each) => each.id === pane.id && !each.running),
        'the pane to exit'
      )

      const error = await errorFrom(dispatch, 'terminal.write', { terminalId: pane.id, data: 'hello\n' })
      expect(error.code).toBe(ErrorCode.Conflict)
      expect(error.message).toContain(pane.id)
    },
    TEST_TIMEOUT_MS
  )
})
