/** @vitest-environment jsdom */

// Saved commands and prompts beside Run Dev and Run Tests: what the menu lists, where each one goes,
// and the question a repository's command gets before it first runs here.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, SavedCommand, Terminal, Worktree } from '@shared/entities'

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
const { SavedCommands } = await import('./SavedCommands')
// Not awaited whole: a new pane then waits on layout reads this mock never answers.
const settled = async (started: Promise<void>): Promise<void> => {
  void started
  await new Promise((resolve) => setTimeout(resolve, 100))
}
const runSavedCommand = (worktreeId: string, id: string): Promise<void> =>
  settled(useSavedCommandsStore.getState().run(worktreeId, id))

const INITIAL = useWorkspaceStore.getState()
const SAVED_INITIAL = useSavedCommandsStore.getState()

const lint: SavedCommand = { id: 'c1', label: 'Lint', text: 'npm run lint', kind: 'shell', where: 'new' }
const status: SavedCommand = { id: 'c2', label: 'Status', text: 'git status', kind: 'shell', where: 'current' }
const review: SavedCommand = { id: 'c3', label: 'Review', text: 'Review the diff', kind: 'agent', where: 'current' }
const tests: SavedCommand = {
  id: 'c4',
  label: 'Tests',
  text: 'Write tests',
  kind: 'agent',
  where: 'new',
  agent: 'codex'
}
const fanOut: SavedCommand = { id: 'c5', label: 'Fan out', text: 'Split the auth module', kind: 'agent', where: 'task' }
const migrate: SavedCommand = { id: 'r1', label: 'Migrate', text: 'npm run db:migrate', kind: 'shell', where: 'new' }

const project: Project = {
  id: 'p1',
  name: 'shop',
  path: '/repos/shop',
  baseRef: 'origin/main',
  savedCommands: [lint, status, review, tests, fanOut],
  repository: { savedCommands: [migrate] }
}

const worktree: Worktree = {
  id: 'w1',
  projectId: 'p1',
  name: 'cart',
  branch: 'cart',
  path: '/repos/shop-wt/cart',
  startedFrom: 'origin/main',
  state: 'ready',
  createdAt: 0
}

const pane = (id: string, extra: Partial<Terminal> = {}): Terminal => ({
  id,
  worktreeId: 'w1',
  title: 'zsh',
  cwd: worktree.path,
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  running: true,
  busy: false,
  lastOutputAt: 0,
  ...extra
})

function seed(terminals: Terminal[] = [], focused: string | null = null): void {
  useWorkspaceStore.setState({
    projects: [project],
    worktrees: [worktree],
    activeWorktreeId: 'w1',
    openWorktreeIds: ['w1'],
    agents: [
      { kind: 'claude', command: 'claude', binary: '/bin/claude' },
      { kind: 'codex', command: 'codex', binary: '/bin/codex' }
    ],
    defaultAgent: 'claude',
    terminals: Object.fromEntries(terminals.map((terminal) => [terminal.id, terminal])),
    layouts: {
      w1: {
        worktreeId: 'w1',
        root: terminals[0] === undefined ? null : { kind: 'leaf', terminalId: terminals[0].id },
        focusedTerminalId: focused
      }
    }
  })
}

const calls = (method: string): unknown[] => call.mock.calls.filter(([name]) => name === method).map(([, p]) => p)

beforeEach(() => {
  useWorkspaceStore.setState(INITIAL, true)
  useSavedCommandsStore.setState({
    ...SAVED_INITIAL,
    everywhere: [{ ...lint, id: 'g1', label: 'Fetch', text: 'git fetch' }]
  })
  call.mockReset()
  call.mockImplementation((method: string, params: Record<string, unknown>) => {
    if (method === 'terminal.create') return Promise.resolve(pane('t_new', { label: params.label as string }))
    if (method === 'terminal.write') return Promise.resolve({ written: true })
    if (method === 'project.setPaths') return Promise.resolve({ ...project, approvedSavedCommands: [migrate.text] })
    return new Promise(() => {})
  })
})
afterEach(cleanup)

describe('SavedCommands', () => {
  it('lists this project’s, the repository’s and every project’s, then New and Edit', async () => {
    seed()
    render(<SavedCommands worktreeId="w1" />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Commands' })))
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      expect.stringContaining('Lint'),
      expect.stringContaining('Status'),
      expect.stringContaining('Review'),
      expect.stringContaining('Tests'),
      expect.stringContaining('Fan out'),
      expect.stringContaining('Migrate'),
      expect.stringContaining('Fetch'),
      'New Command…',
      'Edit Commands…'
    ])

    await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: /Lint/ })))
    expect(calls('terminal.create')).toEqual([
      expect.objectContaining({ worktreeId: 'w1', command: 'npm run lint', label: 'Lint' })
    ])
  })

  it('opens the sheet for this project from New Command…', async () => {
    seed()
    render(<SavedCommands worktreeId="w1" />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Commands' })))
    await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: 'New Command…' })))
    expect(useWorkspaceStore.getState().dialog).toEqual({ kind: 'saved-command', projectId: 'p1' })
  })
})

describe('runSavedCommand', () => {
  it('types a current-pane command into the focused shell, else opens a pane for it', async () => {
    seed([pane('t_sh')], 't_sh')
    await act(() => runSavedCommand('w1', 'c2'))
    expect(calls('terminal.write')).toEqual([{ terminalId: 't_sh', data: 'git status\r' }])

    seed([pane('t_agent', { agent: 'claude' })], 't_agent')
    await act(() => runSavedCommand('w1', 'c2'))
    expect(calls('terminal.write')).toHaveLength(1)
    expect(calls('terminal.create')).toEqual([expect.objectContaining({ command: 'git status', label: 'Status' })])
  })

  it('pastes a prompt into the worktree’s agent and submits it', async () => {
    seed([pane('t_sh'), pane('t_agent', { agent: 'claude' })], 't_sh')
    await act(() => runSavedCommand('w1', 'c3'))
    expect(calls('terminal.write')).toEqual([
      { terminalId: 't_agent', data: '\x1b[200~Review the diff\x1b[201~' },
      { terminalId: 't_agent', data: '\r' }
    ])
  })

  it('starts an agent on the prompt when none runs, or when it asks for a new one', async () => {
    seed()
    await act(() => runSavedCommand('w1', 'c3'))
    await act(() => runSavedCommand('w1', 'c4'))
    expect(calls('terminal.create')).toEqual([
      expect.objectContaining({ worktreeId: 'w1', command: 'claude', prompt: 'Review the diff' }),
      expect.objectContaining({ worktreeId: 'w1', command: 'codex', prompt: 'Write tests' })
    ])
  })

  it('opens New Task on a task prompt', async () => {
    seed()
    await act(() => runSavedCommand('w1', 'c5'))
    expect(useWorkspaceStore.getState().dialog).toEqual({ kind: 'new-task', projectId: 'p1', task: fanOut.text })
    expect(call).not.toHaveBeenCalled()
  })

  it('asks before a repository’s command first runs: Skip runs nothing, Run approves and runs it', async () => {
    seed()
    await act(() => runSavedCommand('w1', 'r1'))
    expect(call).not.toHaveBeenCalled()
    expect(useSavedCommandsStore.getState().ask).toEqual({ worktreeId: 'w1', commandId: 'r1', text: migrate.text })

    await act(() => useSavedCommandsStore.getState().answer(false))
    expect(useSavedCommandsStore.getState().ask).toBeNull()
    expect(call).not.toHaveBeenCalled()

    await act(() => runSavedCommand('w1', 'r1'))
    await act(() => settled(useSavedCommandsStore.getState().answer(true)))
    expect(calls('project.setPaths')).toEqual([{ projectId: 'p1', approveCommand: migrate.text }])
    expect(calls('terminal.create')).toEqual([expect.objectContaining({ command: migrate.text, label: 'Migrate' })])
  })
})
