// The two methods over a dispatcher, with a table handed in instead of a `ps`
// and a kill that only logs. The guard is the point: a pid the window could
// not have been shown a Kill for never reaches `process.kill`.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCode, type ErrorResponse, type SuccessResponse } from '../../../shared/protocol'
import type { SystemResources } from '../../../shared/entities'
import { WorkspaceStore } from '../../store/workspaceStore'
import { createDispatcher, type Dispatcher } from '../dispatcher'
import { MethodRegistry } from '../methodRegistry'
import { createRuntimeContext } from '../runtimeContext'
import { SubscriptionHub } from '../subscriptionHub'
import { registerResourcesHandlers } from './resourcesHandlers'

const call = { connectionId: 'test' }

const TABLE = [
  '  PID  PPID  %CPU    RSS COMM',
  '  500     1   2.0 409600 /Applications/teamree.app/Contents/MacOS/teamree',
  '  501   500   1.5 204800 /Applications/teamree.app/Contents/Frameworks/teamree Helper (Renderer)',
  '  600   500   0.0   3072 /bin/zsh',
  '  601   600  98.7  51200 /usr/local/bin/node',
  ''
].join('\n')

describe('system.resources and system.kill', () => {
  let directory: string
  let dispatch: Dispatcher
  let killed: Array<[number, string]>

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'teamree-resources-'))
    const store = await WorkspaceStore.open(join(directory, 'workspace.json'))
    const registry = new MethodRegistry(
      createRuntimeContext({ version: '0', store, subscriptions: new SubscriptionHub() })
    )
    killed = []
    registerResourcesHandlers(registry, {
      panes: () => [{ terminalId: 'term_a', worktreeId: 'wt_1', pid: 600 }],
      appPid: 500,
      host: { ps: async () => TABLE, now: () => 4242 },
      kill: (target, signal) => {
        killed.push([target, signal])
      }
    })
    dispatch = createDispatcher(registry)
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('answers the tree from one table', async () => {
    const response = (await dispatch({ id: 'r1', method: 'system.resources', params: {} }, call)) as SuccessResponse
    expect(response.ok).toBe(true)
    const sample = response.result as SystemResources
    expect(sample.sampledAt).toBe(4242)
    expect(sample.panes[0]?.processes.map((process) => process.pid)).toEqual([600, 601])
    expect(sample.app.processes.map((process) => process.pid)).toEqual([500, 501])
  })

  it('signals a process under a pane, and the group for the child itself', async () => {
    await dispatch({ id: 'k1', method: 'system.kill', params: { pid: 601 } }, call)
    await dispatch({ id: 'k2', method: 'system.kill', params: { pid: 600 } }, call)
    expect(killed).toEqual([
      [601, 'SIGTERM'],
      [-600, 'SIGTERM']
    ])
  })

  it('refuses the app, its helpers, and a stranger, without signalling', async () => {
    for (const pid of [500, 501, 1, 999]) {
      const response = (await dispatch(
        { id: `k${pid}`, method: 'system.kill', params: { pid } },
        call
      )) as ErrorResponse
      expect(response.ok).toBe(false)
      expect(response.error.code).toBe(ErrorCode.NotFound)
    }
    expect(killed).toEqual([])
  })
})
