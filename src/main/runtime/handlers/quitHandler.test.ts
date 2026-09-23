import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCode, type ErrorResponse } from '../../../shared/protocol'
import { WorkspaceStore } from '../../store/workspaceStore'
import { createDispatcher, type Dispatcher } from '../dispatcher'
import { MethodRegistry } from '../methodRegistry'
import { createRuntimeContext } from '../runtimeContext'
import { SubscriptionHub } from '../subscriptionHub'
import { registerQuitHandler } from './quitHandler'

const call = { connectionId: 'test' }

describe('app.quit', () => {
  let directory: string
  let registry: MethodRegistry

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'teamree-quit-'))
    const store = await WorkspaceStore.open(join(directory, 'workspace.json'))
    const context = createRuntimeContext({ version: '9.9.9', store, subscriptions: new SubscriptionHub() })
    registry = new MethodRegistry(context)
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('answers with the pid it is about to end, and only then asks to quit', async () => {
    const deferred: Array<() => void> = []
    let quits = 0
    registerQuitHandler(registry, { requestQuit: () => (quits += 1), defer: (run) => deferred.push(run) })
    const dispatch: Dispatcher = createDispatcher(registry)

    const response = await dispatch({ id: 'q1', method: 'app.quit', params: {} }, call)

    // The reply travels on the connection the quit is about to take, so it has
    // to be out of the door before anything starts tearing down.
    expect(response).toMatchObject({ id: 'q1', ok: true, result: { quitting: true, pid: process.pid } })
    expect(quits).toBe(0)

    for (const run of deferred) run()
    expect(quits).toBe(1)
  })

  it('refuses when there is no app behind the runtime', async () => {
    registerQuitHandler(registry)
    const response = (await createDispatcher(registry)(
      { id: 'q2', method: 'app.quit', params: {} },
      call
    )) as ErrorResponse

    expect(response.ok).toBe(false)
    expect(response.error.code).toBe(ErrorCode.NotFound)
    expect(response.error.message).toMatch(/no app to quit/)
  })
})
