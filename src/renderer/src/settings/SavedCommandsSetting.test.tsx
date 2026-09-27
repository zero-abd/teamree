/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, SavedCommand } from '@shared/entities'

const call = vi.fn()
vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: (...args: unknown[]) => call(...args),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { useSavedCommandsStore } = await import('../state/savedCommandsStore')
const { SavedCommandsSetting } = await import('./SavedCommandsSetting')

const INITIAL = useWorkspaceStore.getState()
const SAVED_INITIAL = useSavedCommandsStore.getState()

const lint: SavedCommand = { id: 'c1', label: 'Lint', text: 'npm run lint', kind: 'shell', where: 'new' }
const review: SavedCommand = { id: 'c2', label: 'Review', text: 'Review the diff', kind: 'agent', where: 'current' }
const migrate: SavedCommand = { id: 'r1', label: 'Migrate', text: 'npm run db:migrate', kind: 'shell', where: 'new' }
const fetch: SavedCommand = { id: 'g1', label: 'Fetch', text: 'git fetch', kind: 'shell', where: 'current' }
const project: Project = {
  id: 'p1',
  name: 'shop',
  path: '/repos/shop',
  baseRef: 'origin/main',
  savedCommands: [lint, review],
  repository: { savedCommands: [migrate] }
}

const calls = (method: string): unknown[] => call.mock.calls.filter(([name]) => name === method).map(([, p]) => p)

beforeEach(() => {
  useWorkspaceStore.setState(INITIAL, true)
  useWorkspaceStore.setState({ projects: [project] })
  useSavedCommandsStore.setState({ ...SAVED_INITIAL, everywhere: [fetch, lint] })
  call.mockReset()
  call.mockImplementation((method: string, params: Record<string, unknown>) => {
    if (method === 'project.setPaths') return Promise.resolve({ ...project, savedCommands: params.savedCommands })
    if (method === 'settings.set') return Promise.resolve({ savedCommands: params.savedCommands })
    return new Promise(() => {})
  })
})
afterEach(cleanup)

describe('SavedCommandsSetting', () => {
  it('lists this project’s and the repository’s; reorders and deletes only its own', async () => {
    render(<SavedCommandsSetting project={project} />)
    expect(screen.getAllByRole('listitem').map((row) => row.textContent)).toEqual([
      expect.stringContaining('Lint'),
      expect.stringContaining('Review'),
      expect.stringContaining('Migrate')
    ])
    expect(screen.queryByRole('button', { name: 'Delete Migrate' })).toBeNull()

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Move Lint down' })))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Delete Review' })))
    expect(calls('project.setPaths')).toEqual([
      { projectId: 'p1', savedCommands: [review, lint] },
      { projectId: 'p1', savedCommands: [lint] }
    ])
  })

  it('keeps every project’s list the same way, and opens the sheet to add or edit', async () => {
    render(<SavedCommandsSetting />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Move Lint up' })))
    expect(calls('settings.set')).toEqual([{ savedCommands: [lint, fetch] }])

    fireEvent.click(screen.getByRole('button', { name: 'Edit Fetch' }))
    expect(useWorkspaceStore.getState().dialog).toEqual({ kind: 'saved-command', commandId: 'g1' })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(useWorkspaceStore.getState().dialog).toEqual({ kind: 'saved-command' })
  })
})
