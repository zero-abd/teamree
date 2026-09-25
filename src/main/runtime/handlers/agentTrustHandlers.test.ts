import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TrustRequest } from '../../agentTrust'
import { WorkspaceStore } from '../../store/workspaceStore'
import { createDispatcher } from '../dispatcher'
import { MethodRegistry } from '../methodRegistry'
import { createRuntimeContext } from '../runtimeContext'
import { SubscriptionHub } from '../subscriptionHub'
import { registerAgentTrustHandlers, trustCheckoutFor } from './agentTrustHandlers'

const call = { connectionId: 'test' }

describe('Trust New Worktrees', () => {
  let directory: string
  let registry: MethodRegistry

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'teamree-agent-trust-'))
    const store = await WorkspaceStore.open(join(directory, 'workspace.json'))
    registry = new MethodRegistry(
      createRuntimeContext({ version: '9.9.9', store, subscriptions: new SubscriptionHub() })
    )
    registerAgentTrustHandlers(registry)
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('is on by default and turns off', async () => {
    const dispatch = createDispatcher(registry)
    expect(await dispatch({ id: 'a1', method: 'agents.trust', params: {} }, call)).toMatchObject({
      ok: true,
      result: { trustNewWorktrees: true }
    })
    expect(
      await dispatch({ id: 'a2', method: 'agents.setTrust', params: { trustNewWorktrees: false } }, call)
    ).toMatchObject({ ok: true, result: { trustNewWorktrees: false } })
    expect(registry.context.store.trustNewWorktrees()).toBe(false)
  })

  it('records trust for a new checkout only while it is on', async () => {
    const asked: TrustRequest[] = []
    const trustCheckout = trustCheckoutFor(registry.context.store, async (request) => {
      asked.push(request)
      return []
    })
    const checkout = { projectPath: '/repo', worktreePath: '/worktrees/repo/task' }

    await trustCheckout(checkout)
    registry.context.store.setTrustNewWorktrees(false)
    await trustCheckout(checkout)

    expect(asked).toEqual([{ mainCheckout: '/repo', worktree: '/worktrees/repo/task' }])
  })
})
