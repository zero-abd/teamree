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
const { SavedCommandDialog } = await import('./SavedCommandDialog')

const INITIAL = useWorkspaceStore.getState()
const SAVED_INITIAL = useSavedCommandsStore.getState()

const lint: SavedCommand = { id: 'c1', label: 'Lint', text: 'npm run lint', kind: 'shell', where: 'new' }
const fetch: SavedCommand = { id: 'g1', label: 'Fetch', text: 'git fetch', kind: 'shell', where: 'current' }
const project: Project = { id: 'p1', name: 'shop', path: '/repos/shop', baseRef: 'origin/main', savedCommands: [lint] }

const calls = (method: string): unknown[] => call.mock.calls.filter(([name]) => name === method).map(([, p]) => p)

function field(name: string): HTMLInputElement {
  return screen.getByLabelText(name)
}

beforeEach(() => {
  useWorkspaceStore.setState(INITIAL, true)
  useWorkspaceStore.setState({
    projects: [project],
    agents: [{ kind: 'claude', command: 'claude', binary: '/bin/claude' }],
    dialog: { kind: 'saved-command', projectId: 'p1' }
  })
  useSavedCommandsStore.setState({ ...SAVED_INITIAL, everywhere: [fetch] })
  call.mockReset()
  call.mockImplementation((method: string, params: Record<string, unknown>) => {
    if (method === 'project.setPaths') return Promise.resolve({ ...project, savedCommands: params.savedCommands })
    if (method === 'settings.set') return Promise.resolve({ savedCommands: params.savedCommands })
    return new Promise(() => {})
  })
})
afterEach(cleanup)

describe('SavedCommandDialog', () => {
  it('adds a command to the end of this project’s list and closes', async () => {
    render(<SavedCommandDialog projectId="p1" />)
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(field('Label'), { target: { value: ' Types ' } })
    fireEvent.change(field('Command'), { target: { value: 'npm run typecheck' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })))

    expect(calls('project.setPaths')).toEqual([
      {
        projectId: 'p1',
        savedCommands: [
          lint,
          { id: expect.any(String), label: 'Types', text: 'npm run typecheck', kind: 'shell', where: 'new' }
        ]
      }
    ])
    expect(useWorkspaceStore.getState().dialog).toBeNull()
  })

  it('adds a prompt for a chosen agent to every project’s list', async () => {
    render(<SavedCommandDialog projectId="p1" />)
    fireEvent.change(field('Label'), { target: { value: 'Review' } })
    fireEvent.change(field('Kind'), { target: { value: 'agent' } })
    fireEvent.change(field('Prompt'), { target: { value: 'Review the diff' } })
    fireEvent.change(field('Where'), { target: { value: 'new' } })
    fireEvent.change(field('Agent'), { target: { value: 'claude' } })
    fireEvent.change(field('For'), { target: { value: 'everywhere' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })))

    expect(calls('settings.set')).toEqual([
      {
        savedCommands: [
          fetch,
          {
            id: expect.any(String),
            label: 'Review',
            text: 'Review the diff',
            kind: 'agent',
            where: 'new',
            agent: 'claude'
          }
        ]
      }
    ])
    expect(calls('project.setPaths')).toEqual([])
  })

  it('edits one in place, and moves it when its scope changes', async () => {
    render(<SavedCommandDialog projectId="p1" commandId="c1" />)
    expect(field('Label').value).toBe('Lint')
    fireEvent.change(field('Label'), { target: { value: 'Lint all' } })
    fireEvent.change(field('For'), { target: { value: 'everywhere' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })))

    expect(calls('project.setPaths')).toEqual([{ projectId: 'p1', savedCommands: [] }])
    expect(calls('settings.set')).toEqual([{ savedCommands: [fetch, { ...lint, label: 'Lint all' }] }])
  })

  it('deletes one', async () => {
    render(<SavedCommandDialog commandId="g1" />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Delete' })))
    expect(calls('settings.set')).toEqual([{ savedCommands: [] }])
  })
})
