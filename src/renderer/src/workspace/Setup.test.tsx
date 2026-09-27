/** @vitest-environment jsdom */

// The first-run rows through the in-memory runtime: what was found, the default agent kept, and the
// same rows again from Help.

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../runtimeClient/currentRuntimeClient', async () => {
  const { createSeededRuntimeClient } = await import('../runtimeClient/seededRuntimeClient')
  return { runtimeClient: createSeededRuntimeClient() }
})

const { runtimeClient } = await import('../runtimeClient/currentRuntimeClient')
const { useWorkspaceStore } = await import('../state/workspaceStore')
const { readStoredDefaultAgent } = await import('../state/preferences')
const { resolvePlatformModifier } = await import('../keyboard/platformModifier')
const { Welcome } = await import('./Welcome')
const { SetupDialog } = await import('./SetupDialog')
const { HelpView } = await import('../help/HelpView')

const INITIAL = useWorkspaceStore.getState()
const MAC = resolvePlatformModifier('darwin')

function bridge(result: string) {
  const bridge = {
    platform: 'darwin',
    homeDir: '/Users/ana',
    notices: { test: vi.fn(async () => result), openSettings: vi.fn() },
    chooseFolder: vi.fn(async () => '/Users/ana/new-thing')
  }
  ;(window as unknown as { teamree: unknown }).teamree = bridge
  return bridge
}

function row(id: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-setup="${id}"]`)
  if (!found) throw new Error(`no ${id} row`)
  return found
}

beforeEach(() => {
  window.localStorage.clear()
  useWorkspaceStore.setState({ ...INITIAL, projects: [], agents: [], agentsProbed: false, cli: null }, true)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (window as unknown as { teamree?: unknown }).teamree
})

describe('the welcome’s setup rows', () => {
  it('shows the agents found with their versions, and the ways to a project first', async () => {
    bridge('sent')
    render(<Welcome modifier={MAC} project={undefined} />)

    const agents = row('agents')
    expect(await within(agents).findByText('Claude Code 2.1.3')).toBeTruthy()
    expect(within(agents).getByText('Codex 0.40.0')).toBeTruthy()
    expect(agents.dataset.state).toBe('done')

    const actions = [...document.querySelectorAll('.welcome__actions .button')].map((button) => button.textContent)
    expect(actions).toEqual(['New Project…', 'Open Folder…', 'Clone Repository…', 'Join a Team…'])
    // The buttons above are the project row; it is not said twice.
    expect(document.querySelector('[data-setup="project"]')).toBeNull()
  })

  it('keeps the default agent chosen here', async () => {
    bridge('sent')
    render(<Welcome modifier={MAC} project={undefined} />)
    const picker = await screen.findByLabelText('Default agent')

    fireEvent.change(picker, { target: { value: 'codex' } })

    expect(useWorkspaceStore.getState().defaultAgent).toBe('codex')
    expect(readStoredDefaultAgent(window.localStorage)).toBe('codex')
  })

  it('turns the notification row to needs-action when the system blocks the test', async () => {
    const teamree = bridge('blocked')
    render(<Welcome modifier={MAC} project={undefined} />)
    const notices = row('notifications')
    expect(notices.dataset.state).toBe('done')

    fireEvent.click(within(notices).getByRole('button', { name: 'Send Test' }))

    expect(await within(notices).findByText('Blocked by macOS')).toBeTruthy()
    expect(notices.dataset.state).toBe('todo')
    fireEvent.click(within(notices).getByRole('button', { name: 'Open Settings' }))
    expect(teamree.notices.openSettings).toHaveBeenCalledOnce()
  })

  it('makes a new project: a folder, then git init, then the project', async () => {
    const teamree = bridge('sent')
    const call = vi.spyOn(runtimeClient, 'call')
    render(<Welcome modifier={MAC} project={undefined} />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New Project…' }))
    })

    expect(teamree.chooseFolder).toHaveBeenCalledWith('/Users/ana')
    expect(call).toHaveBeenCalledWith('project.add', { path: '/Users/ana/new-thing', init: true })
    await vi.waitFor(() =>
      expect(useWorkspaceStore.getState().projects.map((each) => each.name)).toEqual(['new-thing'])
    )
  })
})

describe('Setup…', () => {
  it('opens from Help, with every row including projects', async () => {
    bridge('sent')
    render(<HelpView modifier={MAC} />)

    fireEvent.click(screen.getByRole('button', { name: 'Setup…' }))
    expect(useWorkspaceStore.getState().dialog).toEqual({ kind: 'setup' })

    cleanup()
    useWorkspaceStore.setState({ projects: [{ id: 'p1', name: 'pager', path: '/repos/pager', baseRef: 'main' }] })
    render(<SetupDialog />)
    expect(await within(row('agents')).findByText('Codex 0.40.0')).toBeTruthy()
    expect(row('project').dataset.state).toBe('done')
    expect(within(row('project')).getByText('pager')).toBeTruthy()
    expect(screen.getByRole('dialog', { name: 'Setup' })).toBeTruthy()
  })
})
