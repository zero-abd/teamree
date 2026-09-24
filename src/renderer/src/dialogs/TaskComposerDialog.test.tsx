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

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

/** Opens the dialog and settles the refs listing that prefills the picker. */
async function open(projectId = 'p1'): Promise<void> {
  render(<TaskComposerDialog projectId={projectId} />)
  // The stubbed listing is already resolved by the time the effect subscribes
  // to it, so one act tick flushes both it and the effect that prefills the
  // picker. Waiting on that rather than on a deadline keeps the helper honest
  // on a cold machine: `waitFor`'s one-second default was close enough to the
  // first assertion's warm-up cost that whichever test ran first lost the race.
  await act(async () => {})
  expect(startPoint().value.length).toBeGreaterThan(0)
}

// The label wraps its hint as well as its caption, so the accessible name is
// "Task" plus that hint rather than "Task" alone; see the note in the report.
const task = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: /^Task/ })
const startPoint = (): HTMLInputElement => screen.getByRole('combobox', { name: 'Start from' })
const submit = (): HTMLButtonElement => screen.getByRole('button', { name: /Start Task|Create Worktree/ })
const more = (command: string): HTMLButtonElement => screen.getByRole('button', { name: `One more ${command}` })
const fewer = (command: string): HTMLButtonElement => screen.getByRole('button', { name: `One fewer ${command}` })
const bothAgents = [
  { kind: 'claude', command: 'claude', binary: '/usr/local/bin/claude' },
  { kind: 'codex', command: 'codex', binary: '/opt/bin/codex' }
]

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
    const dialog = screen.getByRole('dialog', { name: 'New Task' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect((screen.getByRole('combobox', { name: 'Project' }) as HTMLSelectElement).value).toBe('p1')
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

describe('how it reads', () => {
  it('names each agent beside its mark, with the stepper after the name', async () => {
    seed({ agents: bothAgents })
    await open()
    const rows = [...document.querySelectorAll<HTMLElement>('.agents__row')]
    expect(rows).toHaveLength(2)
    rows.forEach((row, index) => {
      const name = within(row).getByText(['Claude Code', 'Codex'][index] ?? '', { selector: 'span' })
      const minus = within(row).getAllByRole('button')[0] as HTMLElement
      expect(name.compareDocumentPosition(minus)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    })
    expect(fewer('Codex').disabled).toBe(true)
  })

  // Project is the app's one select, the same as Settings'; Start from shares its chevron.
  it('draws Project as the app’s select and Start from with the same chevron, mono only for the ref', async () => {
    await open()
    const pickers = [screen.getByRole('combobox', { name: 'Project' }), startPoint()]
    const chevrons = pickers.map((control) => control.parentElement?.querySelector('svg path')?.getAttribute('d'))
    expect(chevrons[0]).toBeTruthy()
    expect(chevrons[1]).toBe(chevrons[0])
    expect(pickers[0]?.className).toBe('select__input')
    expect(pickers[1]?.classList.contains('picker__input--ref')).toBe(true)
  })

  it('previews the branch as a fragment', async () => {
    await open()
    fireEvent.change(task(), { target: { value: 'Rewrite the pager' } })
    const preview = document.getElementById(startPoint().getAttribute('aria-describedby') ?? '')
    expect(preview?.textContent).toBe('new branch rewrite-the-pager from origin/main @ originm')
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

// Settings lets somebody say where this project's branches start, and the only
// place that answer can show up is the box below. It is a default and not a
// rule: it fills the field and the field is still a field.
describe('the start point somebody set in settings', () => {
  it('fills the box instead of the repository’s base ref', async () => {
    seed({ startPointDefaults: { p1: 'feature/pager' } })
    await open()
    expect(startPoint().value).toBe('feature/pager')
  })

  it('belongs to the project it was set for, and does not follow a switch', async () => {
    seed({ startPointDefaults: { p1: 'feature/pager' } })
    await open()
    fireEvent.change(screen.getByRole('combobox', { name: 'Project' }), { target: { value: 'p2' } })
    await waitFor(() => expect(startPoint().value).toBe('origin/trunk'))
  })

  // Typed in the box, not stored: a preference that could not be overruled for
  // one task would send people to settings and back to start one branch
  // somewhere else.
  it('is still only a default, and what is typed over it is what is submitted', async () => {
    seed({ startPointDefaults: { p1: 'feature/pager' } })
    await open()
    fireEvent.change(task(), { target: { value: 'Rewrite the pager' } })
    fireEvent.change(startPoint(), { target: { value: 'origin/main' } })
    submit().click()
    expect(startTask).toHaveBeenCalledWith(expect.objectContaining({ startedFrom: 'origin/main' }))
  })

  // A ref that has been deleted since, or one the runtime's cap dropped, is
  // still what this person asked for. It goes in the box as text and git gets
  // the last word, which is a better answer than silently branching from
  // somewhere they did not choose.
  it('offers a ref the listing does not carry, rather than falling back to the base', async () => {
    seed({ startPointDefaults: { p1: 'origin/gone-last-tuesday' } })
    await open()
    expect(startPoint().value).toBe('origin/gone-last-tuesday')
  })
})

describe('what it submits', () => {
  it('carries the task, the project and the ref the picker settled on', async () => {
    await open()
    fireEvent.change(task(), { target: { value: 'Rewrite the pager' } })
    submit().click()
    expect(startTask).toHaveBeenCalledWith({
      projectId: 'p1',
      startedFrom: 'origin/main',
      creates: [{ name: 'Rewrite the pager', agentCommand: 'claude', task: 'Rewrite the pager' }]
    })
  })

  // The opportunity the whole dialog exists for: one description, several
  // attempts, told apart before anything is created.
  it('submits one create per agent asked for, in the order they will be made', async () => {
    seed({ agents: bothAgents })
    await open()
    fireEvent.change(task(), { target: { value: 'Rewrite the pager' } })
    fireEvent.click(more('Claude Code'))
    fireEvent.click(more('Codex'))
    expect(screen.getByText('3 worktrees · claude, codex, claude')).toBeTruthy()
    submit().click()
    expect(startTask).toHaveBeenCalledWith({
      projectId: 'p1',
      startedFrom: 'origin/main',
      creates: [
        { name: 'Rewrite the pager claude', agentCommand: 'claude', task: 'Rewrite the pager' },
        { name: 'Rewrite the pager codex', agentCommand: 'codex', task: 'Rewrite the pager' },
        { name: 'Rewrite the pager claude 2', agentCommand: 'claude', task: 'Rewrite the pager' }
      ]
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
  // machine with no agent on PATH "Start Task" would be one the user only
  // discovers was false afterwards.
  it('promises only a worktree when no agent will run, and omits the command', async () => {
    seed({ agents: [] })
    await open()
    fireEvent.change(task(), { target: { value: 'Rewrite the pager' } })
    expect(screen.getByRole('button', { name: 'Create Worktree' })).toBeTruthy()
    expect(screen.getByText('No coding agent on your login shell’s PATH')).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'Agents' })).toBeNull()
    submit().click()
    expect(startTask).toHaveBeenCalledWith({
      projectId: 'p1',
      startedFrom: 'origin/main',
      creates: [{ name: 'Rewrite the pager', task: 'Rewrite the pager' }]
    })
  })

  // The text goes on one command line, so past that line's bound the button
  // refuses rather than the runtime cutting or rejecting it later.
  it('refuses a task too long for one command line, and says by how much', async () => {
    await open()
    fireEvent.change(task(), { target: { value: 'x'.repeat(4097) } })
    expect((screen.getByRole('button', { name: 'Start Task' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/4097 \/ 4096 chars/)).toBeTruthy()
    expect(startTask).not.toHaveBeenCalled()
  })

  it('does not say the machine has no agent before it has looked', async () => {
    seed({ agents: [], agentsProbed: false })
    await open()
    expect(screen.getByText('Looking for coding agents…')).toBeTruthy()
  })

  it('drops the agent when the user steps it back to none', async () => {
    await open()
    fireEvent.change(task(), { target: { value: 'Rewrite the pager' } })
    fireEvent.click(fewer('Claude Code'))
    expect(screen.getByText('1 worktree · no agent')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Create Worktree' })).toBeTruthy()
    submit().click()
    expect(startTask.mock.calls[0]?.[0].creates).toEqual([{ name: 'Rewrite the pager', task: 'Rewrite the pager' }])
  })

  it('shows the branch the task will get, and only once there is a task', async () => {
    await open()
    expect(screen.queryByText(/^branch/)).toBeNull()
    fireEvent.change(task(), { target: { value: 'Rewrite the pager so it streams' } })
    // Once, in the line that says what will be branched from where.
    const name = screen.getByText('rewrite-the-pager-so-it-streams')
    expect(name.closest('.field--task')).toBeNull()
    expect(document.getElementById(startPoint().getAttribute('aria-describedby') ?? '')?.contains(name)).toBe(true)
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
