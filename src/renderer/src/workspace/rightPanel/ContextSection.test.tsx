/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '@shared/entities'
import type { ProjectMemory } from '@shared/ledgerMethods'
import type { MemoryNote } from '@shared/memory'

const call = vi.fn((_method: string, _params?: unknown): Promise<unknown> => Promise.resolve({}))

vi.mock('../../runtimeClient/currentRuntimeClient', () => ({
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

const { useWorkspaceStore } = await import('../../state/workspaceStore')
const { useLedger } = await import('../../state/ledgerStore')
const { ContextSection } = await import('./ContextSection')
const { DecisionsDialog } = await import('../../dialogs/DecisionsDialog')
const INITIAL = useWorkspaceStore.getState()

function worktree(id: string, name: string): Worktree {
  return {
    id,
    projectId: 'p1',
    name,
    branch: id,
    path: `/wt/${id}`,
    startedFrom: 'main',
    state: 'ready',
    createdAt: 1
  }
}

function note(id: string, worktreeId: string, text: string, extra: Partial<MemoryNote> = {}): MemoryNote {
  return { id, worktreeId, kind: 'decision', text, scope: 'private', at: 1, author: 'me', ...extra }
}

const MEMORY: ProjectMemory = {
  projectId: 'p1',
  revision: 4,
  worktrees: [
    { worktreeId: 'auth', claims: ['src/auth/**'], touched: ['src/api/limits.ts'] },
    { worktreeId: 'limits', claims: ['src/api/**'], touched: ['src/api/limits.ts'] },
    { worktreeId: 'docs', claims: ['README.md'], touched: [] }
  ],
  notes: [
    note('n1', 'auth', 'Tokens stay JWT', { paths: ['src/auth/token.ts'] }),
    note('n2', 'auth', 'Keep v1 tokens?', { kind: 'question', open: true }),
    note('n3', 'limits', 'Limits are per user', { paths: ['src/api/limits.ts'] }),
    note('n4', 'docs', 'README stays short', { paths: ['README.md'] })
  ]
}

beforeEach(() => {
  cleanup()
  call.mockClear()
  useLedger.setState({ byProject: { p1: MEMORY } })
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      projects: [{ id: 'p1', name: 'p1', path: '/repos/p1', baseRef: 'origin/main' }],
      worktrees: [worktree('auth', 'auth refresh'), worktree('limits', 'rate limits'), worktree('docs', 'docs pass')],
      activeWorktreeId: 'auth'
    },
    true
  )
})

describe('ContextSection', () => {
  it('draws its claims, decisions, open questions and the siblings that touch its paths', () => {
    render(<ContextSection worktreeId="auth" />)
    const section = screen.getByRole('region', { name: 'Context' })
    expect(within(section).getByText('src/auth/**')).toBeTruthy()
    expect(within(section).getByText('Tokens stay JWT')).toBeTruthy()
    expect(within(section).getByText('Keep v1 tokens?')).toBeTruthy()
    const sibling = within(section).getByRole('group', { name: 'rate limits' })
    expect(within(sibling).getByText('src/api/**')).toBeTruthy()
    expect(within(sibling).getByText('Limits are per user')).toBeTruthy()
    expect(within(section).queryByText('docs pass')).toBeNull()
    expect(within(section).queryByText('README stays short')).toBeNull()
  })

  it('removes a claim with its ×', () => {
    render(<ContextSection worktreeId="auth" />)
    fireEvent.click(screen.getByRole('button', { name: 'Unclaim src/auth/**' }))
    expect(call).toHaveBeenCalledWith('memory.unclaim', { worktreeId: 'auth', globs: ['src/auth/**'] })
  })

  it('adds a claim from Add Claim…', () => {
    render(<ContextSection worktreeId="auth" />)
    fireEvent.click(screen.getByRole('button', { name: 'Add Claim…' }))
    const field = screen.getByRole('textbox', { name: 'Claim' })
    fireEvent.change(field, { target: { value: ' src/session/** ' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(call).toHaveBeenCalledWith('memory.claim', { worktreeId: 'auth', globs: ['src/session/**'] })
  })

  it('resolves a question and forgets a decision', () => {
    render(<ContextSection worktreeId="auth" />)
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }))
    expect(call).toHaveBeenCalledWith('memory.resolve', { noteId: 'n2' })
    fireEvent.click(screen.getByRole('button', { name: 'Forget Tokens stay JWT' }))
    expect(call).toHaveBeenCalledWith('memory.forget', { noteId: 'n1' })
  })

  it('records a decision from the Note… field', () => {
    render(<ContextSection worktreeId="auth" />)
    const field = screen.getByRole('textbox', { name: 'Note' })
    fireEvent.change(field, { target: { value: 'No new deps' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(call).toHaveBeenCalledWith('memory.note', {
      worktreeId: 'auth',
      kind: 'decision',
      text: 'No new deps',
      scope: 'private'
    })
  })

  it('leaves siblings’ rows read-only', () => {
    render(<ContextSection worktreeId="auth" />)
    const sibling = screen.getByRole('group', { name: 'rate limits' })
    expect(within(sibling).queryAllByRole('button')).toHaveLength(0)
  })
})

describe('DecisionsDialog', () => {
  it('lists every task’s claims and notes, and resolves from there', () => {
    render(<DecisionsDialog projectId="p1" />)
    for (const name of ['auth refresh', 'rate limits', 'docs pass'])
      expect(screen.getByRole('group', { name })).toBeTruthy()
    expect(within(screen.getByRole('group', { name: 'docs pass' })).getByText('README stays short')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }))
    expect(call).toHaveBeenCalledWith('memory.resolve', { noteId: 'n2' })
  })

  it('opens a task from its name', async () => {
    render(<DecisionsDialog projectId="p1" />)
    useWorkspaceStore.getState().openDialog({ kind: 'decisions', projectId: 'p1' })
    fireEvent.click(screen.getByRole('button', { name: 'rate limits' }))
    expect(useWorkspaceStore.getState().dialog).toBeNull()
    await vi.waitFor(() => expect(useWorkspaceStore.getState().activeWorktreeId).toBe('limits'))
  })
})
