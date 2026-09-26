/** @vitest-environment jsdom */

// Merging a worktree: the commits that go in, how much the branch changes against its base, and a way to read it first.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ProjectBase,
  Worktree,
  WorktreeChanges,
  WorktreeLanding,
  WorktreeMerge,
  WorktreeMergePreview
} from '@shared/entities'
import { fileLeavesIn, isReviewLeaf } from '@shared/filePane'

const call = vi.hoisted(() => vi.fn((..._args: unknown[]): Promise<unknown> => new Promise(() => {})))

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

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { useReviewStore } = await import('../review/reviewStore')
const { ConfirmMergeDialog } = await import('./ConfirmMergeDialog')
const { useChildren } = await import('../workspace/rightPanel/childrenStore')
const { useCommitDrafts } = await import('../workspace/rightPanel/commitMessage')

const INITIAL = useWorkspaceStore.getState()

const worktree: Worktree = {
  id: 'w1',
  projectId: 'p1',
  name: 'fix typo',
  branch: 'fix-typo',
  path: '/repos/acme-wt/fix-typo',
  startedFrom: 'main',
  state: 'ready',
  createdAt: 0
}

const plan: WorktreeMerge = {
  worktreeId: 'w1',
  into: 'main',
  checkout: '/repos/acme-api',
  commits: [
    { shortSha: 'f882eef', subject: 'Add usage section' },
    { shortSha: '6c1738c', subject: 'Fix README typo' }
  ],
  fastForward: true,
  dirty: [],
  merged: false
}

const branch: WorktreeChanges = {
  worktreeId: 'w1',
  changes: [
    { path: 'README.md', kind: 'modified', staged: false, unstaged: false, added: 5, removed: 1 },
    { path: 'src/app.ts', kind: 'modified', staged: false, unstaged: false, added: 36, removed: 6 },
    { path: 'logo.png', kind: 'added', staged: false, unstaged: false }
  ],
  total: 3,
  limit: 500,
  truncated: false,
  readAt: 0
}

beforeEach(() => {
  call.mockImplementation((method: unknown, params: unknown) => {
    if (method === 'worktree.mergeIntoBase') return Promise.resolve(plan)
    if (method === 'worktree.changes' && (params as { base?: boolean }).base === true) return Promise.resolve(branch)
    return new Promise(() => {})
  })
  useReviewStore.setState({ scope: { w1: 'uncommitted' }, jump: {} })
  useCommitDrafts.setState({ drafts: {} })
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      worktrees: [worktree],
      activeWorktreeId: 'w1',
      layouts: { w1: { worktreeId: 'w1', root: { kind: 'leaf', terminalId: 't1' }, focusedTerminalId: 't1' } },
      dialog: { kind: 'confirm-merge', worktreeId: 'w1' }
    },
    true
  )
})

it('says how much the branch changes against its base, beside the commits', async () => {
  render(<ConfirmMergeDialog worktreeId="w1" />)
  await waitFor(() => expect(screen.getByText('3 files +41 −7')).toBeTruthy())
  expect(screen.getByText('6c1738c Fix README typo')).toBeTruthy()
})

// The line counts cover only the listed files, so a cut-off list gives none rather than too few.
it('gives a cut-off branch its file count and no line counts', async () => {
  call.mockImplementation((method: unknown, params: unknown) => {
    if (method === 'worktree.mergeIntoBase') return Promise.resolve(plan)
    if (method === 'worktree.changes' && (params as { base?: boolean }).base === true) {
      return Promise.resolve({ ...branch, total: 3000, limit: 3, truncated: true })
    }
    return new Promise(() => {})
  })
  render(<ConfirmMergeDialog worktreeId="w1" />)
  await waitFor(() => expect(screen.getByText('3,000 files')).toBeTruthy())
})

it('reviews the whole branch instead of merging it', async () => {
  render(<ConfirmMergeDialog worktreeId="w1" />)
  fireEvent.click(await screen.findByRole('button', { name: 'Review' }))
  expect(useWorkspaceStore.getState().dialog).toBeNull()
  expect(fileLeavesIn(useWorkspaceStore.getState().layouts.w1!.root).filter(isReviewLeaf)).toHaveLength(1)
  expect(useReviewStore.getState().scope.w1).toBe('branch')
  expect(call).not.toHaveBeenCalledWith('worktree.mergeIntoBase', { worktreeId: 'w1' })
})

describe('a worktree with uncommitted work', () => {
  const uncommitted = [
    { path: 'README.md', kind: 'modified' as const, staged: false, unstaged: true },
    { path: 'notes.md', kind: 'untracked' as const, staged: false, unstaged: true }
  ]
  const commit = {
    worktreeId: 'w1',
    sha: 'b'.repeat(40),
    shortSha: 'bbbbbbb',
    message: 'Add usage',
    paths: ['README.md', 'notes.md'],
    committedAt: 0
  }

  beforeEach(() => {
    call.mockClear()
    useWorkspaceStore.setState({
      statuses: {
        w1: {
          worktreeId: 'w1',
          branch: 'fix-typo',
          upstream: null,
          ahead: 1,
          behind: 0,
          staged: 0,
          unstaged: 1,
          untracked: 1,
          conflicted: 0,
          readAt: 0
        }
      },
      changes: { w1: { worktreeId: 'w1', changes: uncommitted, total: 2, limit: 500, truncated: false, readAt: 0 } }
    })
  })

  it('commits all of it with the message typed, and only then merges', async () => {
    call.mockImplementation((method: unknown, params: unknown) => {
      if (method === 'worktree.commit') return Promise.resolve(commit)
      if (method === 'worktree.mergeIntoBase') return Promise.resolve(plan)
      if (method === 'worktree.changes' && (params as { base?: boolean }).base === true) return Promise.resolve(branch)
      return new Promise(() => {})
    })
    render(<ConfirmMergeDialog worktreeId="w1" />)

    expect(screen.getByText('2 uncommitted')).toBeTruthy()
    expect(screen.getByText('notes.md')).toBeTruthy()
    const confirm = screen.getByRole('button', { name: 'Commit & Merge' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)

    fireEvent.change(screen.getByRole('textbox', { name: 'Commit message' }), { target: { value: 'Add usage' } })
    fireEvent.click(confirm)

    await waitFor(() => expect(call).toHaveBeenCalledWith('worktree.mergeIntoBase', { worktreeId: 'w1' }))
    const methods = call.mock.calls.map(([method, params]) => [method, params])
    const committed = methods.findIndex(([method]) => method === 'worktree.commit')
    const merged = methods.findIndex(
      ([method, params]) => method === 'worktree.mergeIntoBase' && (params as { dryRun?: boolean }).dryRun !== true
    )
    expect(methods[committed]).toEqual(['worktree.commit', { worktreeId: 'w1', message: 'Add usage', all: true }])
    expect(committed).toBeLessThan(merged)
  })

  // The Changes list stops at 500; the commit before the merge must take all 2,000.
  it('commits and merges past the list cap, counting every change', async () => {
    const listed = Array.from({ length: 500 }, (_, index) => ({
      path: `src/f${index}.ts`,
      kind: 'modified' as const,
      staged: false,
      unstaged: true
    }))
    useWorkspaceStore.setState((state) => ({
      statuses: { w1: { ...state.statuses.w1!, unstaged: 1000, untracked: 1000 } },
      changes: { w1: { worktreeId: 'w1', changes: listed, total: 2000, limit: 500, truncated: true, readAt: 0 } }
    }))
    call.mockImplementation((method: unknown, params: unknown) => {
      if (method === 'worktree.commit') return Promise.resolve(commit)
      if (method === 'worktree.mergeIntoBase') return Promise.resolve(plan)
      if (method === 'worktree.changes' && (params as { base?: boolean }).base === true) return Promise.resolve(branch)
      return new Promise(() => {})
    })
    render(<ConfirmMergeDialog worktreeId="w1" />)

    expect(screen.getByText('2,000 uncommitted')).toBeTruthy()
    expect(screen.getByText('+1,995 more')).toBeTruthy()
    const confirm = screen.getByRole('button', { name: 'Commit & Merge' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    expect(confirm.title).toBe('Needs a commit message')
    expect(screen.getByText('Needs a commit message')).toBeTruthy()

    fireEvent.change(screen.getByRole('textbox', { name: 'Commit message' }), { target: { value: 'Everything' } })
    expect(confirm.disabled).toBe(false)
    expect(screen.queryByText('Needs a commit message')).toBeNull()
    fireEvent.click(confirm)

    await waitFor(() => expect(call).toHaveBeenCalledWith('worktree.mergeIntoBase', { worktreeId: 'w1' }))
    expect(call).toHaveBeenCalledWith('worktree.commit', { worktreeId: 'w1', message: 'Everything', all: true })
  })

  const box = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: 'Commit message' }) as HTMLTextAreaElement
  const answering = (method: unknown, params: unknown): Promise<unknown> => {
    if (method === 'worktree.commit') return Promise.resolve(commit)
    if (method === 'worktree.mergeIntoBase') return Promise.resolve(plan)
    if (method === 'worktree.changes' && (params as { base?: boolean }).base === true) return Promise.resolve(branch)
    return new Promise(() => {})
  }

  it('starts with the done report, selected, and merges it on Enter with no typing', async () => {
    call.mockImplementation(answering)
    useWorkspaceStore.setState({
      worktrees: [
        {
          ...worktree,
          task: 'Fix the typo',
          report: { outcome: 'succeeded', summary: 'Fixed the README typo.', paths: [], at: 0 }
        }
      ]
    })
    render(<ConfirmMergeDialog worktreeId="w1" />)

    expect(box().value).toBe('Fixed the README typo.')
    expect(box().selectionStart).toBe(0)
    expect(box().selectionEnd).toBe('Fixed the README typo.'.length)
    expect(screen.getByText('from report')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Commit & Merge' }) as HTMLButtonElement).disabled).toBe(false)
    expect(call).not.toHaveBeenCalledWith('worktree.commit', expect.anything())

    fireEvent.keyDown(box(), { key: 'Enter' })
    await waitFor(() => expect(call).toHaveBeenCalledWith('worktree.mergeIntoBase', { worktreeId: 'w1' }))
    expect(call).toHaveBeenCalledWith('worktree.commit', {
      worktreeId: 'w1',
      message: 'Fixed the README typo.',
      all: true
    })
  })

  it('starts with the task’s first line when there is no report', () => {
    useWorkspaceStore.setState({ worktrees: [{ ...worktree, task: 'Fix the typo\n\nIn the README.' }] })
    render(<ConfirmMergeDialog worktreeId="w1" />)
    expect(box().value).toBe('Fix the typo')
    expect(screen.getByText('from task')).toBeTruthy()
  })

  it('shows what was typed in the Changes box, not the report', () => {
    useWorkspaceStore.setState({
      worktrees: [{ ...worktree, report: { outcome: 'succeeded', summary: 'Fixed it.', paths: [], at: 0 } }]
    })
    useCommitDrafts.getState().setDraft('w1', { text: 'Typo in README', seed: 'Fixed it.' })
    render(<ConfirmMergeDialog worktreeId="w1" />)
    expect(box().value).toBe('Typo in README')
    expect(screen.queryByText('from report')).toBeNull()
  })

  it('clears the suggestion with ✕, which asks for a message again', () => {
    useWorkspaceStore.setState({ worktrees: [{ ...worktree, task: 'Fix the typo' }] })
    render(<ConfirmMergeDialog worktreeId="w1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Clear message' }))
    expect(box().value).toBe('')
    expect(screen.getByText('Needs a commit message')).toBeTruthy()
  })

  it('says why Merge waits on the checkout it lands in', async () => {
    call.mockImplementation((method: unknown, params: unknown) => {
      if (method === 'worktree.mergeIntoBase') return Promise.resolve({ ...plan, dirty: ['README.md'] })
      if (method === 'worktree.changes' && (params as { base?: boolean }).base === true) return Promise.resolve(branch)
      return new Promise(() => {})
    })
    render(<ConfirmMergeDialog worktreeId="w1" />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Commit message' }), { target: { value: 'Everything' } })

    const confirm = screen.getByRole('button', { name: 'Commit & Merge' }) as HTMLButtonElement
    await waitFor(() => expect(confirm.title).toBe('acme-api has uncommitted changes'))
    expect(confirm.disabled).toBe(true)
  })

  it('merges nothing when the commit is refused, and says why', async () => {
    call.mockImplementation((method: unknown, params: unknown) => {
      if (method === 'worktree.commit') return Promise.reject(new Error('no git identity'))
      if (method === 'worktree.mergeIntoBase') return Promise.resolve(plan)
      if (method === 'worktree.changes' && (params as { base?: boolean }).base === true) return Promise.resolve(branch)
      return new Promise(() => {})
    })
    render(<ConfirmMergeDialog worktreeId="w1" />)

    fireEvent.change(screen.getByRole('textbox', { name: 'Commit message' }), { target: { value: 'Add usage' } })
    fireEvent.click(screen.getByRole('button', { name: 'Commit & Merge' }))

    expect((await screen.findByRole('alert')).textContent).toBe('no git identity')
    expect(call).not.toHaveBeenCalledWith('worktree.mergeIntoBase', { worktreeId: 'w1' })
  })
})

describe('pushing main after the merge', () => {
  const landing: WorktreeLanding = {
    worktreeId: 'w1',
    branch: 'fix-typo',
    base: 'main',
    host: null,
    published: false,
    unmerged: 2,
    merged: false,
    readAt: 0,
    remote: true
  }
  const base: ProjectBase = { projectId: 'p1', branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0 }
  const merged =
    (extra: Partial<WorktreeMerge>): ((method: unknown, params: unknown) => Promise<unknown>) =>
    (method, params) => {
      if (method === 'worktree.mergeIntoBase') {
        return Promise.resolve((params as { dryRun?: boolean }).dryRun ? plan : { ...plan, merged: true, ...extra })
      }
      if (method === 'worktree.changes') return Promise.resolve(branch)
      return new Promise(() => {})
    }
  const box = (): HTMLInputElement => screen.getByRole('checkbox', { name: 'Push main to origin' }) as HTMLInputElement

  beforeEach(() => {
    useWorkspaceStore.setState({ landings: { w1: landing }, bases: { p1: base }, pushOnMerge: {} })
  })

  it('is on when main tracks origin, and lands and pushes in one step', async () => {
    call.mockImplementation(merged({ pushed: true }))
    render(<ConfirmMergeDialog worktreeId="w1" />)

    expect(box().checked).toBe(true)
    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }))

    await waitFor(() => expect(call).toHaveBeenCalledWith('worktree.mergeIntoBase', { worktreeId: 'w1', push: true }))
    await waitFor(() => expect(useWorkspaceStore.getState().dialog).toBeNull())
  })

  it('is off when main tracks nothing', () => {
    useWorkspaceStore.setState({ bases: { p1: { ...base, upstream: undefined } } })
    render(<ConfirmMergeDialog worktreeId="w1" />)
    expect(box().checked).toBe(false)
  })

  it('remembers an opt-out for the project', async () => {
    call.mockImplementation(merged({}))
    render(<ConfirmMergeDialog worktreeId="w1" />)
    fireEvent.click(box())
    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }))

    await waitFor(() => expect(call).toHaveBeenCalledWith('worktree.mergeIntoBase', { worktreeId: 'w1', push: false }))
    expect(useWorkspaceStore.getState().pushOnMerge).toEqual({ p1: false })
    cleanup()
    render(<ConfirmMergeDialog worktreeId="w1" />)
    expect(box().checked).toBe(false)
  })

  it('is not offered for a child, which lands in its parent', () => {
    useWorkspaceStore.setState({
      worktrees: [{ ...worktree, parentId: 'w0' }],
      landings: { w1: { ...landing, parent: { worktreeId: 'w0', name: 'Rework' } } }
    })
    render(<ConfirmMergeDialog worktreeId="w1" />)
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('hands a push that did not land to the push dialog, the merge standing', async () => {
    const pushError = {
      message: 'origin/main moved',
      detail: '! [rejected] main -> main (fetch first)',
      kind: 'rejected' as const
    }
    call.mockImplementation(merged({ pushed: false, pushError }))
    render(<ConfirmMergeDialog worktreeId="w1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }))

    await waitFor(() =>
      expect(useWorkspaceStore.getState().dialog).toEqual({ kind: 'push-base', projectId: 'p1', failure: pushError })
    )
  })
})

describe('a merge that would conflict', () => {
  const parent: Worktree = { ...worktree, id: 'w0', name: 'Checkout tax', branch: 'checkout-tax' }
  const payment: Worktree = {
    ...worktree,
    name: 'Payment',
    branch: 'checkout-tax--payment',
    parentId: 'w0',
    baseRef: 'checkout-tax'
  }
  const conflicted: WorktreeMerge = {
    ...plan,
    into: 'checkout-tax',
    fastForward: false,
    conflicts: ['src/shared/money.js']
  }
  const stopped = {
    worktreeId: 'w1',
    baseRef: 'checkout-tax',
    mode: 'merge',
    outcome: 'conflicts',
    conflicts: ['src/shared/money.js'],
    updatedAt: 0
  }

  const midMerge = {
    worktreeId: 'w1',
    branch: 'checkout-tax--payment',
    ahead: 1,
    behind: 1,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 1,
    operation: 'merge',
    readAt: 0
  } as const

  beforeEach(() => {
    useWorkspaceStore.setState({
      worktrees: [parent, payment],
      agents: [{ kind: 'claude', command: 'claude', binary: '/bin/claude' }],
      defaultAgent: 'claude'
    })
    call.mockImplementation((method: unknown) => {
      if (method === 'worktree.mergeIntoBase') return Promise.resolve(conflicted)
      if (method === 'worktree.update') return Promise.resolve(stopped)
      if (method === 'terminal.create') return Promise.resolve({ id: 't9', worktreeId: 'w1', running: true })
      if (method === 'worktree.status') return Promise.resolve(midMerge)
      return new Promise(() => {})
    })
  })

  it('says which files instead of offering a Merge that cannot land, and names the parent task', async () => {
    render(<ConfirmMergeDialog worktreeId="w1" />)
    await screen.findByText('Conflicts with Checkout tax')
    expect(screen.getByText('src/shared/money.js')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Merge' })).toBeNull()
    expect(screen.queryByText(/checkout-tax--payment/)).toBeNull()
  })

  it('updates from the parent into the task, where the conflict can be resolved, and shows it', async () => {
    render(<ConfirmMergeDialog worktreeId="w1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Update from Parent' }))
    await waitFor(() => expect(call).toHaveBeenCalledWith('worktree.update', { worktreeId: 'w1', landing: true }))
    expect(useWorkspaceStore.getState().dialog).toBeNull()
    expect(useWorkspaceStore.getState().rightPanelTab).toBe('changes')
  })

  it('asks the default agent to resolve, starting it on the conflicts the update stopped on', async () => {
    render(<ConfirmMergeDialog worktreeId="w1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Ask Claude Code to Resolve' }))
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('terminal.create', expect.objectContaining({ worktreeId: 'w1' }))
    )
    const created = call.mock.calls.find(([method]) => method === 'terminal.create')?.[1] as { prompt: string }
    expect(created.prompt).toContain('src/shared/money.js')
    expect(created.prompt).toContain('Checkout tax is being merged into Payment')
  })

  it('learns of the conflict from a merge that failed on it, and stops offering Merge', async () => {
    let dry = true
    call.mockImplementation((method: unknown, params: unknown) => {
      if (method === 'worktree.mergeIntoBase') {
        if ((params as { dryRun?: boolean }).dryRun === true) return Promise.resolve(dry ? plan : conflicted)
        dry = false
        return Promise.reject(new Error('checkout-tax--payment conflicts with checkout-tax in src/shared/money.js'))
      }
      return new Promise(() => {})
    })
    render(<ConfirmMergeDialog worktreeId="w1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }))
    await screen.findByText('Conflicts with Checkout tax')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Merge' })).toBeNull()
  })

  it('points at the conflicts already in the task while it is mid-update', async () => {
    useWorkspaceStore.setState({ statuses: { w1: midMerge } })
    render(<ConfirmMergeDialog worktreeId="w1" />)
    expect(await screen.findByText('Merging Checkout tax into Payment · 1 conflicted')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show Conflicts' }))
    expect(useWorkspaceStore.getState().dialog).toBeNull()
    expect(useWorkspaceStore.getState().rightPanelTab).toBe('changes')
  })
})

describe('a parent with children not merged', () => {
  const child = (id: string, name: string, extra: Partial<Worktree> = {}): Worktree => ({
    ...worktree,
    id,
    name,
    branch: `fix-typo--${id}`,
    path: `/repos/acme-wt/${id}`,
    parentId: 'w1',
    ...extra
  })
  const done = { outcome: 'succeeded' as const, summary: 'Done.', paths: [], at: 0 }
  const ahead = (worktreeId: string): WorktreeMergePreview => ({
    worktreeId,
    baseRef: 'fix-typo',
    state: 'clean',
    ahead: 1,
    conflicts: [],
    readAt: 0
  })

  beforeEach(() => {
    call.mockImplementation((method: unknown, params: unknown) => {
      if (method === 'worktree.mergeIntoBase') return Promise.resolve(plan)
      if (method === 'worktree.changes' && (params as { base?: boolean }).base === true) return Promise.resolve(branch)
      return new Promise(() => {})
    })
    useChildren.setState({ merging: {}, stopped: {}, reveal: null })
    useWorkspaceStore.setState({
      worktrees: [
        worktree,
        child('c1', 'Search page', { report: done }),
        child('c2', 'Cart totals'),
        child('c3', 'Old one', { report: done })
      ],
      mergePreviews: { c1: ahead('c1'), c2: ahead('c2'), c3: { ...ahead('c3'), ahead: 0, state: 'nothingToMerge' } },
      landings: {
        c3: {
          worktreeId: 'c3',
          branch: 'fix-typo--c3',
          base: 'fix-typo',
          host: null,
          published: false,
          unmerged: 0,
          merged: true,
          readAt: 0,
          parent: { worktreeId: 'w1', name: 'fix typo' }
        }
      }
    })
  })

  it('warns how many are not merged', () => {
    render(<ConfirmMergeDialog worktreeId="w1" />)
    expect(screen.getByText('2 children not merged')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Merge Them First' })).toBeTruthy()
  })

  it('says nothing once every child has landed', () => {
    useWorkspaceStore.setState({ worktrees: [worktree, child('c3', 'Old one', { report: done })] })
    render(<ConfirmMergeDialog worktreeId="w1" />)
    expect(screen.queryByText(/not merged/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Merge Them First' })).toBeNull()
  })

  it('Merge Them First lands them in order, then asks again about the parent', async () => {
    const mergeChildren = vi.fn(async () => true)
    useChildren.setState({ mergeChildren })
    render(<ConfirmMergeDialog worktreeId="w1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Merge Them First' }))

    expect(mergeChildren).toHaveBeenCalledWith('w1', ['c1', 'c2'])
    expect(call).not.toHaveBeenCalledWith('worktree.mergeIntoBase', { worktreeId: 'w1' })
    await waitFor(() =>
      expect(useWorkspaceStore.getState().dialog).toEqual({ kind: 'confirm-merge', worktreeId: 'w1' })
    )
  })

  it('a stop leaves the parent unmerged and shows its Children', async () => {
    const mergeChildren = vi.fn(async () => false)
    const showChildren = vi.fn(async () => {})
    useChildren.setState({ mergeChildren, showChildren })
    render(<ConfirmMergeDialog worktreeId="w1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Merge Them First' }))

    await waitFor(() => expect(showChildren).toHaveBeenCalledWith('w1'))
    expect(useWorkspaceStore.getState().dialog).toBeNull()
  })
})
