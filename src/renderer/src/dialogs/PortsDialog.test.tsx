/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal, Worktree } from '@shared/entities'

const call = vi.hoisted(() => vi.fn((..._args: unknown[]): Promise<unknown> => Promise.resolve({ signalled: true })))
const copyText = vi.hoisted(() => vi.fn())

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call,
    watchPane: () => new Promise(() => {}),
    subscribeTerminal: () => new Promise(() => {}),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))
vi.mock('../clipboard/clipboard', () => ({ copyText, pasteText: async () => '' }))

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { PortsDialog } = await import('./PortsDialog')

const INITIAL = useWorkspaceStore.getState()

const worktree = (id: string, name: string): Worktree => ({
  id,
  projectId: 'p1',
  name,
  branch: name,
  path: `/repos/${name}`,
  startedFrom: 'origin/main',
  state: 'ready',
  createdAt: 0
})

const pane = (id: string, worktreeId: string, port: number, pid: number, command = 'node'): Terminal => ({
  id,
  worktreeId,
  title: 'zsh',
  cwd: '/repos',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  running: true,
  busy: false,
  lastOutputAt: 0,
  ports: [{ port, pid, command }]
})

function seed(terminals: Terminal[]): void {
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      worktrees: [worktree('w1', 'api-fix'), worktree('w2', 'web-redo')],
      terminals: Object.fromEntries(terminals.map((terminal) => [terminal.id, terminal]))
    },
    true
  )
}

const portRow = (port: string, worktree: string): HTMLElement => {
  const found = screen
    .getAllByRole('listitem')
    .find((item) => item.textContent?.includes(port) && item.textContent.includes(worktree))
  if (found === undefined) throw new Error(`no row for ${port} in ${worktree}`)
  return found
}

beforeEach(() => {
  call.mockClear()
  copyText.mockReset()
})

afterEach(cleanup)

describe('the Ports dialog', () => {
  it('lists every port with its process and worktree, lowest first', () => {
    seed([pane('t2', 'w2', 8000, 22, 'Python'), pane('t1', 'w1', 5173, 11)])
    render(<PortsDialog />)
    const rows = screen.getAllByRole('listitem').map((item) => item.textContent)
    expect(rows[0]).toContain(':5173')
    expect(rows[0]).toContain('node')
    expect(rows[0]).toContain('api-fix')
    expect(rows[1]).toContain(':8000')
    expect(rows[1]).toContain('web-redo')
  })

  it('opens and copies localhost', () => {
    const opened = vi.spyOn(window, 'open').mockImplementation(() => null)
    seed([pane('t1', 'w1', 5173, 11)])
    render(<PortsDialog />)
    fireEvent.click(within(portRow(':5173', 'api-fix')).getByRole('button', { name: 'Open' }))
    expect(opened).toHaveBeenCalledWith('http://localhost:5173', '_blank', 'noopener')
    fireEvent.click(within(portRow(':5173', 'api-fix')).getByRole('button', { name: 'Copy URL' }))
    expect(copyText).toHaveBeenCalledWith('http://localhost:5173')
    opened.mockRestore()
  })

  it('stops the process that holds the port', () => {
    seed([pane('t1', 'w1', 5173, 11)])
    render(<PortsDialog />)
    fireEvent.click(within(portRow(':5173', 'api-fix')).getByRole('button', { name: 'Stop' }))
    expect(call).toHaveBeenCalledWith('system.kill', { pid: 11 })
  })

  it('notes a port two worktrees hold', () => {
    seed([pane('t1', 'w1', 5173, 11), pane('t2', 'w2', 5173, 22)])
    render(<PortsDialog />)
    expect(screen.getByText(':5173 in api-fix and web-redo')).toBeTruthy()
  })

  it('says so when nothing listens', () => {
    seed([])
    render(<PortsDialog />)
    expect(screen.getByText('No ports')).toBeTruthy()
  })
})
