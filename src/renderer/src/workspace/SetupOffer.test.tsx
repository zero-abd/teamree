/** @vitest-environment jsdom */

// The setup command read off a lockfile: offered once per project, saved only on Use,
// run in a worktree only on Run, never on its own.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Worktree, WorktreeSetupCheck } from '@shared/entities'

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
const { SetupOffer } = await import('./SetupOffer')
const { setupOfferFor } = await import('./setupOfferModel')

const INITIAL = useWorkspaceStore.getState()

const project = (overrides: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'pager',
  path: '/repos/pager',
  baseRef: 'origin/main',
  suggestedSetup: 'npm ci',
  ...overrides
})

const worktree = (overrides: Partial<Worktree> = {}): Worktree => ({
  id: 'w1',
  projectId: 'p1',
  name: 'Rewrite the pager',
  branch: 'rewrite-the-pager',
  path: '/repos/pager-wt/rewrite',
  startedFrom: 'origin/main',
  state: 'ready',
  createdAt: 0,
  ...overrides
})

function answering(check: WorktreeSetupCheck): void {
  call.mockImplementation((method: string, params: { projectId?: string; setupCommand?: string }) => {
    if (method === 'worktree.setupCheck') return Promise.resolve(check)
    if (method === 'project.setPaths') return Promise.resolve(project({ setupCommand: params.setupCommand }))
    if (method === 'worktree.runSetup') return Promise.resolve(worktree({ setupTerminalId: 't_setup' }))
    return new Promise(() => {})
  })
}

const methods = (): string[] => call.mock.calls.map(([method]) => method as string)

beforeEach(() => {
  useWorkspaceStore.setState(INITIAL, true)
  window.localStorage.clear()
  call.mockReset()
})
afterEach(cleanup)

describe('setupOfferFor', () => {
  const base = { check: {}, dismissed: false, skipped: false }

  it('offers the project a suggestion while no command applies', () => {
    expect(setupOfferFor({ ...base, project: project(), worktree: worktree() })).toEqual({
      kind: 'project',
      command: 'npm ci'
    })
    expect(setupOfferFor({ ...base, project: project(), worktree: worktree(), dismissed: true })).toBeNull()
    expect(setupOfferFor({ ...base, project: project({ suggestedSetup: undefined }), worktree: worktree() })).toBeNull()
  })

  it('offers a worktree that lacks what the command installs, with the project’s own command first', () => {
    const check = { command: 'npm ci', missing: 'node_modules' }
    const saved = project({ setupCommand: 'make deps', suggestedSetup: undefined })
    expect(setupOfferFor({ ...base, check, project: saved, worktree: worktree() })).toEqual({
      kind: 'worktree',
      command: 'make deps',
      missing: 'node_modules'
    })
    expect(setupOfferFor({ ...base, check, project: saved, worktree: worktree(), skipped: true })).toBeNull()
    // Setup already started there, or a teammate's command is waiting on Run: nothing more to offer.
    expect(setupOfferFor({ ...base, check, project: saved, worktree: worktree({ setupTerminalId: 't1' }) })).toBeNull()
    expect(setupOfferFor({ ...base, check, project: saved, worktree: worktree({ setupAsk: 'npm ci' }) })).toBeNull()
  })
})

describe('SetupOffer', () => {
  it('saves the suggestion on Use, and runs nothing', async () => {
    answering({ command: 'npm ci' })
    render(<SetupOffer project={project()} worktree={worktree()} />)
    await act(async () => {})

    expect(screen.getByText('npm ci').tagName).toBe('CODE')
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Use', 'Edit…', 'Not now'])
    expect(document.body.textContent).not.toMatch(/\.\s|\?/)

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Use' })))
    expect(call).toHaveBeenCalledWith('project.setPaths', { projectId: 'p1', setupCommand: 'npm ci' })
    expect(methods()).not.toContain('worktree.runSetup')
    expect(methods()).not.toContain('terminal.create')
  })

  it('saves an edited command', async () => {
    answering({ command: 'npm ci' })
    render(<SetupOffer project={project()} worktree={worktree()} />)
    await act(async () => {})

    fireEvent.click(screen.getByRole('button', { name: 'Edit…' }))
    const field = screen.getByRole('textbox', { name: 'Setup command' })
    expect((field as HTMLInputElement).value).toBe('npm ci')
    fireEvent.change(field, { target: { value: 'npm ci --ignore-scripts' } })
    await act(async () => fireEvent.keyDown(field, { key: 'Enter' }))

    expect(call).toHaveBeenCalledWith('project.setPaths', { projectId: 'p1', setupCommand: 'npm ci --ignore-scripts' })
    expect(methods()).not.toContain('worktree.runSetup')
  })

  it('asks once per project: Not now is remembered', async () => {
    answering({ command: 'npm ci' })
    const { unmount } = render(<SetupOffer project={project()} worktree={worktree()} />)
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.queryByRole('button')).toBeNull()
    unmount()

    render(<SetupOffer project={project()} worktree={worktree({ id: 'w2' })} />)
    await act(async () => {})
    expect(screen.queryByRole('button')).toBeNull()
    expect(methods()).not.toContain('project.setPaths')
  })

  it('runs the command in a worktree that lacks its dependencies only on Run', async () => {
    answering({ command: 'npm ci', missing: 'node_modules' })
    render(
      <SetupOffer project={project({ setupCommand: 'npm ci', suggestedSetup: undefined })} worktree={worktree()} />
    )
    await act(async () => {})

    expect(screen.getByText('no node_modules')).toBeTruthy()
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Run', 'Not now'])
    expect(methods()).toEqual(['worktree.setupCheck'])

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Run' })))
    expect(call).toHaveBeenCalledWith('worktree.runSetup', { worktreeId: 'w1', command: 'npm ci' })
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('offers nothing to a worktree that has its dependencies and a project that has a command', async () => {
    answering({ command: 'npm ci' })
    render(
      <SetupOffer project={project({ setupCommand: 'npm ci', suggestedSetup: undefined })} worktree={worktree()} />
    )
    await act(async () => {})
    expect(screen.queryByRole('button')).toBeNull()
  })
})
