/** @vitest-environment jsdom */

// A commit a hook refused: said with the hook and the worktree, its lines under the message box until the next
// attempt, the whole output a click away, and handed to the idle agent.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHookFailedData, Terminal, Worktree, WorktreeChange } from '@shared/entities'

const call = vi.hoisted(() => vi.fn((..._args: unknown[]): Promise<unknown> => new Promise(() => {})))

vi.mock('../../runtimeClient/currentRuntimeClient', () => ({
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

const { useWorkspaceStore } = await import('../../state/workspaceStore')
const { CommitBox } = await import('./CommitBox')
const { CommitOutputSheet } = await import('./CommitBlocked')
const { NoticeStack } = await import('../../notices/NoticeStack')
const { useCommitDrafts } = await import('./commitMessage')

const INITIAL = useWorkspaceStore.getState()

const OUTPUT = [
  'lint: 3 problems (2 errors, 1 warning)',
  'src/a.ts:1:7 error no-unused-vars',
  'src/b.ts:4:2 error no-undef',
  'src/b.ts:9:1 warning eqeqeq'
].join('\n')

/** What the runtime throws when the pre-commit hook exits 1. */
const refused = (): Error =>
  Object.assign(new Error(`pre-commit hook failed: lint: 3 problems (2 errors, 1 warning)`), {
    code: 'git_failed',
    data: { kind: 'hook', hook: 'pre-commit', output: OUTPUT } satisfies GitHookFailedData
  })

const worktree: Worktree = {
  id: 'w1',
  projectId: 'p1',
  name: 'fix typo docs',
  branch: 'fix-typo-docs',
  path: '/wt/fix-typo-docs',
  startedFrom: 'main',
  state: 'ready',
  createdAt: 0
}

const agent: Terminal = {
  id: 't1',
  worktreeId: 'w1',
  title: 'claude',
  cwd: '/wt',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  running: true,
  busy: false,
  agent: 'claude',
  lastOutputAt: 0
} as Terminal

const rows: WorktreeChange[] = [{ path: 'CHANGELOG.md', kind: 'modified', staged: false, unstaged: true }]

function commitBox(onLand = vi.fn()): void {
  render(
    <>
      <CommitBox
        worktreeId="w1"
        shown={{
          conflicts: [],
          staged: [],
          unstaged: rows,
          committed: [],
          unlisted: 0,
          unlistedIn: 'unstaged',
          committedUnlisted: 0,
          scope: 'all'
        }}
        land={{ kind: 'merge', into: 'main' }}
        remote
        amend={null}
        lastMessage=""
        onLand={onLand}
      />
      <NoticeStack />
    </>
  )
}

async function commitWith(choice?: string): Promise<void> {
  fireEvent.change(screen.getByRole('textbox', { name: 'Commit message' }), { target: { value: 'Fixed' } })
  if (choice !== undefined) fireEvent.click(screen.getByRole('button', { name: 'Commit Actions' }))
  const target =
    choice === undefined
      ? screen.getByRole('button', { name: /^Commit All/ })
      : within(screen.getByRole('menu', { name: 'Commit Actions' })).getByRole('menuitem', { name: choice })
  await act(async () => {
    fireEvent.click(target)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const methods = (): unknown[] => call.mock.calls.map(([method]) => method)

beforeEach(() => {
  call.mockReset()
  call.mockImplementation((method: unknown) =>
    method === 'worktree.commit' ? Promise.reject(refused()) : new Promise(() => {})
  )
  useCommitDrafts.setState({ drafts: {} })
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      worktrees: [worktree],
      activeWorktreeId: 'w1',
      terminals: { t1: agent },
      layouts: { w1: { worktreeId: 'w1', root: { kind: 'leaf', terminalId: 't1' }, focusedTerminalId: 't1' } },
      changes: { w1: { worktreeId: 'w1', changes: rows, total: 1, limit: 500, truncated: false, readAt: 0 } },
      notices: []
    },
    true
  )
})

afterEach(cleanup)

describe('a commit a hook refused', () => {
  it('says Commit blocked with the hook and the worktree, with Details and Send to Agent', async () => {
    commitBox()
    await commitWith()

    const notice = screen.getByText('Commit blocked · pre-commit · fix typo docs').closest<HTMLElement>('.notice')!
    expect(within(notice).getByText('lint: 3 problems (2 errors, 1 warning)')).toBeTruthy()
    expect(within(notice).getByRole('button', { name: 'Details' })).toBeTruthy()
    expect(within(notice).getByRole('button', { name: 'Send to Agent' })).toBeTruthy()
    expect(screen.queryByText(/Could not commit/)).toBeNull()
    // The message is kept for the next attempt.
    expect((screen.getByRole('textbox', { name: 'Commit message' }) as HTMLTextAreaElement).value).toBe('Fixed')
  })

  it('shows its first two lines under the message box until the next attempt', async () => {
    commitBox()
    await commitWith()

    const inline = document.querySelector<HTMLElement>('.changes__blocked')!
    expect(within(inline).getByText('Commit blocked · pre-commit')).toBeTruthy()
    expect(inline.querySelector('pre')?.textContent).toBe(
      'lint: 3 problems (2 errors, 1 warning)\nsrc/a.ts:1:7 error no-unused-vars'
    )

    call.mockImplementation(() => new Promise(() => {}))
    await commitWith()
    expect(document.querySelector('.changes__blocked')).toBeNull()
    expect(useWorkspaceStore.getState().notices).toEqual([])
  })

  it('opens every line in a sheet from Details', async () => {
    commitBox()
    await commitWith()
    fireEvent.click(within(document.querySelector<HTMLElement>('.changes__blocked')!).getByText('Details'))

    expect(useWorkspaceStore.getState().dialog).toEqual({ kind: 'commit-output', worktreeId: 'w1' })
    render(<CommitOutputSheet worktreeId="w1" />)
    const sheet = screen.getByRole('dialog', { name: 'Commit blocked · pre-commit · fix typo docs' })
    expect(sheet.querySelector('pre')?.textContent).toBe(OUTPUT)
  })

  it('pastes the output into the idle agent with the instruction, then submits it', async () => {
    commitBox()
    await commitWith()
    call.mockImplementation(() => Promise.resolve(undefined))
    const notice = screen.getByText('Commit blocked · pre-commit · fix typo docs').closest<HTMLElement>('.notice')!

    fireEvent.click(within(notice).getByRole('button', { name: 'Send to Agent' }))
    // The notice's way out was taken, once the Return that follows the paste was typed too.
    await waitFor(() => expect(useWorkspaceStore.getState().notices.filter((notice) => notice.commitBlock)).toEqual([]))

    const writes = call.mock.calls.filter(([method]) => method === 'terminal.write').map(([, params]) => params)
    expect(writes).toHaveLength(2)
    const pasted = (writes[0] as { terminalId: string; data: string }).data
    expect((writes[0] as { terminalId: string }).terminalId).toBe('t1')
    expect(pasted).toContain('The pre-commit hook blocked the commit:')
    expect(pasted).toContain('src/b.ts:4:2 error no-undef')
    expect(pasted).toContain('Fix it and commit again.')
    expect(writes[1]).toEqual({ terminalId: 't1', data: '\r' })
    // The lines stay by the commit box until the next attempt.
    expect(document.querySelector('.changes__blocked')).toBeTruthy()
  })

  it('will not send to an agent that is working', async () => {
    useWorkspaceStore.setState({
      terminals: { t1: { ...agent, agentEvent: { event: 'UserPromptSubmit', at: 1 } } as Terminal }
    })
    commitBox()
    await commitWith()

    const send = within(document.querySelector<HTMLElement>('.changes__blocked')!).getByRole('button', {
      name: 'Send to Agent'
    }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    expect(send.title).toBe('No idle agent')
  })

  it('stops Commit & Push before the push', async () => {
    commitBox()
    await commitWith('Commit & Push')

    expect(methods()).not.toContain('worktree.push')
    expect(document.querySelector('.changes__blocked')).toBeTruthy()
  })

  it('stops Commit & Merge before the merge', async () => {
    const onLand = vi.fn()
    commitBox(onLand)
    await commitWith('Commit & Merge into main…')

    expect(onLand).not.toHaveBeenCalled()
    expect(document.querySelector('.changes__blocked')).toBeTruthy()
  })
})
