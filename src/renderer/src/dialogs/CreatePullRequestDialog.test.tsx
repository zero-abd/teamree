/** @vitest-environment jsdom */

// One step to a pull request: commit if needed, publish or push, then create, each step shown, a failure resumed where it stopped.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree, WorktreeLanding, WorktreeStatus } from '@shared/entities'

const call = vi.hoisted(() => vi.fn((..._args: unknown[]): Promise<unknown> => new Promise(() => {})))
const openInBrowser = vi.hoisted(() => vi.fn())

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
vi.mock('../shell/openInBrowser', () => ({ openInBrowser }))

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { CreatePullRequestDialog } = await import('./CreatePullRequestDialog')
const { useCommitDrafts } = await import('../workspace/rightPanel/commitMessage')

const INITIAL = useWorkspaceStore.getState()

const worktree: Worktree = {
  id: 'w1',
  projectId: 'p1',
  name: 'fix login',
  branch: 'fix-login',
  path: '/repos/api-wt/fix-login',
  startedFrom: 'main',
  state: 'ready',
  createdAt: 0,
  task: 'Fix the login loop'
}
const landing: WorktreeLanding = {
  worktreeId: 'w1',
  branch: 'fix-login',
  base: 'main',
  host: 'github',
  published: true,
  unmerged: 1,
  merged: false,
  compareUrl: 'https://github.com/o/r/compare/main...fix-login?expand=1',
  readAt: 0,
  remote: true
}
const status: WorktreeStatus = {
  worktreeId: 'w1',
  branch: 'fix-login',
  upstream: 'origin/fix-login',
  ahead: 0,
  behind: 0,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicted: 0,
  readAt: 0
}
const COMMIT = { worktreeId: 'w1', sha: 'b'.repeat(40), shortSha: 'bbbbbbb', message: 'm', paths: [], committedAt: 0 }
const PUSHED = { worktreeId: 'w1', branch: 'fix-login', remote: 'origin', upstream: 'origin/fix-login' }
const MADE = { worktreeId: 'w1', url: 'https://github.com/o/r/pull/12', number: 12, created: true }
const DRAFT = {
  worktreeId: 'w1',
  url: landing.compareUrl,
  created: false,
  title: 'Fix the login loop',
  body: 'Closes #3'
}

type Answer = (params: Record<string, unknown>) => Promise<unknown>
function answer(overrides: Record<string, Answer> = {}): void {
  const answers: Record<string, Answer> = {
    'worktree.commit': () => Promise.resolve(COMMIT),
    'worktree.push': () => Promise.resolve(PUSHED),
    'worktree.createPullRequest': (params) => Promise.resolve(params.dryRun === true ? DRAFT : MADE),
    ...overrides
  }
  call.mockImplementation((method: unknown, params: unknown) => {
    const reply = answers[method as string]
    return reply === undefined ? new Promise(() => {}) : reply(params as Record<string, unknown>)
  })
}

function seed(statusOverrides: Partial<WorktreeStatus> = {}, landingOverrides: Partial<WorktreeLanding> = {}): void {
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      worktrees: [worktree],
      activeWorktreeId: 'w1',
      statuses: { w1: { ...status, ...statusOverrides } },
      landings: { w1: { ...landing, ...landingOverrides } },
      dialog: { kind: 'create-pr', worktreeId: 'w1' }
    },
    true
  )
}

const created = (): Record<string, unknown>[] =>
  call.mock.calls
    .filter(([method, params]) => method === 'worktree.createPullRequest' && !(params as { dryRun?: boolean }).dryRun)
    .map(([, params]) => params as Record<string, unknown>)
const ran = (): string[] =>
  call.mock.calls
    .map(([method, params]) => ((params as { dryRun?: boolean }).dryRun ? 'draft' : (method as string)))
    .filter((method) => ['worktree.commit', 'worktree.push', 'worktree.createPullRequest'].includes(method))

beforeEach(() => {
  call.mockReset()
  openInBrowser.mockReset()
  useCommitDrafts.setState({ drafts: {} })
  answer()
})
afterEach(cleanup)

describe('from a dirty tree', () => {
  it('commits with the suggested message, publishes, then creates with the prefilled title and body', async () => {
    seed({ upstream: null, unstaged: 1, untracked: 1 }, { published: false })
    render(<CreatePullRequestDialog worktreeId="w1" />)

    expect((screen.getByRole('textbox', { name: 'Commit message' }) as HTMLTextAreaElement).value).toBe(
      'Fix the login loop'
    )
    await waitFor(() =>
      expect((screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement).value).toBe('Fix the login loop')
    )
    expect((screen.getByRole('textbox', { name: 'Body' }) as HTMLTextAreaElement).value).toBe('Closes #3')
    expect(call).toHaveBeenCalledWith('worktree.createPullRequest', {
      worktreeId: 'w1',
      dryRun: true,
      pending: 'Fix the login loop'
    })
    expect(screen.getByText('Commit')).toBeTruthy()
    expect(screen.getByText('Publish')).toBeTruthy()

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Commit & Create' })))

    await waitFor(() => expect(useWorkspaceStore.getState().dialog).toBeNull())
    expect(ran()).toEqual(['worktree.commit', 'worktree.push', 'worktree.createPullRequest'])
    expect(call).toHaveBeenCalledWith('worktree.commit', { worktreeId: 'w1', message: 'Fix the login loop', all: true })
    expect(created()).toEqual([{ worktreeId: 'w1', title: 'Fix the login loop', body: 'Closes #3' }])
    expect(useWorkspaceStore.getState().landings.w1?.pullRequest).toMatchObject({ number: 12, state: 'open' })
  })
})

describe('from a clean branch', () => {
  it('pushes the commits the host lacks, and creates a draft with the title as typed', async () => {
    seed({ ahead: 2 })
    render(<CreatePullRequestDialog worktreeId="w1" />)
    expect(screen.queryByRole('textbox', { name: 'Commit message' })).toBeNull()
    expect(screen.getByText('Push')).toBeTruthy()

    const title = screen.getByRole('textbox', { name: 'Title' })
    await waitFor(() => expect((title as HTMLInputElement).value).toBe('Fix the login loop'))
    fireEvent.change(title, { target: { value: 'Stop the loop' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Draft' }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create' })))

    await waitFor(() => expect(created()).toHaveLength(1))
    expect(ran()).toEqual(['worktree.push', 'worktree.createPullRequest'])
    expect(created()[0]).toEqual({ worktreeId: 'w1', title: 'Stop the loop', body: 'Closes #3', draft: true })
    expect(useWorkspaceStore.getState().landings.w1?.pullRequest).toMatchObject({ number: 12, draft: true })
  })

  it('only creates once the host has every commit', async () => {
    seed()
    render(<CreatePullRequestDialog worktreeId="w1" />)
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement).value).not.toBe(''))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create' })))
    await waitFor(() => expect(created()).toHaveLength(1))
    expect(ran()).toEqual(['worktree.createPullRequest'])
  })

  it('opens the host’s page when gh cannot create it', async () => {
    seed()
    answer({
      'worktree.createPullRequest': (params) =>
        Promise.resolve(params.dryRun === true ? DRAFT : { worktreeId: 'w1', url: landing.compareUrl, created: false })
    })
    render(<CreatePullRequestDialog worktreeId="w1" />)
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement).value).not.toBe(''))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create' })))
    await waitFor(() => expect(openInBrowser).toHaveBeenCalledWith(landing.compareUrl))
    expect(useWorkspaceStore.getState().dialog).toBeNull()
  })
})

describe('a failed step', () => {
  it('names the step with a terse reason, and Retry resumes from it without committing again', async () => {
    seed({ upstream: null, unstaged: 1 }, { published: false })
    let pushes = 0
    answer({
      'worktree.push': () => {
        pushes += 1
        if (pushes > 1) return Promise.resolve(PUSHED)
        return Promise.reject(
          Object.assign(new Error('Rejected: origin has commits you lack'), { data: { detail: '! [rejected]' } })
        )
      }
    })
    render(<CreatePullRequestDialog worktreeId="w1" />)
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement).value).not.toBe(''))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Commit & Create' })))

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Rejected: origin has commits you lack')
    )
    expect(screen.getByRole('listitem', { name: 'Publish failed' })).toBeTruthy()
    expect(created()).toEqual([])
    expect(useWorkspaceStore.getState().dialog).toEqual({ kind: 'create-pr', worktreeId: 'w1' })

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })))

    await waitFor(() => expect(useWorkspaceStore.getState().dialog).toBeNull())
    expect(ran()).toEqual(['worktree.commit', 'worktree.push', 'worktree.push', 'worktree.createPullRequest'])
  })

  it('resumes at create when gh refused it', async () => {
    seed()
    let tries = 0
    answer({
      'worktree.createPullRequest': (params) => {
        if (params.dryRun === true) return Promise.resolve(DRAFT)
        tries += 1
        return tries === 1 ? Promise.reject(new Error('gh: HTTP 422')) : Promise.resolve(MADE)
      }
    })
    render(<CreatePullRequestDialog worktreeId="w1" />)
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement).value).not.toBe(''))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create' })))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('gh: HTTP 422'))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })))
    await waitFor(() => expect(useWorkspaceStore.getState().dialog).toBeNull())
    expect(tries).toBe(2)
  })
})
