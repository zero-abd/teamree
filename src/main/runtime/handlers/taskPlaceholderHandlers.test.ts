import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCode, type ErrorResponse, type SuccessResponse } from '../../../shared/protocol'
import { DEFAULT_RUNTIME_SETTINGS } from '../../../shared/settings'
import type { WorkspaceEvent } from '../../../shared/methods'
import { WorkspaceStore } from '../../store/workspaceStore'
import { resolveLoginShell } from '../../terminals/shell-environment'
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
    expect(await result('worktree.usage', {})).toEqual([])
    expect(await result('project.templates', { projectId: 'p' })).toEqual({
      projectId: 'p',
      templates: [],
      problems: []
    })
    // Real now: off by default, and whether uv is here depends on the machine.
    expect(await result('addons.status', {})).toEqual([expect.objectContaining({ id: 'jac-memory', state: 'off' })])
  })

  it('refuses every write as not implemented yet', async () => {
    const writes: [string, unknown][] = [
      ['project.saveTemplate', { projectId: 'p', name: 'review', agents: {}, prompt: 'x' }]
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
    const fallback = {
      worktreesRootFallback: join(homedir(), '.teamree', 'worktrees'),
      shellFallback: resolveLoginShell()
    }
    expect(await result('settings.get', {})).toEqual({ ...DEFAULT_RUNTIME_SETTINGS, ...fallback })
    expect(await result('settings.set', { showCost: true })).toEqual({
      ...DEFAULT_RUNTIME_SETTINGS,
      ...fallback,
      showCost: true
    })
    expect(store.runtimeSettings().showCost).toBe(true)
    expect(events).toContainEqual({ type: 'settings' })
  })

  it('keeps a checked worktrees folder and branch prefix, and clears either on empty', async () => {
    const folder = join(directory, 'checkouts')
    expect(await result('settings.set', { worktreesRoot: folder, branchPrefix: 'abd/' })).toMatchObject({
      worktreesRoot: folder,
      branchPrefix: 'abd/'
    })
    const cleared = (await result('settings.set', { worktreesRoot: '', branchPrefix: '' })) as Record<string, unknown>
    expect([cleared.worktreesRoot, cleared.branchPrefix]).toEqual([undefined, undefined])

    const relative = (await dispatch(
      { id: 's', method: 'settings.set', params: { worktreesRoot: 'x' } },
      call
    )) as ErrorResponse
    expect(relative.error.data).toMatchObject({ refusal: 'notAbsolute' })
    const spaced = (await dispatch(
      { id: 's', method: 'settings.set', params: { branchPrefix: 'a b' } },
      call
    )) as ErrorResponse
    expect(spaced.error.code).toBe(ErrorCode.InvalidParams)
    expect(store.runtimeSettings().branchPrefix).toBeUndefined()
    await store.flush()
  })

  it('keeps a shell that runs and a fetch interval, across a restart, and clears the shell on empty', async () => {
    expect(await result('settings.set', { shell: '/bin/sh', fetchMinutes: 15 })).toMatchObject({
      shell: '/bin/sh',
      fetchMinutes: 15
    })
    await store.flush()
    const reopened = await WorkspaceStore.open(join(directory, 'workspace.json'))
    expect(reopened.runtimeSettings()).toMatchObject({ shell: '/bin/sh', fetchMinutes: 15 })

    const cleared = (await result('settings.set', { shell: '' })) as Record<string, unknown>
    expect(cleared.shell).toBeUndefined()
    await store.flush()
  })

  it('refuses a shell that is not a full path to a program', async () => {
    for (const shell of ['zsh', join(directory, 'missing'), directory]) {
      const response = (await dispatch({ id: 's', method: 'settings.set', params: { shell } }, call)) as ErrorResponse
      expect(response.error.code, shell).toBe(ErrorCode.InvalidParams)
    }
    expect(store.runtimeSettings().shell).toBeUndefined()
  })
})
