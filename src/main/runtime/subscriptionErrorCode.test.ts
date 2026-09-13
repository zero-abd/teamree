// The code a failed subscribe puts on the wire.
//
// The hub is the one service whose errors nobody is left to read: a connection
// that is gone cannot be told anything. That makes it the easiest place for a
// code to be decided by accident, which is what this pins down.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCode } from '../../shared/protocol'
import { WorkspaceStore } from '../store/workspaceStore'
import { createDispatcher } from './dispatcher'
import { MethodRegistry } from './methodRegistry'
import { createRuntimeContext } from './runtimeContext'
import { RuntimeError } from './runtimeError'
import { SubscriptionHub } from './subscriptionHub'
import { registerWorkspaceSubscribeHandler } from './handlers/workspaceSubscribeHandler'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('subscribing on a connection the hub does not know', () => {
  it('carries a code chosen here, not one the dispatcher fell back to', () => {
    const hub = new SubscriptionHub()

    let thrown: unknown
    try {
      hub.subscribe('never-opened', () => () => {})
    } catch (error) {
      thrown = error
    }

    // The difference this protects is not the code — it is that the code is
    // this module's decision. A plain Error reaches the wire as `internal`
    // too, from the dispatcher's catch-all, which is the same answer for a
    // deliberate refusal and for a crash in a handler.
    expect(thrown).toBeInstanceOf(RuntimeError)
    expect((thrown as RuntimeError).code).toBe(ErrorCode.Internal)
  })

  it('reaches a caller as internal rather than as an unhandled throw', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teamree-subscribe-'))
    directories.push(directory)
    const store = await WorkspaceStore.open(join(directory, 'workspace.json'))
    const hub = new SubscriptionHub()
    const registry = new MethodRegistry(createRuntimeContext({ version: 'test', store, subscriptions: hub }))
    registerWorkspaceSubscribeHandler(registry)
    const dispatch = createDispatcher(registry)

    // No openConnection: the transport never registered this one.
    const response = await dispatch({ id: 'r1', method: 'workspace.subscribe' }, { connectionId: 'c1' })

    expect(response.ok).toBe(false)
    expect(response.ok ? undefined : response.error.code).toBe(ErrorCode.Internal)
    expect(response.ok ? undefined : response.error.message).toContain('unknown connection')
  })
})
