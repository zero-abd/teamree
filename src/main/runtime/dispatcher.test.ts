import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ErrorCode, type ErrorResponse } from '../../shared/protocol'
import { WorkspaceStore } from '../store/workspaceStore'
import { registerPlaceholderHandlers } from './handlers/placeholderHandlers'
import { createDispatcher, type Dispatcher } from './dispatcher'
import { registerHandlers } from './handlers/registerHandlers'
import { MethodRegistry } from './methodRegistry'
import { createRuntimeContext } from './runtimeContext'
import { RuntimeError } from './runtimeError'
import { SubscriptionHub } from './subscriptionHub'

const call = { connectionId: 'test' }

describe('dispatcher', () => {
  let directory: string
  let registry: MethodRegistry
  let dispatch: Dispatcher
  let context: ReturnType<typeof createRuntimeContext>

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'teamree-dispatch-'))
    const store = await WorkspaceStore.open(join(directory, 'workspace.json'))
    context = createRuntimeContext({ version: '9.9.9', store, subscriptions: new SubscriptionHub() })
    context.endpoint = '/tmp/teamree-test.sock'
    registry = new MethodRegistry(context)
    registerHandlers(registry)
    dispatch = createDispatcher(registry)
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('answers status.get with the runtime identity', async () => {
    const response = await dispatch({ id: 'a1', method: 'status.get', params: {} }, call)

    expect(response).toMatchObject({
      id: 'a1',
      ok: true,
      result: { version: '9.9.9', endpoint: '/tmp/teamree-test.sock', pid: process.pid, platform: process.platform }
    })
  })

  it('treats absent params as an empty object', async () => {
    const response = await dispatch({ id: 'a2', method: 'status.get' }, call)
    expect(response.ok).toBe(true)
  })

  it('rejects an unknown method', async () => {
    const response = (await dispatch({ id: 'b1', method: 'nope.nope', params: {} }, call)) as ErrorResponse

    expect(response.ok).toBe(false)
    expect(response.error.code).toBe(ErrorCode.UnknownMethod)
    expect(response.error.message).toContain('nope.nope')
  })

  it('rejects invalid params and reports the offending path', async () => {
    const response = (await dispatch({ id: 'c1', method: 'worktree.get', params: {} }, call)) as ErrorResponse

    expect(response.ok).toBe(false)
    expect(response.error.code).toBe(ErrorCode.InvalidParams)
    expect(response.error.data).toMatchObject([{ path: 'worktreeId' }])
  })

  it('rejects a malformed envelope', async () => {
    const response = (await dispatch({ method: 'status.get' }, call)) as ErrorResponse

    expect(response.ok).toBe(false)
    expect(response.error.code).toBe(ErrorCode.BadRequest)
    expect(response.id).toBe('')
  })

  it('maps an unexpected handler throw to internal', async () => {
    registry.register('project.list', z.object({}), () => {
      throw new Error('disk on fire')
    })

    const response = (await dispatch({ id: 'd1', method: 'project.list', params: {} }, call)) as ErrorResponse

    expect(response.error.code).toBe(ErrorCode.Internal)
    expect(response.error.message).toBe('disk on fire')
  })

  it('preserves the code and data of a RuntimeError', async () => {
    registry.register('project.list', z.object({}), () => {
      throw new RuntimeError(ErrorCode.GitFailed, 'fetch failed', { exitCode: 128 })
    })

    const response = (await dispatch({ id: 'd2', method: 'project.list', params: {} }, call)) as ErrorResponse

    expect(response.error).toEqual({ code: ErrorCode.GitFailed, message: 'fetch failed', data: { exitCode: 128 } })
  })

  it('reports a method left as a placeholder as not_found', async () => {
    // Every contract method now has a real handler, so the placeholder path is
    // exercised against a registry that deliberately has not been wired.
    const bare = new MethodRegistry(context)
    registerPlaceholderHandlers(bare)
    const response = (await createDispatcher(bare)(
      { id: 'e1', method: 'worktree.list', params: {} },
      call
    )) as ErrorResponse

    expect(response.error.code).toBe(ErrorCode.NotFound)
    expect(response.error.message).toContain('not implemented')
  })

  it('registers every method in the contract', () => {
    // Named rather than counted: a bare count tells you a number changed, not
    // which method arrived or went missing.
    expect([...registry.methods()].sort()).toEqual([
      'agent.list',
      'layout.get',
      'layout.set',
      'members.join',
      'members.list',
      // Reachable over the peer transport and nowhere else. They are in the one
      // registry because a teammate is another transport onto the catalogue
      // rather than a catalogue of its own; `PEER_METHODS` in peerTransport.ts
      // is what makes the two audiences different.
      'peer.presence',
      'peer.subscribe',
      'project.add',
      'project.list',
      'project.remove',
      'status.get',
      // Local, not peer-reachable, and the owner's own: a mute needs nobody's
      // agreement and the write log never leaves this machine.
      'teamwork.mute',
      'teamwork.presence',
      'teamwork.status',
      // Local, not peer-reachable. `teamwork.watch` and `teamwork.type` are
      // this machine asking to read and to type into somebody else's pane; what
      // crosses the wire underneath them is `terminal.subscribe`,
      // `terminal.read` and `terminal.write` on their runtime.
      'teamwork.type',
      'teamwork.watch',
      'teamwork.watchers',
      'teamwork.writeLog',
      'terminal.close',
      'terminal.create',
      'terminal.list',
      'terminal.read',
      'terminal.resize',
      'terminal.split',
      'terminal.subscribe',
      'terminal.write',
      'unsubscribe',
      'workspace.subscribe',
      'worktree.changes',
      'worktree.commit',
      'worktree.create',
      'worktree.diff',
      'worktree.get',
      'worktree.list',
      'worktree.log',
      'worktree.mergePreview',
      'worktree.push',
      'worktree.remove',
      'worktree.startPoints',
      'worktree.status'
    ])
  })
})
