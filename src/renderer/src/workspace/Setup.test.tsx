/** @vitest-environment jsdom */

// The first-run setup line through the in-memory runtime, and the full rows from Help: what was found,
// the default agent kept.

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

describe('the welcome’s setup line', () => {
  it('names what works in one quiet line, and gives a row only to what needs action', async () => {
    bridge('sent')
    render(<Welcome modifier={MAC} project={undefined} />)

    const line = document.querySelector('.welcome__status') as HTMLElement
    expect(await within(line).findByText('Claude Code')).toBeTruthy()
    expect(within(line).getByText('Codex')).toBeTruthy()
    expect(within(line).getByText('Notifications')).toBeTruthy()
    // The seeded CLI is not on PATH: that one is a row, with its button.
    expect(await within(row('cli')).findByRole('button', { name: 'Install…' })).toBeTruthy()
    expect(document.querySelector('[data-setup="agents"]')).toBeNull()
    expect(document.querySelector('[data-setup="notifications"]')).toBeNull()
    expect(document.querySelector('[data-setup="project"]')).toBeNull()
    expect(screen.queryByLabelText('Default agent')).toBeNull()

    fireEvent.click(within(line).getByRole('button', { name: 'Setup…' }))
    expect(useWorkspaceStore.getState().dialog).toEqual({ kind: 'setup' })
  })

  it('turns notifications back on from their row when they are off', async () => {
    bridge('sent')
    useWorkspaceStore.getState().setAgentNotices('off')
    render(<Welcome modifier={MAC} project={undefined} />)
    const notices = row('notifications')

    fireEvent.click(within(notices).getByRole('button', { name: 'Turn On' }))

    expect(useWorkspaceStore.getState().agentNotices).toBe('notify')
    expect(document.querySelector('[data-setup="notifications"]')).toBeNull()
    expect(within(document.querySelector('.welcome__status') as HTMLElement).getByText('Notifications')).toBeTruthy()
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

  it('keeps the default agent chosen there', async () => {
    bridge('sent')
    render(<SetupDialog />)
    const picker = await screen.findByLabelText('Default agent')

    fireEvent.change(picker, { target: { value: 'codex' } })

    expect(useWorkspaceStore.getState().defaultAgent).toBe('codex')
    expect(readStoredDefaultAgent(window.localStorage)).toBe('codex')
  })

  it('turns the notification row to needs-action when the system blocks the test', async () => {
    const teamree = bridge('blocked')
    render(<SetupDialog />)
    const notices = row('notifications')
    expect(notices.dataset.state).toBe('done')

    fireEvent.click(within(notices).getByRole('button', { name: 'Send Test' }))

    expect(await within(notices).findByText('Blocked by macOS')).toBeTruthy()
    expect(notices.dataset.state).toBe('todo')
    fireEvent.click(within(notices).getByRole('button', { name: 'Open Settings' }))
    expect(teamree.notices.openSettings).toHaveBeenCalledOnce()
  })
})
