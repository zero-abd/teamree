/** @vitest-environment jsdom */

// Creating a worktree: the one dialog that starts real work.
//
// Its pure parts are covered elsewhere — the branch slug, the footer's wording,
// which agent is preselected. What is only true of the assembled dialog is
// everything this file asks about: that the submitted draft carries the ref the
// picker actually settled on, that the field somebody finishes in submits,
// that Escape reaches the innermost open thing rather than throwing the whole
// dialog away, and that switching project does not leave the old repository's
// base ref pointing at a branch the new one has never heard of.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StartPoint, StartPointList } from '@shared/entities'

const call = vi.fn<(method: string, params: unknown) => Promise<unknown>>()

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: (method: string, params: unknown) => call(method, params),
    watchPane: () => new Promise(() => {}),
    subscribeTerminal: () => new Promise(() => {}),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { TaskComposerDialog } = await import('./TaskComposerDialog')

const INITIAL = useWorkspaceStore.getState()

const point = (ref: string, overrides: Partial<StartPoint> = {}): StartPoint => ({
  ref,
  kind: 'remoteBranch',
  sha: `${ref.replace(/\W/g, '')}${'0'.repeat(40)}`.slice(0, 40),
  shortSha: `${ref.replace(/\W/g, '')}${'0'.repeat(7)}`.slice(0, 7),
  refName: ref,
  isBase: false,
  isCurrent: false,
  updatedAt: 0,
  ...overrides
})

const listFor = (projectId: string): StartPointList =>
  projectId === 'p1'
    ? {
        baseRef: 'origin/main',
        options: [point('origin/main', { isBase: true }), point('feature/pager', { kind: 'localBranch' })],
        total: 2,
        limit: 50,
        truncated: false
      }
    : {
        baseRef: 'origin/trunk',
        options: [point('origin/trunk', { isBase: true })],
        total: 1,
        limit: 50,
        truncated: false
      }

const startTask = vi.fn()
const closeDialog = vi.fn()

function seed(overrides: Record<string, unknown> = {}): void {
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      projects: [
        { id: 'p1', name: 'pager', path: '/repos/pager', baseRef: 'origin/main' },
        { id: 'p2', name: 'relay', path: '/repos/relay', baseRef: 'origin/trunk' }
      ],
      agents: [{ kind: 'claude', command: 'claude', binary: '/usr/local/bin/claude' }],
      agentsProbed: true,
      startTask,
      closeDialog,
      ...overrides
    },
    true
  )
}

/** Opens the dialog and waits for the refs listing that prefills the picker. */
async function open(projectId = 'p1'): Promise<void> {
  render(<TaskComposerDialog projectId={projectId} />)
  await waitFor(() => expect(startPoint().value.length).toBeGreaterThan(0))
}

// The label wraps its hint as well as its caption, so the accessible name is
// "Task" plus that hint rather than "Task" alone; see the note in the report.
const task = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: /^Task/ })
const startPoint = (): HTMLInputElement => screen.getByRole('combobox', { name: 'Start from' })
const submit = (): HTMLButtonElement => screen.getByRole('button', { name: /Start task|Create worktree/ })

beforeEach(() => {
  call.mockReset()
  call.mockImplementation(async (method, params) => {
    if (method !== 'worktree.startPoints') throw new Error(`unexpected ${method}`)
    return listFor((params as { projectId: string }).projectId)
  })
  startTask.mockReset()
  closeDialog.mockReset()
  seed()
})

describe('the dialog itself', () => {
  it('is a modal named for what it does, under the project it will act on', async () => {
    await open()
    const dialog = screen.getByRole('dialog', { name: 'New task' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.querySelector('.modal__description')?.textContent).toBe('pager')
  })

  it('puts the cursor in the field the user has to think about', async () => {
    await open()
    expect(document.activeElement).toBe(task())
  })

  it('renders nothing at all for a project that is no longer there', () => {
    render(<TaskComposerDialog projectId="gone" />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('what it will not submit', () => {
  it('refuses an empty task, however good the start point is', async () => {
    await open()
    expect(submit().disabled).toBe(true)
  })

  it('refuses a task made only of spaces', async () => {
    await open()
    fireEvent.change(task(), { target: { value: '   ' } })
    expect(submit().disabled).toBe(true)
  })

  // Switching project clears the ref on purpose — the old repository's base ref
  // has no meaning in the new one — and until the new listing lands there is
  // nothing to branch from, so the button has to say so.
  it('refuses a task with no start point, after the project changed under it', async () => {
    await open()
    fireEvent.change(task(), { target: { value: 'Rewrite the pager' } })
    expect(submit().disabled).toBe(false)
    call.mockImplementation(() => new Promise(() => {}))
    fireEvent.change(screen.getByRole('combobox', { name: 'Project' }), { target: { value: 'p2' } })
    expect(startPoint().value).toBe('')
    expect(submit().disabled).toBe(true)
  })

  it('takes the new project’s own base ref once its listing lands', async () => {
    await open()
    fireEvent.change(screen.getByRole('combobox', { name: 'Project' }), { target: { value: 'p2' } })
    await waitFor(() => expect(startPoint().value).toBe('origin/trunk'))
  })
})

describe('what it submits', () => {
  it('carries the task, the project and the ref the picker settled on', async () => {
    await open()
    fireEvent.change(task(), { target: { value: 'Rewrite the pager' } })
    submit().click()
    expect(startTask).toHaveBeenCalledWith({
      projectId: 'p1',
      task: 'Rewrite the pager',
      startedFrom: 'origin/main',
      agentCommand: 'claude'
    })
  })

  it('carries a ref picked by hand rather than the base it defaulted to', async () => {
    await open()
    fireEvent.change(task(), { target: { value: 'Rewrite the pager' } })
    fireEvent.keyDown(startPoint(), { key: 'ArrowDown' })
    fireEvent.keyDown(startPoint(), { key: 'ArrowDown' })
    fireEvent.keyDown(startPoint(), { key: 'Enter' })
    submit().click()
    expect(startTask).toHaveBeenCalledWith(expect.objectContaining({ startedFrom: 'feature/pager' }))
  })

  // The claim on the button is a promise about what happens next, and on a
  // machine with no agent on PATH "Start task" would be one the user only
  // discovers was false afterwards.
  it('promises only a worktree when no agent will run, and omits the command', async () => {
    seed({ agents: [] })
    await open()
    fireEvent.change(task(), { target: { value: 'Rewrite the pager' } })
    expect(screen.getByRole('button', { name: 'Create worktree' })).toBeTruthy()
    expect(
      screen.getByText('No coding agent on the PATH your login shell sets, so this creates the worktree alone.')
    ).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Agent' })).toHaveProperty('disabled', true)
    submit().click()
    expect(startTask).toHaveBeenCalledWith({
      projectId: 'p1',
      task: 'Rewrite the pager',
      startedFrom: 'origin/main'
    })
  })

  it('does not say the machine has no agent before it has looked', async () => {
    seed({ agents: [], agentsProbed: false })
    await open()
    expect(screen.getByText('Looking for coding agents…')).toBeTruthy()
  })

  it('drops the agent when the user asks for the worktree alone', async () => {
    await open()
    fireEvent.change(task(), { target: { value: 'Rewrite the pager' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), { target: { value: '' } })
    expect(screen.getByText('Creates the worktree, with no agent in it.')).toBeTruthy()
    submit().click()
    expect(startTask.mock.calls[0]?.[0]).not.toHaveProperty('agentCommand')
  })

  it('shows the branch the task will get, and only once there is a task', async () => {
    await open()
    expect(screen.queryByText(/^branch/)).toBeNull()
    fireEvent.change(task(), { target: { value: 'Rewrite the pager so it streams' } })
    // Beside the field, and again in the line that says what will be branched
    // from where — the two places somebody checks before pressing the button.
    expect(screen.getAllByText('rewrite-the-pager-so-it-streams')).toHaveLength(2)
  })
})

describe('finishing from the keyboard', () => {
  it('submits on Enter, because that is the field people finish in', async () => {
    await open()
    fireEvent.change(task(), { target: { value: 'Rewrite the pager' } })
    fireEvent.keyDown(task(), { key: 'Enter' })
    expect(startTask).toHaveBeenCalledOnce()
  })

  it('leaves Shift+Enter to write a second paragraph', async () => {
    await open()
    fireEvent.change(task(), { target: { value: 'Rewrite the pager' } })
    expect(fireEvent.keyDown(task(), { key: 'Enter', shiftKey: true })).toBe(true)
    expect(startTask).not.toHaveBeenCalled()
  })

  it('does not start an empty task on Enter', async () => {
    await open()
    fireEvent.keyDown(task(), { key: 'Enter' })
    expect(startTask).not.toHaveBeenCalled()
  })

  it('closes on Escape, and from Cancel', async () => {
    await open()
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(closeDialog).toHaveBeenCalledOnce()
    screen.getByRole('button', { name: 'Cancel' }).click()
    expect(closeDialog).toHaveBeenCalledTimes(2)
  })

  // Escape has to reach the innermost thing that is open. A popup inside the
  // modal claims it first; losing the whole dialog because a dropdown was open
  // would throw away everything already typed.
  it('closes the open ref list on Escape, and keeps the dialog', async () => {
    await open()
    fireEvent.change(task(), { target: { value: 'Rewrite the pager' } })
    fireEvent.keyDown(startPoint(), { key: 'ArrowDown' })
    expect(screen.getByRole('listbox')).toBeTruthy()

    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(closeDialog).not.toHaveBeenCalled()
    expect(task()).toHaveProperty('value', 'Rewrite the pager')

    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(closeDialog).toHaveBeenCalledOnce()
  })
})
