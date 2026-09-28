/** @vitest-environment jsdom */

// A damaged workspace.json and a failing save are said on screen, each with the one thing to do about it.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceFileProblem } from '@shared/entities'
import type { WorkspaceEvent } from '@shared/methods'

const runtime = vi.hoisted(() => ({
  problems: [] as WorkspaceFileProblem[],
  calls: [] as string[],
  onEvent: undefined as ((event: WorkspaceEvent) => void) | undefined
}))

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: async (method: string) => {
      runtime.calls.push(method)
      if (method === 'workspace.problems') return runtime.problems
      if (method === 'workspace.retrySave') {
        runtime.problems = []
        return { saved: true }
      }
      return new Promise(() => {})
    },
    watchWorkspace: (onEvent: (event: WorkspaceEvent) => void) => {
      runtime.onEvent = onEvent
      return { close: () => {} }
    },
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { StoreProblemCards } = await import('./StoreProblemCards')

const FILE = '/data/workspace.json'
const KEPT = '/data/workspace.json.unreadable-2026-09-28T12-00-00-000Z'

beforeEach(() => {
  runtime.problems = []
  runtime.calls = []
})

afterEach(cleanup)

describe('workspace file notices', () => {
  it('says the workspace came back from its backup, and reveals the damaged file', async () => {
    runtime.problems = [{ kind: 'restored', filePath: FILE, keptAt: KEPT }]
    const revealInFinder = vi.fn(async () => {})
    useWorkspaceStore.setState({ revealInFinder })
    render(<StoreProblemCards />)

    expect(await screen.findByText('Workspace restored from backup')).toBeTruthy()
    expect(screen.getByText('Damaged file kept as workspace.json.unreadable-2026-09-28T12-00-00-000Z')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }))
    expect(revealInFinder).toHaveBeenCalledWith(KEPT, 'the file')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss message' }))
    expect(screen.queryByText('Workspace restored from backup')).toBeNull()
  })

  it('says a file neither it nor its backup could be read, and where it was kept', async () => {
    runtime.problems = [{ kind: 'unreadable', filePath: FILE, keptAt: KEPT }]
    render(<StoreProblemCards />)

    expect(await screen.findByText('workspace.json could not be read')).toBeTruthy()
    expect(screen.getByText('Kept as workspace.json.unreadable-2026-09-28T12-00-00-000Z')).toBeTruthy()
  })

  it('keeps a failed save on screen with Retry until a save lands', async () => {
    render(<StoreProblemCards />)
    await act(async () => {})
    expect(screen.queryByText('Could not save')).toBeNull()

    runtime.problems = [{ kind: 'saveFailed', filePath: FILE, reason: 'ENOSPC', diskFull: true }]
    await act(async () => runtime.onEvent?.({ type: 'workspaceFile' }))
    expect(await screen.findByText('Could not save')).toBeTruthy()
    expect(screen.getByText('Disk full')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Dismiss message' })).toBeNull()

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })))
    expect(runtime.calls).toContain('workspace.retrySave')
    expect(screen.queryByText('Could not save')).toBeNull()
  })
})
