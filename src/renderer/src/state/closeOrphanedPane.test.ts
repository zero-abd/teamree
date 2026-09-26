// × on a pane the runtime no longer has a terminal for still takes the pane away.

import { expect, it, vi } from 'vitest'
import { collectTerminalIds } from '../panes/paneLayout'

vi.mock('../runtimeClient/currentRuntimeClient', async () => {
  const { createSeededRuntimeClient } = await import('../runtimeClient/seededRuntimeClient')
  return { runtimeClient: createSeededRuntimeClient() }
})

import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from './workspaceStore'

it('takes an orphaned leaf off screen when the runtime says its terminal is gone', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const worktreeId = useWorkspaceStore.getState().activeWorktreeId!
  await store.openWorktree(worktreeId)
  const layout = useWorkspaceStore.getState().layouts[worktreeId]!
  const live = collectTerminalIds(layout.root)
  useWorkspaceStore.setState((state) => ({
    layouts: {
      ...state.layouts,
      [worktreeId]: {
        worktreeId,
        root: {
          kind: 'split',
          direction: 'row',
          sizes: [0.5, 0.5],
          children: [layout.root!, { kind: 'leaf', terminalId: 'term_orphan' }]
        },
        focusedTerminalId: 'term_orphan'
      }
    }
  }))

  const original = runtimeClient.call.bind(runtimeClient)
  const call = vi.spyOn(runtimeClient, 'call').mockImplementation(async (method, params) => {
    if (method === 'terminal.close') throw Object.assign(new Error('no such terminal'), { code: 'not_found' })
    return original(method, params as never)
  })
  const noticesBefore = useWorkspaceStore.getState().notices.length

  await store.closeTerminal('term_orphan')

  const after = useWorkspaceStore.getState()
  expect(collectTerminalIds(after.layouts[worktreeId]!.root)).toEqual(live)
  expect(live).toContain(after.layouts[worktreeId]!.focusedTerminalId)
  expect(after.notices).toHaveLength(noticesBefore)
  call.mockRestore()
})
