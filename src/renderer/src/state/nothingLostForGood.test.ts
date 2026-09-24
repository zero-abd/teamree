// Remove and Discard answer with Undo, and a closed pane comes back with ⌘⇧T under its old name.

import { expect, it, vi } from 'vitest'
import type { ClosedPane, Terminal } from '@shared/entities'
import type { PatchHunk } from '@shared/patch'
import type { MethodName } from '@shared/methods'
import { runWorkspaceCommand } from '../keyboard/workspaceCommands'
import { noticeLifetime, UNDO_LIFETIME_MS } from '../notices/noticeLifetime'
import { collectTerminalIds } from '../panes/paneLayout'

vi.mock('../runtimeClient/currentRuntimeClient', async () => {
  const { createSeededRuntimeClient } = await import('../runtimeClient/seededRuntimeClient')
  return { runtimeClient: createSeededRuntimeClient() }
})

import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from './workspaceStore'

/** Answers `answers` for their methods and the seeded runtime for the rest; returns the spy. */
function answering(answers: Partial<Record<MethodName, (params: never) => unknown>>) {
  const original = runtimeClient.call.bind(runtimeClient)
  return vi.spyOn(runtimeClient, 'call').mockImplementation(async (method, params) => {
    const answer = answers[method]
    return (answer === undefined ? original(method, params as never) : answer(params as never)) as never
  })
}

it('offers Undo after a removal, and Undo checks the worktree out again and opens it', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const worktree = useWorkspaceStore.getState().worktrees.find((entry) => entry.state === 'ready')!
  const remove = answering({
    'worktree.remove': () => ({ removed: true, trashId: `${worktree.id}/1` }),
    'worktree.restore': () => worktree
  })

  await store.confirmRemoveWorktree(worktree.id, true)

  const notice = useWorkspaceStore.getState().notices.at(-1)!
  expect(notice.text).toMatch(/^Removed "/)
  expect(notice.action).toEqual({
    label: 'Undo',
    undo: { kind: 'remove', projectId: worktree.projectId, removedId: `${worktree.id}/1` }
  })
  expect(noticeLifetime(notice)).toBe(UNDO_LIFETIME_MS)
  expect(useWorkspaceStore.getState().worktrees.some((entry) => entry.id === worktree.id)).toBe(false)

  await store.undo((notice.action as { undo: Parameters<typeof store.undo>[0] }).undo)

  expect(remove.mock.calls.find(([method]) => method === 'worktree.restore')?.[1]).toEqual({
    projectId: worktree.projectId,
    removedId: `${worktree.id}/1`
  })
  expect(useWorkspaceStore.getState().worktrees.some((entry) => entry.id === worktree.id)).toBe(true)
  expect(useWorkspaceStore.getState().activeWorktreeId).toBe(worktree.id)
  remove.mockRestore()
})

it('offers Undo after discarding a hunk, and Undo puts the copy back', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const worktreeId = useWorkspaceStore.getState().worktrees.find((entry) => entry.state === 'ready')!.id
  const hunk = {
    header: '@@ -1 +1 @@',
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    lines: []
  } as unknown as PatchHunk
  const call = answering({
    'worktree.discardHunk': () => ({
      worktreeId,
      path: 'src/math.ts',
      outcome: 'hunk',
      discardedAt: 1,
      trashId: 'w/2'
    }),
    'worktree.undoDiscard': () => ({ restored: true })
  })

  await store.discardChange(worktreeId, 'src/math.ts', hunk)

  const notice = useWorkspaceStore.getState().notices.at(-1)!
  expect(notice.text).toBe('Discarded hunk')
  expect(notice.action).toEqual({ label: 'Undo', undo: { kind: 'discard', worktreeId, trashId: 'w/2' } })

  await store.undo({ kind: 'discard', worktreeId, trashId: 'w/2' })
  expect(call.mock.calls.find(([method]) => method === 'worktree.undoDiscard')?.[1]).toEqual({
    worktreeId,
    trashId: 'w/2'
  })
  call.mockRestore()
})

it('reopens the last closed pane with ⌘⇧T under the id and name it had', async () => {
  const store = useWorkspaceStore.getState()
  await store.bootstrap()
  const worktreeId = useWorkspaceStore.getState().activeWorktreeId!
  await store.openWorktree(worktreeId)
  const terminalId = collectTerminalIds(useWorkspaceStore.getState().layouts[worktreeId]!.root)[0]!
  const closedTerminal: Terminal = {
    ...useWorkspaceStore.getState().terminals[terminalId]!,
    label: 'Add a sub function'
  }
  const closed: ClosedPane[] = [
    { terminalId, worktreeId, agent: 'claude', label: 'Add a sub function', resumable: true, closedAt: 1 }
  ]
  let reopened = false
  const call = answering({
    'terminal.closed': () => (reopened ? [] : closed),
    'terminal.reopen': () => {
      reopened = true
      return closedTerminal
    }
  })

  await store.forceCloseTerminal(terminalId)
  expect(useWorkspaceStore.getState().closedPanes[worktreeId]).toEqual(closed)

  // The seeded runtime opens with a teammate's keystrokes waiting, which holds every command back.
  useWorkspaceStore.setState({ consent: {} })
  runWorkspaceCommand('reopen-closed-pane', useWorkspaceStore.getState())
  await vi.waitFor(() => expect(useWorkspaceStore.getState().terminals[terminalId]?.label).toBe('Add a sub function'))

  const asked = call.mock.calls.find(([method]) => method === 'terminal.reopen')?.[1] as { terminalId?: string }
  expect(asked.terminalId).toBe(terminalId)
  await vi.waitFor(() => expect(useWorkspaceStore.getState().closedPanes[worktreeId]).toEqual([]))
  call.mockRestore()
})
