import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCode, type ErrorResponse, type SuccessResponse } from '../../../shared/protocol'
import { DEFAULT_RUNTIME_SETTINGS } from '../../../shared/settings'
import { emptyProjectContext } from '../../../shared/memory'
import type { WorkspaceEvent } from '../../../shared/methods'
import { WorkspaceStore } from '../../store/workspaceStore'
import { createDispatcher, type Dispatcher } from '../dispatcher'
import { MethodRegistry } from '../methodRegistry'
import { createRuntimeContext } from '../runtimeContext'
import { SubscriptionHub } from '../subscriptionHub'
import { registerHandlers } from './registerHandlers'

const call = { connectionId: 'test' }

describe('task, memory and add-on methods before their branches land', () => {
  let directory: string
  let dispatch: Dispatcher
  let store: WorkspaceStore
  let events: WorkspaceEvent[]

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'teamree-task-placeholders-'))
    store = await WorkspaceStore.open(join(directory, 'workspace.json'))
    const context = createRuntimeContext({ version: '9.9.9', store, subscriptions: new SubscriptionHub() })
    const registry = new MethodRegistry(context)
    registerHandlers(registry)
    dispatch = createDispatcher(registry)
    events = []
    context.workspaceEvents.on((event) => events.push(event))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  const result = async (method: string, params: unknown): Promise<unknown> => {
    const response = await dispatch({ id: 'r', method, params }, call)
    expect(response.ok).toBe(true)
    return (response as SuccessResponse).result
  }

  it('answers every read with an empty result', async () => {
    expect(await result('message.list', {})).toEqual([])
    expect(await result('message.read', { ids: [1] })).toEqual({ read: 0 })
    expect(await result('project.context', { worktreeId: 'wt_1' })).toEqual(emptyProjectContext('wt_1'))
    expect(await result('memory.conflicts', { worktreeId: 'wt_1' })).toEqual([])
    expect(await result('worktree.overlaps', { projectId: 'p' })).toMatchObject({ projectId: 'p', overlaps: [] })
    expect(await result('worktree.usage', {})).toEqual([])
    expect(await result('teamwork.handoffs', { projectId: 'p' })).toEqual({ incoming: [], outgoing: [] })
    expect(await result('project.templates', { projectId: 'p' })).toEqual({
      projectId: 'p',
      templates: [],
      problems: []
    })
    expect(await result('addons.status', {})).toEqual([{ id: 'jac-memory', state: 'off' }])
  })

  it('refuses every write as not implemented yet', async () => {
    const writes: [string, unknown][] = [
      ['message.send', { from: { you: true }, to: { worktreeId: 'w' }, kind: 'note', text: 'hi' }],
      ['memory.note', { worktreeId: 'w', kind: 'decision', text: 'x' }],
      ['memory.resolve', { noteId: 'n' }],
      ['memory.forget', { noteId: 'n' }],
      ['teamwork.handOff', { worktreeId: 'w', to: 'ana', note: '' }],
      ['teamwork.take', { projectId: 'p', id: 'h' }],
      ['teamwork.dismissHandoff', { projectId: 'p', id: 'h' }],
      ['project.saveTemplate', { projectId: 'p', name: 'review', agents: {}, prompt: 'x' }],
      ['addons.install', { id: 'jac-memory' }]
    ]
    for (const [method, params] of writes) {
      const response = (await dispatch({ id: 'w', method, params }, call)) as ErrorResponse
      expect(response.error.code, method).toBe(ErrorCode.NotFound)
      expect(response.error.message).toContain('not implemented')
    }
  })

  it('validates params before answering', async () => {
    const response = (await dispatch({ id: 'v', method: 'project.context', params: {} }, call)) as ErrorResponse
    expect(response.error.code).toBe(ErrorCode.InvalidParams)
  })

  it('keeps settings, defaulting Share Task Details on and the rest off', async () => {
    expect(await result('settings.get', {})).toEqual(DEFAULT_RUNTIME_SETTINGS)
    expect(await result('settings.set', { showCost: true })).toEqual({ ...DEFAULT_RUNTIME_SETTINGS, showCost: true })
    expect(store.runtimeSettings().showCost).toBe(true)
    expect(events).toContainEqual({ type: 'settings' })
  })
})
