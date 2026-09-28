// Resume All after a quit or a crash: one notice for the agents that can pick their conversations back up,
// each resumed with its own and none started afresh or handed its task again.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Terminal } from '@shared/entities'

vi.mock('../runtimeClient/currentRuntimeClient', async () => {
  const { createSeededRuntimeClient } = await import('../runtimeClient/seededRuntimeClient')
  return { runtimeClient: createSeededRuntimeClient() }
})

import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { resumableAgents } from '../panes/resumeAll'
import { useWorkspaceStore } from './workspaceStore'

const INITIAL = useWorkspaceStore.getState()

const pane = (id: string, extra: Partial<Terminal>): Terminal => ({
  id,
  worktreeId: 'w1',
  title: 'claude',
  cwd: '/repos/pager',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  running: false,
  busy: false,
  lastOutputAt: 0,
  agent: 'claude',
  exitCode: 1,
  ...extra
})

const RESTORED = [
  pane('t_failed', { restored: 'stopped', stoppedFor: 'failed', resumable: true }),
  pane('t_other', { restored: 'stopped', stoppedFor: 'failed', resumable: true, worktreeId: 'w2' }),
  pane('t_nothing', { restored: 'stopped', stoppedFor: 'no-conversation', exitCode: 0 }),
  pane('t_done', { restored: 'stopped', stoppedFor: 'task-done', exitCode: 0 }),
  pane('t_live', { running: true, exitCode: undefined, restored: 'agent' })
]

let relaunched: unknown[]

beforeEach(() => {
  relaunched = []
  useWorkspaceStore.setState(INITIAL, true)
  const call = runtimeClient.call.bind(runtimeClient)
  vi.spyOn(runtimeClient, 'call').mockImplementation((async (method: string, params: Record<string, unknown>) => {
    if (method === 'terminal.list') return RESTORED
    if (method === 'terminal.relaunch') {
      relaunched.push(params)
      if (params.terminalId === 't_other') throw new Error('t_other has nothing to resume')
      return { ...RESTORED.find((entry) => entry.id === params.terminalId), running: true, restored: undefined }
    }
    return call(method as never, params as never)
  }) as never)
})

afterEach(() => vi.restoreAllMocks())

it('offers only the ended agents whose own conversation can be picked up', () => {
  expect(resumableAgents(RESTORED).map((terminal) => terminal.id)).toEqual(['t_failed', 't_other'])
  expect(resumableAgents(RESTORED, 'w2').map((terminal) => terminal.id)).toEqual(['t_other'])
})

it('says after a relaunch how many agents stopped, once, with Resume All', async () => {
  await useWorkspaceStore.getState().bootstrap()
  const notices = useWorkspaceStore.getState().notices.filter((notice) => notice.text === '2 agents stopped')
  expect(notices).toHaveLength(1)
  expect(notices[0]?.action).toEqual({ label: 'Resume All', resume: ['t_failed', 't_other'] })
})

it('resumes each with its own conversation only, never a fresh one or the task, and says which did not', async () => {
  await useWorkspaceStore.getState().bootstrap()
  await useWorkspaceStore.getState().resumeAgents(['t_failed', 't_other'])
  expect(relaunched).toEqual([
    { terminalId: 't_failed', resumeOnly: true },
    { terminalId: 't_other', resumeOnly: true }
  ])
  const state = useWorkspaceStore.getState()
  expect(state.terminals.t_failed?.running).toBe(true)
  expect(state.terminals.t_other?.running).toBe(false)
  expect(state.notices.map((notice) => notice.text)).toEqual(['Could not resume 1 agent'])
})
