/** @vitest-environment jsdom */

// Run Dev and Run Tests: the strip's buttons, the row's menu and chip, and the question a
// repository's command gets before it first runs here.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Terminal, Worktree } from '@shared/entities'

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
const { RunButtons, RunChip, runMenuItems, runOffers } = await import('./runButtons')

const INITIAL = useWorkspaceStore.getState()

const project = (overrides: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'shop',
  path: '/repos/shop',
  baseRef: 'origin/main',
  detectedRun: { dev: 'npm run dev', test: 'npm test' },
  ...overrides
})

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

const pane = (id: string, extra: Partial<Terminal>): Terminal => ({
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

function seed(projectOverrides: Partial<Project> = {}, terminals: Terminal[] = []): void {
  useWorkspaceStore.setState({
    projects: [project(projectOverrides)],
    worktrees: [worktree],
    activeWorktreeId: 'w1',
    openWorktreeIds: ['w1'],
    terminals: Object.fromEntries(terminals.map((terminal) => [terminal.id, terminal]))
  })
}

const runCalls = (): unknown[] =>
  call.mock.calls.filter(([method]) => method === 'worktree.run' || method === 'worktree.stopRun')

beforeEach(() => {
  useWorkspaceStore.setState(INITIAL, true)
  call.mockReset()
  call.mockImplementation((method: string, params: { kind?: 'dev' | 'test' }) =>
    method === 'worktree.run'
      ? Promise.resolve(pane('t_run', { run: params.kind, label: params.kind }))
      : new Promise(() => {})
  )
})
afterEach(cleanup)

describe('runOffers and runMenuItems', () => {
  it('offers each kind the project has a command for, with its pane', () => {
    const dev = pane('t_dev', { run: 'dev' })
    const offers = runOffers(project({ detectedRun: { dev: 'npm run dev' } }), [dev], 'w1')
    expect(offers).toEqual([{ kind: 'dev', command: 'npm run dev', pane: dev, state: 'running' }])
    expect(runOffers(project({ detectedRun: undefined }), [], 'w1')).toEqual([])
    expect(runOffers(undefined, [], 'w1')).toEqual([])
  })

  it('says Run while idle, and Show, Restart and Stop while it runs', () => {
    const run = vi.fn()
    const stop = vi.fn()
    const offers = runOffers(project(), [pane('t_dev', { run: 'dev' })], 'w1')
    const items = runMenuItems(offers, { run, stop })
    expect(items.map((item) => item.label)).toEqual(['Show Dev', 'Restart Dev', 'Stop Dev', 'Run Tests'])
    items[1]?.onChoose()
    items[2]?.onChoose()
    items[3]?.onChoose()
    expect(run.mock.calls).toEqual([
      ['dev', true],
      ['test', false]
    ])
    expect(stop).toHaveBeenCalledWith('dev')
  })
})

describe('RunButtons', () => {
  it('starts the command in a pane of its own on a click', async () => {
    seed()
    render(<RunButtons worktreeId="w1" />)
    expect(screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
      'Run Dev',
      'Run Tests'
    ])
    expect(screen.getByRole('button', { name: 'Run Tests' }).title).toBe('Run Tests · npm test')

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Run Tests' })))
    expect(runCalls()).toEqual([['worktree.run', { worktreeId: 'w1', kind: 'test' }]])
  })

  it('shows a running pane instead of starting it twice, and restarts or stops it', async () => {
    seed({}, [pane('t_dev', { run: 'dev', label: 'dev' })])
    useWorkspaceStore.setState({
      layouts: { w1: { worktreeId: 'w1', root: { kind: 'leaf', terminalId: 't_dev' }, focusedTerminalId: null } }
    })
    render(<RunButtons worktreeId="w1" />)

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Show Dev' })))
    expect(runCalls()).toEqual([])
    expect(useWorkspaceStore.getState().layouts.w1?.focusedTerminalId).toBe('t_dev')

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Restart Dev' })))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Stop Dev' })))
    expect(runCalls()).toEqual([
      ['worktree.run', { worktreeId: 'w1', kind: 'dev', restart: true }],
      ['worktree.stopRun', { worktreeId: 'w1', kind: 'dev' }]
    ])
  })

  it('asks before a repository’s command first runs, and runs nothing on Skip', async () => {
    seed({ repository: { runCommands: { test: 'make check' } } })
    render(<RunButtons worktreeId="w1" />)

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Run Tests' })))
    expect(runCalls()).toEqual([])
    expect(useWorkspaceStore.getState().runAsk).toEqual({ worktreeId: 'w1', kind: 'test', command: 'make check' })

    await act(async () => useWorkspaceStore.getState().answerRunAsk(false))
    expect(useWorkspaceStore.getState().runAsk).toBeNull()
    expect(runCalls()).toEqual([])

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Run Tests' })))
    await act(async () => void useWorkspaceStore.getState().answerRunAsk(true))
    expect(runCalls()).toEqual([['worktree.run', { worktreeId: 'w1', kind: 'test', approve: true }]])
  })

  it('draws nothing for a project with no run commands', () => {
    seed({ detectedRun: undefined })
    const { container } = render(<RunButtons worktreeId="w1" />)
    expect(container.innerHTML).toBe('')
  })
})

describe('RunChip', () => {
  it.each([
    [{ running: true }, 'tests…'],
    [{ running: false, exitCode: 0 }, '✓ tests'],
    [{ running: false, exitCode: 2 }, '✗ tests']
  ])('reads %j as %s', (state, text) => {
    render(<RunChip terminals={[pane('t_test', { run: 'test', ...state })]} worktreeId="w1" />)
    expect(screen.getByText(text)).toBeTruthy()
  })

  it('says nothing for a stopped run, a dev pane, or a pane only named test', () => {
    const { container } = render(
      <RunChip
        terminals={[
          pane('a', { run: 'test', running: false, exitCode: 130 }),
          pane('b', { run: 'dev', running: false, exitCode: 1 })
        ]}
        worktreeId="w1"
      />
    )
    expect(container.innerHTML).toBe('')
    const named = render(
      <RunChip terminals={[pane('c', { label: 'test', running: false, exitCode: 1 })]} worktreeId="w1" />
    )
    expect(named.container.innerHTML).toBe('')
  })
})
