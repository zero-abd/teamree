/** @vitest-environment jsdom */

// Open Branch and Check Out Pull Request: the row chosen is the branch checked out, and an agent is optional.

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BranchList, PullRequestList } from '@shared/entities'

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
const { OpenBranchDialog } = await import('./OpenBranchDialog')

const INITIAL = useWorkspaceStore.getState()
const startTask = vi.fn()

const BRANCHES: BranchList = {
  projectId: 'p1',
  readAt: 0,
  branches: [
    {
      name: 'add-a-sub-function',
      checkout: 'origin/add-a-sub-function',
      remote: true,
      updatedAt: 0,
      author: 'Ana',
      subject: 'Add a sub function'
    },
    { name: 'spike', checkout: 'spike', remote: false, updatedAt: 0, author: 'Bo', subject: 'Try a thing' }
  ]
}

const PULLS: PullRequestList = {
  projectId: 'p1',
  available: true,
  reason: null,
  readAt: 0,
  pullRequests: [
    {
      number: 12,
      title: 'Add div',
      author: 'teammate',
      branch: 'add-div',
      checkout: 'origin/add-div',
      base: 'origin/release',
      updatedAt: null
    }
  ]
}

beforeEach(() => {
  startTask.mockReset()
  call.mockReset()
  call.mockImplementation(async (method) => {
    if (method === 'worktree.branches') return BRANCHES
    if (method === 'worktree.pullRequests') return PULLS
    throw new Error(`unexpected ${method}`)
  })
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      projects: [{ id: 'p1', name: 'pager', path: '/repos/pager', baseRef: 'origin/main' }],
      agents: [{ kind: 'claude', command: 'claude', binary: '/usr/local/bin/claude' }],
      startTask
    },
    true
  )
})

describe('Open Branch', () => {
  it('opens the chosen branch as it is, named by its last commit, with no agent unless asked', async () => {
    render(<OpenBranchDialog projectId="p1" pullRequests={false} />)
    await screen.findByText('spike')
    fireEvent.change(screen.getByLabelText('Filter'), { target: { value: 'try' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(startTask).toHaveBeenCalledWith({
      projectId: 'p1',
      checkout: 'spike',
      creates: [{ name: 'Try a thing', task: '' }]
    })
  })

  it('starts one reviewer agent with the prompt prefilled against the base', async () => {
    render(<OpenBranchDialog projectId="p1" pullRequests={false} />)
    await screen.findByText('add-a-sub-function')
    fireEvent.click(screen.getByRole('button', { name: 'One more Claude Code' }))
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe(
      'Review this branch against origin/main'
    )
    // One checkout holds one branch, so one agent.
    expect((screen.getByRole('button', { name: 'One more Claude Code' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(startTask).toHaveBeenCalledWith({
      projectId: 'p1',
      checkout: 'origin/add-a-sub-function',
      creates: [{ name: 'Add a sub function', task: 'Review this branch against origin/main', agentCommand: 'claude' }]
    })
  })
})

describe('Check Out Pull Request', () => {
  it('checks out the head and compares against the pull request’s base', async () => {
    render(<OpenBranchDialog projectId="p1" pullRequests={true} />)
    await screen.findByText('#12 Add div · teammate')
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(startTask).toHaveBeenCalledWith({
      projectId: 'p1',
      checkout: 'origin/add-div',
      base: 'origin/release',
      creates: [{ name: 'Add div', task: '' }]
    })
  })

  it('says gh is unavailable rather than listing nothing', async () => {
    call.mockImplementation(async () => ({
      ...PULLS,
      available: false,
      reason: 'gh: command not found',
      pullRequests: []
    }))
    render(<OpenBranchDialog projectId="p1" pullRequests={true} />)
    await waitFor(() => expect(screen.getByText('gh unavailable · gh: command not found')).toBeTruthy())
  })
})
