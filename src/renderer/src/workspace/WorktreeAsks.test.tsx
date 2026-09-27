/** @vitest-environment jsdom */

// A worktree's setup questions ride in the status rail, so the panes never move or hide under them.

import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '@shared/entities'

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: () => new Promise(() => {}),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { WorktreeAsks } = await import('./WorktreeAsks')

const INITIAL = useWorkspaceStore.getState()

const worktree: Worktree = {
  id: 'w1',
  projectId: 'p1',
  name: 'Rewrite the pager',
  branch: 'rewrite-the-pager',
  path: '/repos/pager-wt/rewrite',
  startedFrom: 'origin/main',
  state: 'ready',
  createdAt: 0,
  setupAsk: 'npm ci'
}

beforeEach(() => {
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      worktrees: [worktree],
      activeWorktreeId: 'w1',
      runAsk: { worktreeId: 'w1', kind: 'test', command: 'make check' }
    },
    true
  )
})

describe('the open worktree’s setup questions', () => {
  it('asks each one on its own', () => {
    render(<WorktreeAsks />)
    expect(screen.getByRole('region', { name: 'Setup' }).textContent).toContain('npm ci')
    expect(screen.getByRole('region', { name: 'Run test' }).textContent).toContain('make check')
  })

  it('asks nothing while a page covers the worktree', () => {
    useWorkspaceStore.setState({ settingsOpen: true })
    render(<WorktreeAsks />)
    expect(screen.queryByRole('region')).toBeNull()
  })

  it('keeps another worktree’s Run question to that worktree', () => {
    useWorkspaceStore.setState({ runAsk: { worktreeId: 'w2', kind: 'dev', command: 'npm run dev' } })
    render(<WorktreeAsks />)
    expect(screen.queryByRole('region', { name: 'Run dev' })).toBeNull()
  })
})
