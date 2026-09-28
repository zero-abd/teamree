/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Terminal,
  Worktree,
  WorktreeChange,
  WorktreeLanding,
  WorktreeLog,
  WorktreePush,
  WorktreeStatus
} from '@shared/entities'
import { fileColumnIn, fileLeavesIn, isCommitLeaf, isReviewLeaf } from '@shared/filePane'

const call = vi.fn()
const openInBrowser = vi.fn()

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
vi.mock('../../shell/openInBrowser', () => ({ openInBrowser: (url: string) => openInBrowser(url) }))

const { LOCK_RETRY_MS, useWorkspaceStore } = await import('../../state/workspaceStore')
const { ChangesTab } = await import('./ChangesTab')
const { canDiscard } = await import('./sourceControl')
const { useScmView } = await import('./scmView')
const { ConfirmDiscardDialog } = await import('../../dialogs/ConfirmDiscardDialog')
const { FilePane } = await import('../../panes/FilePane')
const { useReviewStore } = await import('../../review/reviewStore')
const { useCommitDrafts } = await import('./commitMessage')

const INITIAL = useWorkspaceStore.getState()
const SCM = useScmView.getState()

const status = (overrides: Partial<WorktreeStatus> = {}): WorktreeStatus => ({
  worktreeId: 'w1',
  branch: 'rewrite-the-pager',
  upstream: 'origin/rewrite-the-pager',
  ahead: 1,
  behind: 0,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicted: 0,
  readAt: 0,
  ...overrides
})

const log: WorktreeLog = {
  worktreeId: 'w1',
  baseRef: 'origin/main',
  commits: [{ sha: 'a'.repeat(40), shortSha: 'aaaaaaa', author: 'A', committedAt: '', subject: 'Rank by recency' }],
  truncated: false,
  readAt: 0
}

const pushed: WorktreePush = {
  worktreeId: 'w1',
  remote: 'origin',
  branch: 'rewrite-the-pager',
  alreadyUpToDate: false,
  upstream: 'origin/rewrite-the-pager',
  setUpstream: false,
  uncommitted: 0,
  reviewUrl: 'https://github.com/team/pager/compare/main...rewrite-the-pager?expand=1',
  pushedAt: 0
}

function seed(overrides: Partial<WorktreeStatus> = {}): void {
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      activeWorktreeId: 'w1',
      changes: { w1: { worktreeId: 'w1', changes: [], total: 0, limit: 500, truncated: false, readAt: 0 } },
      statuses: { w1: status(overrides) },
      logs: { w1: log }
    },
    true
  )
}

const rows: WorktreeChange[] = [
  { path: 'README.md', kind: 'modified', staged: false, unstaged: true },
  { path: 'src/app.ts', kind: 'untracked', staged: false, unstaged: true },
  { path: 'src/gone.ts', kind: 'deleted', staged: false, unstaged: true }
]

function withChanges(changes: WorktreeChange[]): void {
  useWorkspaceStore.setState({
    changes: { w1: { worktreeId: 'w1', changes, total: changes.length, limit: 500, truncated: false, readAt: 0 } }
  })
}

/** What the runtime throws for a refused push: one clause, git's words in `data`. */
function refusal(label: string, detail: string): Error {
  return Object.assign(new Error(label), { data: { detail } })
}

/** A push that answers when the test says so. */
function pendingPush(): PromiseWithResolvers<WorktreePush> {
  const push = Promise.withResolvers<WorktreePush>()
  call.mockImplementation((method: string) => (method === 'worktree.push' ? push.promise : new Promise(() => {})))
  return push
}

const childWorktree = {
  id: 'w1',
  projectId: 'p1',
  name: 'Write tests',
  branch: 'rework-auth--write-tests',
  path: '/wt/rework-auth--write-tests',
  startedFrom: 'abc',
  state: 'ready' as const,
  createdAt: 0,
  parentId: 'w0',
  baseRef: 'rework-auth'
}

/** The header's ⋯ menu, opened; its rows are what the header does not show. */
function moreMenu(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
  return screen.getByRole('menu', { name: 'More actions' })
}

beforeEach(() => {
  call.mockReset()
  call.mockImplementation(() => new Promise(() => {}))
  openInBrowser.mockReset()
  useReviewStore.setState({ viewed: {}, batch: {}, queued: {}, scope: {}, jump: {} })
  useCommitDrafts.setState({ drafts: {}, amends: {} })
  useScmView.setState(SCM, true)
  seed()
})

/** A folded section's heading, opened. */
function unfold(name: RegExp): void {
  fireEvent.click(screen.getByRole('button', { name, expanded: false }))
}

describe('files another task changes too', () => {
  const task = (id: string, name: string): Worktree => ({
    id,
    projectId: 'p1',
    name,
    branch: name.toLowerCase().replaceAll(' ', '-'),
    path: `/wt/${id}`,
    startedFrom: 'abc',
    state: 'ready',
    createdAt: 0
  })

  it('says which task and how many files under the header, and opens Compare on the first', async () => {
    const { useOverlaps } = await import('../../state/overlapStore')
    const openCompare = vi.fn(async () => {})
    useWorkspaceStore.setState({
      worktrees: [task('w1', 'Rewrite the pager'), task('w2', 'Add rate limits')],
      openCompare
    })
    useOverlaps.setState({
      byProject: {
        p1: [
          { worktreeId: 'w1', with: { worktreeId: 'w2' }, paths: ['src/a.ts', 'src/b.ts'], conflicts: [] },
          { worktreeId: 'w2', with: { worktreeId: 'w1' }, paths: ['src/a.ts', 'src/b.ts'], conflicts: [] }
        ]
      }
    })
    render(<ChangesTab />)
    const line = screen.getByRole('button', { name: /Overlaps with Add rate limits: 2 files/ })
    fireEvent.click(line)
    expect(openCompare).toHaveBeenCalledWith('w1', 'w2', 'Rewrite the pager vs Add rate limits', 'src/a.ts')
    useOverlaps.setState({ byProject: {} })
  })
})

describe('pushing from the changes tab', () => {
  it('pushes, shows it is busy, then offers the review page', async () => {
    const push = pendingPush()
    render(<ChangesTab />)

    fireEvent.click(screen.getByRole('button', { name: 'Push' }))
    expect(call).toHaveBeenCalledWith('worktree.push', { worktreeId: 'w1' })
    expect(screen.getByRole('button', { name: 'Pushing…' })).toHaveProperty('disabled', true)

    await act(async () => push.resolve(pushed))
    fireEvent.click(screen.getByRole('button', { name: 'Open Review' }))
    expect(openInBrowser).toHaveBeenCalledWith(pushed.reviewUrl)
    expect(screen.queryByRole('button', { name: 'Push' })).toBeNull()
  })

  it('says a failed push in one line under the header, with git’s words behind Details and a Retry', async () => {
    const push = pendingPush()
    render(<ChangesTab />)

    fireEvent.click(screen.getByRole('button', { name: 'Push' }))
    const said = "fatal: '/tmp/missing.git' does not appear to be a git repository"
    await act(async () => push.reject(refusal('origin not found', said)))

    expect(screen.getByRole('alert').textContent).toBe('Push failed: origin not found')
    const head = screen.getByRole('button', { name: 'Push' }).parentElement as HTMLElement
    expect(head.contains(screen.getByRole('alert'))).toBe(false)
    expect(useWorkspaceStore.getState().notices).toEqual([])

    expect(screen.queryByText(said)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByRole('dialog', { name: 'git output' }).textContent).toBe(said)
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'git output' }), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()

    call.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(call).toHaveBeenCalledWith('worktree.push', { worktreeId: 'w1' })
  })

  it('offers neither force nor a pull that does not exist when the remote is ahead', async () => {
    const push = pendingPush()
    render(<ChangesTab />)

    fireEvent.click(screen.getByRole('button', { name: 'Push' }))
    await act(async () => push.reject(refusal('remote is ahead', 'rejected (fetch first)')))

    expect(screen.getByRole('alert').textContent).toBe('Push failed: remote is ahead')
    expect(screen.getByRole('button', { name: 'Push' })).toHaveProperty('disabled', false)
    expect(screen.queryByRole('button', { name: /force|pull/i })).toBeNull()
  })

  it('says a failure git never explained in two words, the message behind Details', async () => {
    const push = pendingPush()
    render(<ChangesTab />)

    fireEvent.click(screen.getByRole('button', { name: 'Push' }))
    await act(async () => push.reject(new Error('worktree w1 is not ready for pushing')))

    expect(screen.getByRole('alert').textContent).toBe('Push failed')
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByRole('dialog', { name: 'git output' }).textContent).toBe('worktree w1 is not ready for pushing')
  })

  it('brings the Changes tab up when a push from elsewhere fails', async () => {
    const push = pendingPush()
    useWorkspaceStore.setState({ rightPanelOpen: false, rightPanelTab: 'files' })

    const pushing = useWorkspaceStore.getState().pushActiveWorktree()
    await act(async () => {
      push.reject(refusal('Offline', 'Could not resolve host: example.invalid'))
      await pushing
    })

    expect(useWorkspaceStore.getState()).toMatchObject({ rightPanelOpen: true, rightPanelTab: 'changes' })
    expect(useWorkspaceStore.getState().notices).toEqual([])
  })

  it('toasts nothing when it lands where the tab shows it', async () => {
    const push = pendingPush()
    useWorkspaceStore.setState({ rightPanelOpen: true, rightPanelTab: 'changes' })
    render(<ChangesTab />)

    fireEvent.click(screen.getByRole('button', { name: 'Push' }))
    await act(async () => push.resolve({ ...pushed, setUpstream: true, uncommitted: 2 }))

    expect(screen.getByRole('button', { name: 'Open Review' })).toBeTruthy()
    expect(useWorkspaceStore.getState().notices).toEqual([])
  })

  it('toasts Pushed, with the review, when the tab is not on screen', async () => {
    const push = pendingPush()
    useWorkspaceStore.setState({ rightPanelOpen: false })

    const pushing = useWorkspaceStore.getState().pushActiveWorktree()
    await act(async () => {
      push.resolve(pushed)
      await pushing
    })

    const [notice] = useWorkspaceStore.getState().notices
    expect(notice).toMatchObject({
      text: 'Pushed',
      tone: 'info',
      action: { label: 'Open Review', url: pushed.reviewUrl }
    })
  })

  it('hides Publish on a worktree with nothing in it', () => {
    seed({ upstream: null, ahead: 0 })
    useWorkspaceStore.setState({ logs: { w1: { ...log, commits: [] } } })
    render(<ChangesTab />)
    expect(screen.queryByRole('button', { name: 'Publish Branch' })).toBeNull()
  })

  it('offers nothing when the upstream has every commit', () => {
    seed({ ahead: 0 })
    render(<ChangesTab />)
    expect(screen.queryByRole('button', { name: /push|publish|review/i })).toBeNull()
  })
})

describe('which button is the next step', () => {
  const primary = (name: string): boolean => screen.getByRole('button', { name }).classList.contains('button--primary')

  it('is Commit while there are changes, with Push beside it quiet', () => {
    withChanges(rows)
    render(<ChangesTab />)
    expect(primary('Commit All 3')).toBe(true)
    expect(primary('Push')).toBe(false)
  })

  it('is Push once everything is committed and some of it is not on the remote', () => {
    seed({ ahead: 2 })
    render(<ChangesTab />)
    expect(primary('Push')).toBe(true)
  })

  // Publishing a branch with no commits sends one identical to its base.
  it('is Commit, with no Publish, on a new branch that has only edits', () => {
    seed({ upstream: null, ahead: 0 })
    withChanges(rows)
    render(<ChangesTab />)
    expect(primary('Commit All 3')).toBe(true)
    expect(screen.queryByRole('button', { name: 'Publish Branch' })).toBeNull()
  })

  it('offers Publish, quiet, beside Commit once the new branch has a commit', () => {
    seed({ upstream: null, ahead: 1 })
    withChanges(rows)
    render(<ChangesTab />)
    expect(primary('Commit All 3')).toBe(true)
    expect(primary('Publish Branch')).toBe(false)
  })

  it('is Publish on a new branch with commits and nothing uncommitted', () => {
    seed({ upstream: null, ahead: 1 })
    render(<ChangesTab />)
    expect(primary('Publish Branch')).toBe(true)
  })
})

describe('landing the work', () => {
  const primary = (name: string): boolean => screen.getByRole('button', { name }).classList.contains('button--primary')
  const landing = (overrides: Partial<WorktreeLanding> = {}): WorktreeLanding => ({
    worktreeId: 'w1',
    branch: 'rewrite-the-pager',
    base: 'main',
    host: 'github',
    published: true,
    unmerged: 1,
    merged: false,
    compareUrl: 'https://github.com/team/pager/compare/main...rewrite-the-pager?expand=1',
    readAt: 0,
    ...overrides
  })
  const landed = (
    overrides: Partial<WorktreeLanding>,
    statusOverrides: Partial<WorktreeStatus> = { ahead: 0 }
  ): void => {
    seed(statusOverrides)
    useWorkspaceStore.setState({ landings: { w1: landing(overrides) } })
  }

  it('is Create Pull Request… once there is something to land, and asks in the one-step dialog', () => {
    landed({})
    render(<ChangesTab />)

    expect(primary('Create Pull Request…')).toBe(true)
    expect(screen.queryByRole('button', { name: 'Open Review' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Create Pull Request…' }))

    expect(useWorkspaceStore.getState().dialog).toEqual({ kind: 'create-pr', worktreeId: 'w1' })
    expect(call).not.toHaveBeenCalledWith('worktree.createPullRequest', expect.anything())
  })

  it('reads Open Pull Request with its number once there is one, and opens it', () => {
    landed({ pullRequest: { number: 12, url: 'https://github.com/team/pager/pull/12', state: 'open' } })
    render(<ChangesTab />)

    fireEvent.click(screen.getByRole('button', { name: 'Open Pull Request #12' }))
    expect(openInBrowser).toHaveBeenCalledWith('https://github.com/team/pager/pull/12')
    expect(useWorkspaceStore.getState().dialog).toBeNull()
  })

  it('is Merge into main… for an origin on no known host, and asks before merging', () => {
    landed({ host: null, published: false, compareUrl: undefined }, { upstream: null, ahead: 1 })
    render(<ChangesTab />)

    expect(primary('Merge into main…')).toBe(true)
    expect(screen.queryByRole('button', { name: 'Publish Branch' })).toBeNull()
    expect(within(moreMenu()).getByRole('menuitem', { name: 'Publish Branch' })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Merge into main…' }))
    expect(useWorkspaceStore.getState().dialog).toEqual({ kind: 'confirm-merge', worktreeId: 'w1' })
    expect(call).not.toHaveBeenCalledWith('worktree.mergeIntoBase', expect.anything())
  })

  it('is Merge into the parent for a child, even on a known host, and never a pull request', () => {
    landed({ base: 'rework-auth', host: null, parent: { worktreeId: 'w0', name: 'Rework auth' } })
    render(<ChangesTab />)

    expect(primary('Merge into Parent…')).toBe(true)
    expect(screen.getByRole('button', { name: 'Merge into Parent…' }).title).toBe('Merge into Rework auth')
    expect(screen.queryByRole('button', { name: 'Create Pull Request…' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Merge into Parent…' }))
    expect(useWorkspaceStore.getState().dialog).toEqual({ kind: 'confirm-merge', worktreeId: 'w1' })
  })

  it('creates the pull request while the remote lacks commits, with Push or Publish in the menu', () => {
    landed({}, { ahead: 1 })
    const { unmount } = render(<ChangesTab />)
    expect(primary('Create Pull Request…')).toBe(true)
    expect(screen.queryByRole('button', { name: 'Push' })).toBeNull()
    expect(within(moreMenu()).getByRole('menuitem', { name: 'Push' })).toBeTruthy()
    unmount()

    landed({ published: false }, { upstream: null, ahead: 1 })
    render(<ChangesTab />)
    expect(primary('Create Pull Request…')).toBe(true)
    expect(within(moreMenu()).getByRole('menuitem', { name: 'Publish Branch' })).toBeTruthy()
  })

  it('keeps the merge on screen with uncommitted work, as Commit & Merge, and asks before committing', () => {
    landed({ host: null, unmerged: 0 }, { ahead: 0, unstaged: 2, untracked: 1 })
    withChanges(rows)
    render(<ChangesTab />)

    const button = screen.getByRole('button', { name: 'Commit & Merge into main…' })
    expect(primary('Commit All 3')).toBe(true)
    expect(button.className).not.toContain('button--primary')
    expect(button.title).toBe('3 uncommitted')
    fireEvent.click(button)
    expect(useWorkspaceStore.getState().dialog).toEqual({ kind: 'confirm-merge', worktreeId: 'w1' })
    expect(call).not.toHaveBeenCalledWith('worktree.commit', expect.anything())
  })

  it('is Commit & Create Pull Request… while there are changes, quiet beside Commit, and opens the dialog', () => {
    landed({}, { ahead: 0, unstaged: 1 })
    withChanges(rows.slice(0, 1))
    render(<ChangesTab />)

    const button = screen.getByRole('button', { name: 'Commit & Create Pull Request…' }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    expect(button.title).toBe('1 uncommitted')
    expect(primary('Commit & Create Pull Request…')).toBe(false)
    fireEvent.click(button)
    expect(useWorkspaceStore.getState().dialog).toEqual({ kind: 'create-pr', worktreeId: 'w1' })
  })

  it('offers no Publish in a repository with no remote', () => {
    landed({ host: null, published: false, compareUrl: undefined, remote: false }, { upstream: null, ahead: 1 })
    render(<ChangesTab />)

    expect(screen.getByRole('button', { name: 'Merge into main…' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Publish Branch' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull()
  })

  it('tidies a child’s branch actions to one button and a menu for the rest', () => {
    landed(
      { base: 'rework-auth', host: null, published: false, parent: { worktreeId: 'w0', name: 'Rework auth' } },
      { upstream: null, ahead: 1, behind: 1 }
    )
    useWorkspaceStore.setState({ worktrees: [childWorktree] })
    render(<ChangesTab />)

    const head = document.querySelector('.changes__actions') as HTMLElement
    expect(
      within(head)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label') ?? button.textContent)
    ).toEqual(['Merge into Parent…', 'More actions'])
    expect(primary('Merge into Parent…')).toBe(true)
    expect(
      within(moreMenu())
        .getAllByRole('menuitem')
        .map((item) => item.textContent)
    ).toEqual(['Publish Branch', 'Update from Parent'])
  })

  it('says Merged once the branch is in its base, and offers the removal', () => {
    landed({ merged: true, unmerged: 0 })
    render(<ChangesTab />)

    expect(screen.getByText('Merged').getAttribute('title')).toBe('Merged into main')
    expect(screen.queryByRole('button', { name: 'Create Pull Request…' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Delete Worktree…' }))
    expect(useWorkspaceStore.getState().dialog).toMatchObject({ kind: 'confirm-remove', worktreeId: 'w1' })
  })

  it('offers the removal and never a merge on a branch that made nothing', () => {
    landed({ host: null, published: false, unmerged: 0, compareUrl: undefined }, { upstream: null, ahead: 0 })
    useWorkspaceStore.setState({ logs: { w1: { ...log, commits: [] } } })
    render(<ChangesTab />)

    expect(screen.getByText('No changes')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Merge/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Delete Worktree…' }))
    expect(useWorkspaceStore.getState().dialog).toMatchObject({ kind: 'confirm-remove', worktreeId: 'w1' })
  })

  it('says not pushed while the merge is only in the local main', () => {
    landed({ merged: true, unmerged: 0, notPushed: true })
    render(<ChangesTab />)

    expect(screen.getByText('Merged · not pushed')).toBeTruthy()
  })
})

describe('committing', () => {
  const message = (text: string): void => {
    fireEvent.change(screen.getByRole('textbox', { name: 'Commit message' }), { target: { value: text } })
  }

  it('commits every listed change, new files included, when nothing is staged, and only the staged ones otherwise', () => {
    withChanges(rows)
    render(<ChangesTab />)
    message('Rank')

    fireEvent.click(screen.getByRole('button', { name: 'Stage src/app.ts' }))
    expect(screen.queryByRole('button', { name: 'Commit All 3' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Commit 1' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Unstage src/app.ts' }))

    fireEvent.click(screen.getByRole('button', { name: 'Commit All 3' }))
    expect(call).toHaveBeenCalledWith('worktree.commit', { worktreeId: 'w1', message: 'Rank', all: true })
  })

  // The list stops at 500 rows; the commit, the counts and Stage All must not.
  it('commits all 2,000 when only 500 are listed, and says how many are not', { timeout: 90_000 }, () => {
    const listed = Array.from(
      { length: 500 },
      (_, index): WorktreeChange => ({ path: `src/f${index}.ts`, kind: 'modified', staged: false, unstaged: true })
    )
    useWorkspaceStore.setState({
      changes: { w1: { worktreeId: 'w1', changes: listed, total: 2000, limit: 500, truncated: true, readAt: 0 } }
    })
    // Selector and text lookups: role and label queries rescan every row's buttons each time, for seconds apiece.
    const labelled = (label: string): HTMLElement | null => document.querySelector(`[aria-label="${label}"]`)
    render(<ChangesTab />)
    fireEvent.change(labelled('Commit message')!, { target: { value: 'Rank' } })

    expect(labelled('Changes')?.querySelector('.panel__count')?.textContent).toBe('2,000')
    expect(screen.getByText('+1,500 more')).toBeTruthy()
    expect(screen.getByText('Commit All 2,000', { selector: 'button' })).toBeTruthy()

    fireEvent.click(labelled('Stage All Changes')!)
    expect(labelled('Staged Changes')?.querySelector('.panel__count')?.textContent).toBe('2,000')
    expect(labelled('Changes')).toBeNull()
    fireEvent.click(screen.getByText('Commit All 2,000', { selector: 'button' }))
    expect(call).toHaveBeenCalledWith('worktree.commit', { worktreeId: 'w1', message: 'Rank', all: true })
  })

  it('empties the box once a commit held by a lock lands on Clear Lock, as any commit that lands does', async () => {
    vi.useFakeTimers()
    try {
      let held = true
      const lockPath = '/wt/.git/index.lock'
      call.mockImplementation((method: string) => {
        if (method === 'worktree.commit' && held)
          return Promise.reject(Object.assign(new Error('locked'), { data: { kind: 'locked', lockPath } }))
        if (method === 'worktree.commit')
          return Promise.resolve({ worktreeId: 'w1', sha: 'b'.repeat(40), shortSha: 'bbbbbbb', message: 'Rate to 9' })
        if (method === 'worktree.lock') return Promise.resolve({ lockPath, clearable: true })
        if (method === 'worktree.clearLock') {
          held = false
          return Promise.resolve({ lockPath })
        }
        return new Promise(() => {})
      })
      withChanges(rows)
      render(<ChangesTab />)
      message('Rate to 9')
      const box = screen.getByRole('textbox', { name: 'Commit message' }) as HTMLTextAreaElement

      fireEvent.click(screen.getByRole('button', { name: 'Commit All 3' }))
      await act(async () => vi.advanceTimersByTimeAsync(LOCK_RETRY_MS))
      expect(box.value).toBe('Rate to 9')

      await act(async () => useWorkspaceStore.getState().clearLock('w1', lockPath))
      expect(call).toHaveBeenLastCalledWith('worktree.commit', { worktreeId: 'w1', message: 'Rate to 9', all: true })
      expect(box.value).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts what it commits once a file is staged', () => {
    withChanges(rows)
    render(<ChangesTab />)
    fireEvent.click(screen.getByRole('button', { name: 'Stage README.md' }))
    expect(screen.getByRole('button', { name: 'Commit 1' })).toBeTruthy()
  })

  // An agent that only created files is the common case: its work must be one click from a commit.
  it('commits all on a worktree whose only changes are new files', () => {
    withChanges([{ path: 'src/app.ts', kind: 'untracked', staged: false, unstaged: true }])
    render(<ChangesTab />)
    message('Rank')

    const commitAll = screen.getByRole('button', { name: 'Commit All 1' })
    expect(commitAll.getAttribute('aria-disabled')).toBe('false')
    fireEvent.click(commitAll)
    expect(call).toHaveBeenCalledWith('worktree.commit', { worktreeId: 'w1', message: 'Rank', all: true })
  })

  // git lists a folder of new files as one path; the counts and the button are about the files in it.
  it('counts a folded folder of new files by the files in it, and commits every one', () => {
    withChanges([
      { path: 'README.md', kind: 'modified', staged: false, unstaged: true },
      { path: 'gen/', kind: 'untracked', staged: false, unstaged: true, files: 2000 },
      { path: 'src/app.ts', kind: 'untracked', staged: false, unstaged: true }
    ])
    render(<ChangesTab />)
    message('Rank')

    const folder = screen.getByTitle('gen/')
    expect(folder.querySelector('.change__name')?.textContent).toBe('gen')
    expect(folder.querySelector('.change__dir')).toBeNull()
    expect(folder.querySelector('.change__stat')?.textContent).toBe('2,000 files')
    expect(folder.querySelector('svg[data-icon="folder"]')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Open gen/' })).toBeNull()
    expect(screen.getByRole('region', { name: 'Changes' }).querySelector('.panel__count')?.textContent).toBe('2,002')

    fireEvent.click(screen.getByRole('button', { name: 'Stage gen/' }))
    expect(screen.getByRole('button', { name: 'Commit 2,000' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Unstage gen/' }))

    fireEvent.click(screen.getByRole('button', { name: 'Commit All 2,002' }))
    expect(call).toHaveBeenCalledWith('worktree.commit', { worktreeId: 'w1', message: 'Rank', all: true })
  })

  it('shows a folded folder of new files as one counted row in the tree, not a folder with a nameless file', () => {
    useScmView.setState({ view: 'tree' })
    withChanges([
      { path: 'src/gen/', kind: 'untracked', staged: false, unstaged: true, files: 40 },
      { path: 'src/app.ts', kind: 'modified', staged: false, unstaged: true }
    ])
    render(<ChangesTab />)

    const folders = [...document.querySelectorAll('.changes__item--folder .change')].map((row) => row.textContent)
    expect(folders).toEqual(['src'])
    const folder = screen.getByTitle('src/gen/')
    expect(folder.querySelector('.change__name')?.textContent).toBe('gen')
    expect(folder.querySelector('.change__stat')?.textContent).toBe('40 files')
  })

  it('waits for a message, with the shortcut in the empty box', () => {
    withChanges(rows)
    render(<ChangesTab />)
    const box = screen.getByRole('textbox', { name: 'Commit message' }) as HTMLTextAreaElement
    expect(box.placeholder).toBe('Message (⌘↩ to commit)')
    expect(screen.getByRole('button', { name: 'Commit All 3' }).getAttribute('aria-disabled')).toBe('true')
  })

  describe('from its menu', () => {
    const choose = async (name: string): Promise<void> => {
      fireEvent.click(screen.getByRole('button', { name: 'Commit Actions' }))
      const item = within(screen.getByRole('menu', { name: 'Commit Actions' })).getByRole('menuitem', { name })
      await act(async () => fireEvent.click(item))
    }
    const landing = (overrides: Partial<WorktreeLanding> = {}): WorktreeLanding => ({
      worktreeId: 'w1',
      branch: 'rewrite-the-pager',
      base: 'main',
      host: null,
      published: true,
      unmerged: 1,
      merged: false,
      readAt: 0,
      ...overrides
    })
    const committed = (): void => {
      call.mockImplementation((method: string) =>
        method === 'worktree.commit'
          ? Promise.resolve({
              worktreeId: 'w1',
              sha: 'b'.repeat(40),
              shortSha: 'bbbbbbb',
              message: 'Rank',
              paths: [],
              committedAt: 0
            })
          : new Promise(() => {})
      )
    }

    it('commits, then pushes', async () => {
      committed()
      withChanges(rows)
      render(<ChangesTab />)
      message('Rank')
      await choose('Commit & Push')
      expect(call).toHaveBeenCalledWith('worktree.commit', { worktreeId: 'w1', message: 'Rank', all: true })
      expect(call).toHaveBeenCalledWith('worktree.push', { worktreeId: 'w1' })
      expect((screen.getByRole('textbox', { name: 'Commit message' }) as HTMLTextAreaElement).value).toBe('')
    })

    it('commits, then asks before merging into the parent it names', async () => {
      committed()
      seed({ unstaged: 3 })
      useWorkspaceStore.setState({
        landings: { w1: landing({ base: 'rework-auth', parent: { worktreeId: 'w0', name: 'Rework auth' } }) }
      })
      withChanges(rows)
      render(<ChangesTab />)
      message('Rank')
      await choose('Commit & Merge into Rework auth…')
      expect(call).toHaveBeenCalledWith('worktree.commit', { worktreeId: 'w1', message: 'Rank', all: true })
      expect(useWorkspaceStore.getState().dialog).toEqual({ kind: 'confirm-merge', worktreeId: 'w1' })
    })

    const box = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: 'Commit message' })
    const lastCommit = (message: string): void => {
      useWorkspaceStore.setState({ logs: { w1: { ...log, commits: [{ ...log.commits[0]!, message }] } } })
    }

    it('amends the last commit, which no remote has yet, starting from its whole message', async () => {
      committed()
      lastCommit('Rank by recency\n\nPer line.')
      withChanges(rows)
      render(<ChangesTab />)
      await choose('Amend Last Commit')
      expect(call).not.toHaveBeenCalledWith('worktree.commit', expect.anything())
      expect(box().value).toBe('Rank by recency\n\nPer line.')
      expect(document.activeElement).toBe(box())

      message('Rank by recency\n\nPer line, not per file.')
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Amend Last Commit' })))
      expect(call).toHaveBeenCalledWith('worktree.commit', {
        worktreeId: 'w1',
        message: 'Rank by recency\n\nPer line, not per file.',
        all: true,
        amend: true
      })
      expect(box().value).toBe('')
    })

    it('gives back what was typed when amending is called off, from the menu or with Escape', async () => {
      lastCommit('Rank by recency')
      withChanges(rows)
      render(<ChangesTab />)
      message('Half a thought')

      await choose('Amend Last Commit')
      expect(box().value).toBe('Rank by recency')
      message('Rank by recency, edited')
      await choose('Cancel Amend')
      expect(box().value).toBe('Half a thought')
      expect(screen.getByRole('button', { name: 'Commit All 3' })).toBeTruthy()

      await choose('Amend Last Commit')
      expect(box().value).toBe('Rank by recency')
      fireEvent.keyDown(box(), { key: 'Escape' })
      expect(box().value).toBe('Half a thought')
      expect(call).not.toHaveBeenCalledWith('worktree.commit', expect.anything())
    })

    it('will not amend a commit already pushed, and choosing it leaves the box alone', async () => {
      seed({ ahead: 0 })
      withChanges(rows)
      render(<ChangesTab />)
      message('Amended')
      fireEvent.click(screen.getByRole('button', { name: 'Commit Actions' }))
      const amend = screen.getByRole('menuitem', { name: /Amend Last Commit/ })
      expect(amend.getAttribute('aria-disabled')).toBe('true')
      expect(amend.textContent).toContain('Already pushed')

      await act(async () => fireEvent.click(amend))
      expect(call).not.toHaveBeenCalledWith('worktree.commit', expect.anything())
      expect(box().value).toBe('Amended')
      expect(screen.getByRole('button', { name: 'Commit All 3' })).toBeTruthy()
    })

    it('offers Amend with nothing typed, the rest waiting for a message', () => {
      withChanges(rows)
      render(<ChangesTab />)
      fireEvent.click(screen.getByRole('button', { name: 'Commit Actions' }))
      const menu = screen.getByRole('menu', { name: 'Commit Actions' })
      expect(within(menu).getByRole('menuitem', { name: 'Amend Last Commit' }).getAttribute('aria-disabled')).toBeNull()
      expect(
        within(menu)
          .getByRole('menuitem', { name: /Commit & Push/ })
          .getAttribute('aria-disabled')
      ).toBe('true')
    })
  })
})

describe('the message from the done report', () => {
  const reported = (summary: string): Worktree => ({
    ...childWorktree,
    task: 'Add tax to cart totals',
    report: { outcome: 'succeeded', summary, paths: [], at: 0 }
  })
  const box = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: 'Commit message' }) as HTMLTextAreaElement

  // The owner's box held the whole task prompt; the suggestion is offered in one line and typed in only when taken.
  it('offers the report in one line, fills the box only when taken, and commits it only when asked', () => {
    withChanges(rows)
    useWorkspaceStore.setState({ worktrees: [reported('Cart totals include tax.\nRounded per line.')] })
    render(<ChangesTab />)

    expect(box().value).toBe('')
    const offer = screen.getByRole('button', { name: 'Use: Cart totals include tax.' })
    expect(offer.title).toBe('Cart totals include tax.\n\nRounded per line.')
    fireEvent.click(offer)
    expect(box().value).toBe('Cart totals include tax.\n\nRounded per line.')
    expect(screen.queryByRole('button', { name: /^Use:/ })).toBeNull()
    expect(call).not.toHaveBeenCalledWith('worktree.commit', expect.anything())

    fireEvent.click(screen.getByRole('button', { name: 'Commit All 3' }))
    expect(call).toHaveBeenCalledWith('worktree.commit', {
      worktreeId: 'w1',
      message: 'Cart totals include tax.\n\nRounded per line.',
      all: true
    })
  })

  it('offers the task’s first line when there is no report, never the whole prompt', () => {
    withChanges(rows)
    useWorkspaceStore.setState({
      worktrees: [{ ...childWorktree, task: 'Add tax to cart totals\n\nEvery line, rounded.' }]
    })
    render(<ChangesTab />)
    expect(box().value).toBe('')
    expect(screen.getByRole('button', { name: 'Use: Add tax to cart totals' })).toBeTruthy()
  })

  it('offers it again once the box is emptied', () => {
    withChanges(rows)
    useWorkspaceStore.setState({ worktrees: [reported('Cart totals include tax.')] })
    render(<ChangesTab />)

    fireEvent.click(screen.getByRole('button', { name: 'Use: Cart totals include tax.' }))
    fireEvent.change(box(), { target: { value: '' } })
    expect(screen.getByRole('button', { name: 'Use: Cart totals include tax.' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Commit All 3' }).getAttribute('aria-disabled')).toBe('true')
  })

  it('keeps what was typed when the agent reports again', () => {
    withChanges(rows)
    useWorkspaceStore.setState({ worktrees: [reported('Cart totals include tax.')] })
    render(<ChangesTab />)

    fireEvent.change(box(), { target: { value: 'Tax on totals' } })
    act(() => useWorkspaceStore.setState({ worktrees: [reported('Cart totals include tax and fees.')] }))
    expect(box().value).toBe('Tax on totals')
  })

  it('offers a new report in place of the old', () => {
    withChanges(rows)
    useWorkspaceStore.setState({ worktrees: [reported('Cart totals include tax.')] })
    render(<ChangesTab />)

    act(() => useWorkspaceStore.setState({ worktrees: [reported('Cart totals include tax and fees.')] }))
    expect(screen.getByRole('button', { name: 'Use: Cart totals include tax and fees.' })).toBeTruthy()
    expect(box().value).toBe('')
  })

  it('commits on ⌘Return and breaks the line on Return', () => {
    withChanges(rows)
    render(<ChangesTab />)
    fireEvent.change(box(), { target: { value: 'Cart totals include tax.' } })

    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(call).not.toHaveBeenCalledWith('worktree.commit', expect.anything())
    fireEvent.keyDown(box(), { key: 'Enter', metaKey: true })
    expect(call).toHaveBeenCalledWith('worktree.commit', {
      worktreeId: 'w1',
      message: 'Cart totals include tax.',
      all: true
    })
  })
})

describe('what git has staged', () => {
  const partly: WorktreeChange = { path: 'src/rank.ts', kind: 'modified', staged: true, unstaged: true }
  const whole: WorktreeChange = { path: 'src/done.ts', kind: 'modified', staged: true, unstaged: false }
  const loose: WorktreeChange = { path: 'README.md', kind: 'modified', staged: false, unstaged: true }
  const section = (name: string): HTMLElement => screen.getByRole('region', { name })
  const commitButton = (): HTMLElement => document.querySelector('.changes__commitButton') as HTMLElement

  it('commits the index alone, naming no paths, when something is staged and nothing ticked', () => {
    withChanges([partly, loose])
    render(<ChangesTab />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Commit message' }), { target: { value: 'Rank' } })

    expect(screen.queryByRole('button', { name: /Commit All/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Commit 1' }))
    expect(call).toHaveBeenCalledWith('worktree.commit', { worktreeId: 'w1', message: 'Rank' })
  })

  it('lists a partly staged file once, in Staged, marked partial, and stages the rest of it whole', () => {
    withChanges([partly, loose])
    render(<ChangesTab />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Commit message' }), { target: { value: 'Rank' } })
    expect(within(section('Staged Changes')).getByTitle('src/rank.ts').textContent).toContain('partial')
    expect(within(section('Changes')).queryByTitle('src/rank.ts')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Stage src/rank.ts' }))
    expect(within(section('Staged Changes')).getByTitle('src/rank.ts').textContent).not.toContain('partial')
    fireEvent.click(screen.getByRole('button', { name: 'Commit 1' }))
    expect(call).toHaveBeenCalledWith('worktree.commit', { worktreeId: 'w1', message: 'Rank', paths: ['src/rank.ts'] })
  })

  it('shows a wholly staged file in Staged, counted, and Stage All joins the rest to it', () => {
    withChanges([whole, loose])
    render(<ChangesTab />)
    expect(within(section('Staged Changes')).getByTitle('src/done.ts')).toBeTruthy()
    expect(section('Staged Changes').querySelector('.panel__count')?.textContent).toBe('1')
    expect(commitButton().textContent).toBe('Commit 1')

    fireEvent.click(screen.getByRole('button', { name: 'Stage All Changes' }))
    expect(section('Staged Changes').querySelector('.panel__count')?.textContent).toBe('2')
    expect(screen.queryByRole('region', { name: 'Changes' })).toBeNull()
    expect(commitButton().textContent).toBe('Commit 2')

    fireEvent.click(screen.getByRole('button', { name: 'Unstage All Changes' }))
    expect(useWorkspaceStore.getState().stagedPaths.w1 ?? []).toEqual([])
    expect(call).toHaveBeenCalledWith('worktree.unstagePath', { worktreeId: 'w1', path: 'src/done.ts' })
  })

  it('unstages a wholly staged file from its −, and the button follows', () => {
    withChanges([whole, loose])
    render(<ChangesTab />)

    fireEvent.click(screen.getByRole('button', { name: 'Unstage src/done.ts' }))
    expect(call).toHaveBeenCalledWith('worktree.unstagePath', { worktreeId: 'w1', path: 'src/done.ts' })
    expect(useWorkspaceStore.getState().stagedPaths.w1 ?? []).toEqual([])

    act(() => withChanges([{ ...whole, staged: false, unstaged: true }, loose]))
    expect(within(section('Changes')).getByTitle('src/done.ts')).toBeTruthy()
    expect(commitButton().textContent).toBe('Commit All 2')
  })

  it('unstages the whole of a partly staged file once it is staged whole and then unstaged', () => {
    withChanges([partly, loose])
    render(<ChangesTab />)
    fireEvent.click(screen.getByRole('button', { name: 'Stage src/rank.ts' }))
    expect(call).not.toHaveBeenCalledWith('worktree.unstagePath', expect.anything())

    fireEvent.click(screen.getByRole('button', { name: 'Unstage src/rank.ts' }))
    expect(call).toHaveBeenCalledWith('worktree.unstagePath', { worktreeId: 'w1', path: 'src/rank.ts' })
    expect(useWorkspaceStore.getState().stagedPaths.w1 ?? []).toEqual([])

    act(() => withChanges([{ ...partly, staged: false }, loose]))
    expect(within(section('Changes')).getByTitle('src/rank.ts')).toBeTruthy()
    expect(commitButton().textContent).toBe('Commit All 2')
  })

  it('leaves git alone when a file only staged here is unstaged', () => {
    withChanges([loose])
    render(<ChangesTab />)
    fireEvent.click(screen.getByRole('button', { name: 'Stage README.md' }))
    fireEvent.click(screen.getByRole('button', { name: 'Unstage README.md' }))
    expect(call).not.toHaveBeenCalledWith('worktree.unstagePath', expect.anything())
    expect(within(section('Changes')).getByTitle('README.md')).toBeTruthy()
  })

  it('has no Changes section when git already holds every change', () => {
    withChanges([whole])
    render(<ChangesTab />)
    expect(screen.queryByRole('button', { name: 'Stage All Changes' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Commit 1' })).toBeTruthy()
  })

  it('keeps each worktree’s ticks when you leave it and come back, and never carries them across', () => {
    withChanges([loose])
    useWorkspaceStore.setState((state) => ({
      changes: {
        ...state.changes,
        w2: { worktreeId: 'w2', changes: [loose], total: 1, limit: 500, truncated: false, readAt: 0 }
      }
    }))
    render(<ChangesTab />)
    fireEvent.click(screen.getByRole('button', { name: 'Stage README.md' }))

    act(() => void useWorkspaceStore.getState().openWorktree('w2'))
    expect(within(section('Changes')).getByTitle('README.md')).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Staged Changes' })).toBeNull()

    act(() => void useWorkspaceStore.getState().openWorktree('w1'))
    expect(within(section('Staged Changes')).getByTitle('README.md')).toBeTruthy()
    expect(commitButton().textContent).toBe('Commit 1')
  })

  it('stages and unstages the row under the keyboard with Space', () => {
    withChanges([loose])
    render(<ChangesTab />)
    fireEvent.keyDown(screen.getByTitle('README.md'), { key: ' ' })
    expect(useWorkspaceStore.getState().stagedPaths.w1 ?? []).toEqual(['README.md'])
    fireEvent.keyDown(within(section('Staged Changes')).getByTitle('README.md'), { key: ' ' })
    expect(useWorkspaceStore.getState().stagedPaths.w1 ?? []).toEqual([])
  })
})

describe('the changes header', () => {
  const ref = (): string | null | undefined => document.querySelector('.changes__head .changes__ref')?.textContent

  it('names the branch, the base it is measured against and how far it is, with the push under it', () => {
    seed({ ahead: 1, behind: 2 })
    render(<ChangesTab />)
    expect(ref()).toBe('rewrite-the-pager → main · ↑1 ↓2')
    const actions = document.querySelector('.changes__actions') as HTMLElement
    expect(within(actions).getByRole('button', { name: 'Push' })).toBeTruthy()
    expect(
      within(document.querySelector('.changes__head') as HTMLElement).queryByRole('button', { name: 'Push' })
    ).toBeNull()
  })

  it('counts against the base when the branch tracks nothing, and says what each arrow measures', () => {
    seed({ upstream: null, ahead: 2, behind: 3 })
    render(<ChangesTab />)
    const line = document.querySelector('.changes__ref') as HTMLElement
    expect(line.textContent).toBe('rewrite-the-pager → main · ↑2 ↓3')
    expect(line.getAttribute('data-tip')).toBe(
      '2 commits ahead of origin/main, not pushed\n3 commits behind origin/main'
    )
    expect(screen.getByRole('button', { name: 'Publish Branch' })).toBeTruthy()
  })

  it('reads the changes again on Refresh', () => {
    render(<ChangesTab />)
    call.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(call).toHaveBeenCalledWith('worktree.changes', { worktreeId: 'w1' })
    expect(call).toHaveBeenCalledWith('worktree.log', { worktreeId: 'w1' })
  })

  // Tokens belong to the task and the status bar; the panel is for the changes.
  it('says nothing about tokens', () => {
    render(<ChangesTab />)
    expect(call).not.toHaveBeenCalledWith('worktree.usage', expect.anything())
  })
})

describe('the ahead and behind arrows', () => {
  it('shows nothing when both are zero', () => {
    seed({ ahead: 0, behind: 0 })
    render(<ChangesTab />)
    expect(document.querySelector('.changes__ref')?.textContent).toBe('rewrite-the-pager → main')
  })

  it('shows only the arrow that is not zero', () => {
    seed({ ahead: 2, behind: 0 })
    render(<ChangesTab />)
    expect(document.querySelector('.changes__ref')?.textContent).toBe('rewrite-the-pager → main · ↑2')
    cleanup()
    seed({ ahead: 0, behind: 3 })
    render(<ChangesTab />)
    expect(document.querySelector('.changes__ref')?.textContent).toBe('rewrite-the-pager → main · ↓3')
  })
})

describe('the commits list', () => {
  const sha = 'a'.repeat(40)
  const patch = [
    'diff --git a/src/rank.ts b/src/rank.ts',
    'index 3f8a1c2..9b21e40 100644',
    '--- a/src/rank.ts',
    '+++ b/src/rank.ts',
    '@@ -1,2 +1,3 @@',
    ' export function rank() {',
    '+  return recency()',
    ' }',
    ''
  ].join('\n')

  function withLayout(): void {
    seed()
    useWorkspaceStore.setState({
      layouts: { w1: { worktreeId: 'w1', root: { kind: 'leaf', terminalId: 't1' }, focusedTerminalId: 't1' } }
    })
  }

  it('is headed Commits with its count as a pill, the base ref in the hover, folded', () => {
    seed()
    render(<ChangesTab />)
    expect(screen.getByRole('button', { name: /^Commits/ }).getAttribute('aria-expanded')).toBe('false')
    const heading = screen.getByRole('heading', { name: /Commits/ })
    expect(heading.textContent).toBe('Commits1')
    expect(heading.querySelector('.panel__count')?.textContent).toBe('1')
    expect(heading.getAttribute('title')).toBe('Not in origin/main')
  })

  it('opens find over a commit, which is all diff', () => {
    withLayout()
    useWorkspaceStore.getState().openCommit('w1', log.commits[0]!)
    useWorkspaceStore.getState().openPaneSearch()
    const leaf = fileLeavesIn(useWorkspaceStore.getState().layouts.w1!.root)[0]!
    expect(useWorkspaceStore.getState().paneSearch?.terminalId).toBe(leaf.terminalId)
  })

  it('opens a commit read-only in the file column, titled by its sha and subject, with the row selected', async () => {
    withLayout()
    call.mockImplementation((method: string) =>
      method === 'worktree.showCommit'
        ? Promise.resolve({
            worktreeId: 'w1',
            sha,
            shortSha: 'aaaaaaa',
            author: 'Ada',
            committedAt: '2026-09-20T14:05:00+00:00',
            subject: 'Rank by recency',
            patch,
            truncated: false,
            readAt: 0
          })
        : new Promise(() => {})
    )
    render(<ChangesTab />)

    unfold(/^Commits/)
    const commits = screen.getByRole('region', { name: 'Commits this worktree has made' })
    const row = within(commits).getByRole('button', { name: 'aaaaaaa Rank by recency' })
    fireEvent.click(row)

    const leaves = fileLeavesIn(useWorkspaceStore.getState().layouts.w1!.root)
    expect(leaves).toHaveLength(1)
    const leaf = leaves[0]!
    expect(isCommitLeaf(leaf) && leaf.commit).toBe(sha)
    expect(leaf.path).toBe('aaaaaaa Rank by recency')
    expect(useWorkspaceStore.getState().layouts.w1!.focusedTerminalId).toBe(leaf.terminalId)
    expect(row.getAttribute('aria-current')).toBe('true')
    expect(row.closest('li')?.className).toContain('commit--selected')

    // A second click goes back to the same tab.
    fireEvent.click(row)
    expect(fileLeavesIn(useWorkspaceStore.getState().layouts.w1!.root)).toHaveLength(1)

    cleanup()
    render(
      <FilePane
        paneId={leaf.terminalId}
        worktreeId="w1"
        path={leaf.path}
        commit={sha}
        focused
        onFocus={() => {}}
        onClose={() => {}}
      />
    )
    expect(call).toHaveBeenCalledWith('worktree.showCommit', { worktreeId: 'w1', sha })
    await screen.findByText('recency()', { exact: false })
    expect(screen.getByRole('region', { name: 'aaaaaaa Rank by recency' })).toBeTruthy()
    expect(document.querySelector('.patch__row--added')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Stage Hunk' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Diff' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Inline' })).toBeTruthy()
    expect(call).not.toHaveBeenCalledWith('file.read', expect.anything())
    // The tab carries the title; the bar says who and when, and the patch still names its files.
    const bar = screen.getByRole('region', { name: 'aaaaaaa Rank by recency' }).querySelector('header')!
    expect(bar.textContent).not.toContain('Rank by recency')
    expect(bar.textContent).toContain('Ada')
    expect(document.querySelector('.patch__fileHead:not([hidden])')).not.toBeNull()
  })
})

describe('an empty worktree', () => {
  it('says No changes, with the last commit under it to open', () => {
    render(<ChangesTab />)
    expect(screen.getByText('No changes')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'aaaaaaa Rank by recency' }))
    expect(screen.queryByRole('textbox', { name: 'Commit message' })).toBeNull()
  })
})

describe('the tree', () => {
  const nested: WorktreeChange[] = [
    { path: 'src/cart/totals.ts', kind: 'modified', staged: false, unstaged: true },
    { path: 'src/cart/tax/rates.ts', kind: 'modified', staged: false, unstaged: true },
    { path: 'docs/guide/intro.md', kind: 'modified', staged: false, unstaged: true },
    { path: 'README.md', kind: 'modified', staged: false, unstaged: true }
  ]
  const folders = (): (string | null)[] =>
    [...document.querySelectorAll('.changes__item--folder .change')].map((row) => row.textContent)

  it('groups by folder, a lone chain as one row, and is remembered', () => {
    localStorage.removeItem('teamree.shell.changesView')
    withChanges(nested)
    render(<ChangesTab />)
    expect(folders()).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: 'Tree' }))
    expect(folders()).toEqual(['docs/guide', 'src/cart', 'tax'])
    expect(localStorage.getItem('teamree.shell.changesView')).toBe('tree')
    // The folder is on the folder row, so a file row says only its name.
    expect(screen.getByTitle('src/cart/tax/rates.ts').querySelector('.change__dir')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'List' }))
    expect(folders()).toEqual([])
    expect(localStorage.getItem('teamree.shell.changesView')).toBe('list')
  })

  it('folds a folder from its row and from the keyboard', () => {
    useScmView.setState({ view: 'tree' })
    withChanges(nested)
    render(<ChangesTab />)
    fireEvent.click(screen.getByTitle('src/cart'))
    expect(screen.queryByTitle('src/cart/totals.ts')).toBeNull()
    fireEvent.keyDown(screen.getByTitle('src/cart'), { key: 'ArrowRight' })
    expect(screen.getByTitle('src/cart/totals.ts')).toBeTruthy()
  })
})

describe('a long name', () => {
  it('keeps its end, with the whole path in the hover', () => {
    withChanges([{ path: 'resumes/Abdullah_Al_Mahmud_Resume.pdf', kind: 'untracked', staged: false, unstaged: true }])
    render(<ChangesTab />)
    const row = screen.getByTitle('resumes/Abdullah_Al_Mahmud_Resume.pdf')
    expect(row.querySelector('.change__head')?.textContent).toBe('Abdullah_Al_Mahmud_')
    expect(row.querySelector('.change__tail')?.textContent).toBe('Resume.pdf')
    expect(row.querySelector('svg[data-icon="file"]')).not.toBeNull()
  })
})

describe('picking a changed file', () => {
  it('opens its diff in the centre and keeps the panel a list, with the row selected', () => {
    seed()
    useWorkspaceStore.setState({
      layouts: { w1: { worktreeId: 'w1', root: { kind: 'leaf', terminalId: 't1' }, focusedTerminalId: 't1' } },
      changes: {
        w1: {
          worktreeId: 'w1',
          changes: [
            { path: 'src/rank.ts', kind: 'modified', staged: false, unstaged: true },
            { path: 'README.md', kind: 'modified', staged: false, unstaged: true }
          ],
          total: 2,
          limit: 500,
          truncated: false,
          readAt: 0
        }
      }
    })
    render(<ChangesTab />)

    fireEvent.click(screen.getByTitle('src/rank.ts'))
    const leaves = fileLeavesIn(useWorkspaceStore.getState().layouts.w1!.root)
    expect(leaves.map((leaf) => leaf.path)).toEqual(['src/rank.ts'])
    expect(useWorkspaceStore.getState().diffPanes[leaves[0]!.terminalId]).toBe(true)
    expect(document.querySelector('.patch')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Side by side' })).toBeNull()

    const row = screen.getByTitle('src/rank.ts')
    expect(row.getAttribute('aria-current')).toBe('true')
    expect(row.closest('li')?.className).toContain('changes__item--selected')
    expect(screen.getByTitle('README.md').closest('li')?.className).not.toContain('changes__item--selected')

    // A second click keeps the selection and the one pane.
    fireEvent.click(row)
    expect(row.getAttribute('aria-current')).toBe('true')
    expect(fileLeavesIn(useWorkspaceStore.getState().layouts.w1!.root)).toHaveLength(1)
  })
})

// Stepping through an agent's change should not leave a tab per file behind.
describe('one preview tab for the change on screen', () => {
  function withThreeChanges(): void {
    seed()
    useWorkspaceStore.setState({
      layouts: { w1: { worktreeId: 'w1', root: { kind: 'leaf', terminalId: 't1' }, focusedTerminalId: 't1' } },
      changes: {
        w1: {
          worktreeId: 'w1',
          changes: [
            { path: 'src/rank.ts', kind: 'modified', staged: false, unstaged: true },
            { path: 'README.md', kind: 'modified', staged: false, unstaged: true },
            { path: 'docs/NOTES.md', kind: 'untracked', staged: false, unstaged: true }
          ],
          total: 3,
          limit: 500,
          truncated: false,
          readAt: 0
        }
      }
    })
  }
  const leaves = () => fileLeavesIn(useWorkspaceStore.getState().layouts.w1!.root)
  const column = () => fileColumnIn(useWorkspaceStore.getState().layouts.w1!.root)

  it('leaves one file tab after ↓ through three files, in Diff, as the preview', () => {
    withThreeChanges()
    render(<ChangesTab />)
    const first = screen.getByTitle('src/rank.ts')
    fireEvent.click(first)
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    fireEvent.keyDown(screen.getByTitle('README.md'), { key: 'ArrowDown' })
    expect(leaves().map((leaf) => leaf.path)).toEqual(['docs/NOTES.md'])
    expect(column()?.preview).toBe(leaves()[0]!.terminalId)
    expect(useWorkspaceStore.getState().diffPanes[leaves()[0]!.terminalId]).toBe(true)
  })

  it('keeps the diff tab on ⌘Return, so the next file opens beside it', () => {
    withThreeChanges()
    render(<ChangesTab />)
    const first = screen.getByTitle('src/rank.ts')
    fireEvent.click(first)
    fireEvent.keyDown(first, { key: 'Enter', metaKey: true })
    expect(column()?.preview).toBeUndefined()
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(leaves().map((leaf) => leaf.path)).toEqual(['src/rank.ts', 'README.md'])
    fireEvent.keyDown(screen.getByTitle('README.md'), { key: 'Enter', metaKey: true })
    expect(column()?.preview).toBeUndefined()
    expect(leaves()).toHaveLength(2)
  })

  it('opens the file itself, kept, on a double-click or from its row, and the diff on Return', () => {
    withThreeChanges()
    render(<ChangesTab />)
    const first = screen.getByTitle('src/rank.ts')
    fireEvent.click(first)
    fireEvent.doubleClick(first)
    const [leaf] = leaves()
    expect(leaf?.path).toBe('src/rank.ts')
    expect(useWorkspaceStore.getState().diffPanes[leaf!.terminalId]).not.toBe(true)
    expect(column()?.preview).toBeUndefined()

    fireEvent.click(screen.getByRole('button', { name: 'Open README.md' }))
    const opened = leaves().find((entry) => entry.path === 'README.md')
    expect(opened && useWorkspaceStore.getState().diffPanes[opened.terminalId]).not.toBe(true)

    fireEvent.keyDown(screen.getByTitle('docs/NOTES.md'), { key: 'Enter' })
    const diff = leaves().find((entry) => entry.path === 'docs/NOTES.md')
    expect(diff && useWorkspaceStore.getState().diffPanes[diff.terminalId]).toBe(true)
  })

  it('opens every change as one Review tab from Review All, and focuses it again rather than opening another', () => {
    withThreeChanges()
    render(<ChangesTab />)
    fireEvent.click(screen.getByRole('button', { name: 'Review All' }))
    fireEvent.click(screen.getByRole('button', { name: 'Review All' }))
    const reviews = leaves().filter(isReviewLeaf)
    expect(reviews.map((leaf) => leaf.path)).toEqual(['Review'])
    expect(useWorkspaceStore.getState().expandedTerminalId).toBe(reviews[0]!.terminalId)
  })

  it('ticks a row whose file was marked viewed, until its counts change', () => {
    withThreeChanges()
    const row = { path: 'src/rank.ts', kind: 'modified' as const, staged: false, unstaged: true, added: 2, removed: 1 }
    useWorkspaceStore.setState({
      changes: { w1: { worktreeId: 'w1', changes: [row], total: 1, limit: 500, truncated: false, readAt: 0 } }
    })
    useReviewStore.getState().markViewed('w1', 'src/rank.ts', { fingerprint: 'f', added: 2, removed: 1 })
    render(<ChangesTab />)
    expect(screen.getByLabelText('Viewed')).toBeTruthy()
    act(() =>
      useWorkspaceStore.setState({
        changes: {
          w1: { worktreeId: 'w1', changes: [{ ...row, added: 3 }], total: 1, limit: 500, truncated: false, readAt: 1 }
        }
      })
    )
    expect(screen.queryByLabelText('Viewed')).toBeNull()
  })
})

describe('comments kept for a batch', () => {
  const agent = {
    id: 'claude',
    worktreeId: 'w1',
    title: 'claude',
    shell: '/bin/zsh',
    running: true,
    busy: false,
    lastOutputAt: 0,
    agent: 'claude'
  } as Terminal
  const comment = (note: string) => ({
    path: 'src/rank.ts',
    lines: [{ kind: 'added' as const, text: 'x', oldNumber: null, newNumber: 3 }],
    note
  })

  it('sends them from the panel as one message, and says Queued while the agent works', () => {
    useWorkspaceStore.setState({ terminals: { claude: agent } })
    useReviewStore.getState().addToBatch('w1', comment('One.'))
    useReviewStore.getState().addToBatch('w1', comment('Two.'))
    render(<ChangesTab />)
    fireEvent.click(screen.getByRole('button', { name: 'Send 2 Comments' }))
    const written = call.mock.calls.filter(([method]) => method === 'terminal.write')
    expect(written).toHaveLength(1)
    expect((written[0]![1] as { data: string }).data).toContain('One.\n\nsrc/rank.ts:3')

    act(() => {
      useWorkspaceStore.setState({ terminals: { claude: { ...agent, busy: true } } })
      useReviewStore.setState({ queued: { claude: true } })
    })
    expect(screen.getByText('Queued')).toBeTruthy()
    act(() => useWorkspaceStore.setState({ terminals: { claude: agent } }))
    expect(screen.getByRole('button', { name: 'Send Queued' })).toBeTruthy()
  })
})

// The diff is what the user came to read, so it gets the centre; the layout under it is left as it was.
describe('reviewing a change zoomed', () => {
  function withTwoChanges(): void {
    seed()
    useWorkspaceStore.setState({
      layouts: { w1: { worktreeId: 'w1', root: { kind: 'leaf', terminalId: 't1' }, focusedTerminalId: 't1' } },
      changes: {
        w1: {
          worktreeId: 'w1',
          changes: [
            { path: 'src/rank.ts', kind: 'modified', staged: false, unstaged: true },
            { path: 'README.md', kind: 'modified', staged: false, unstaged: true }
          ],
          total: 2,
          limit: 500,
          truncated: false,
          readAt: 0
        }
      }
    })
  }
  const shownPath = (): string | undefined => {
    const state = useWorkspaceStore.getState()
    return fileLeavesIn(state.layouts.w1!.root).find((leaf) => leaf.terminalId === state.expandedTerminalId)?.path
  }

  it('fills the centre with the diff it opens', () => {
    withTwoChanges()
    render(<ChangesTab />)
    fireEvent.click(screen.getByTitle('src/rank.ts'))
    expect(shownPath()).toBe('src/rank.ts')
  })

  it('steps to the next and previous file on the arrows, still zoomed, with the keyboard on the row', () => {
    withTwoChanges()
    render(<ChangesTab />)
    const first = screen.getByTitle('src/rank.ts')
    fireEvent.click(first)
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(shownPath()).toBe('README.md')
    expect(useWorkspaceStore.getState().selectedChangePath).toBe('README.md')
    expect(document.activeElement).toBe(screen.getByTitle('README.md'))
    fireEvent.keyDown(screen.getByTitle('README.md'), { key: 'ArrowUp' })
    expect(shownPath()).toBe('src/rank.ts')
  })

  it('gives the layout back on Escape, as it was', () => {
    withTwoChanges()
    render(<ChangesTab />)
    const row = screen.getByTitle('src/rank.ts')
    fireEvent.click(row)
    const root = useWorkspaceStore.getState().layouts.w1!.root
    expect(shownPath()).toBe('src/rank.ts')
    fireEvent.keyDown(row, { key: 'Escape' })
    expect(useWorkspaceStore.getState().expandedTerminalId).toBeNull()
    expect(useWorkspaceStore.getState().layouts.w1!.root).toBe(root)
  })
})

describe('discarding a file', () => {
  const rows = [
    { path: 'README.md', kind: 'modified' as const, staged: false, unstaged: true },
    { path: 'src/new.ts', kind: 'untracked' as const, staged: false, unstaged: true },
    { path: 'src/done.ts', kind: 'modified' as const, staged: true, unstaged: false }
  ]

  function withRows(): void {
    seed()
    useWorkspaceStore.setState({
      changes: { w1: { worktreeId: 'w1', changes: rows, total: 3, limit: 500, truncated: false, readAt: 0 } }
    })
  }

  /** The tab and whatever discard question it raised, as the app lays them out. */
  function Tab(): React.JSX.Element {
    const dialog = useWorkspaceStore((state) => state.dialog)
    return (
      <>
        <ChangesTab />
        {dialog?.kind === 'confirm-discard' ? <ConfirmDiscardDialog {...dialog} /> : null}
      </>
    )
  }

  it('shows the lines a hunk discard throws away, the first eight, then how many more', () => {
    seed()
    const line = (kind: 'added' | 'removed' | 'context', text: string) => ({
      kind,
      text,
      oldNumber: null,
      newNumber: null,
      noNewline: false
    })
    const lines = [
      line('context', 'const rate = 1'),
      ...Array.from({ length: 6 }, (_, at) => line('removed', `old ${at}`)),
      ...Array.from({ length: 6 }, (_, at) => line('added', `new ${at}`))
    ]
    const hunk = { header: '@@ -1,7 +1,7 @@', oldStart: 1, oldCount: 7, newStart: 1, newCount: 7, lines }
    render(<ConfirmDiscardDialog worktreeId="w1" path="src/cart.js" hunk={hunk} />)

    const preview = screen.getByRole('dialog', { name: 'Discard this hunk of src/cart.js?' })
    expect(within(preview).queryByText('@@ -1,7 +1,7 @@')).toBeNull()
    expect(within(preview).queryByText(/const rate/)).toBeNull()
    expect([...preview.querySelectorAll('.confirm__hunkLine')].map((row) => row.textContent)).toEqual([
      '-old 0',
      '-old 1',
      '-old 2',
      '-old 3',
      '-old 4',
      '-old 5',
      '+new 0',
      '+new 1'
    ])
    expect(within(preview).getByText('+4 more')).toBeTruthy()
  })

  it('asks, naming the file, and only then restores it', () => {
    withRows()
    render(<Tab />)

    fireEvent.click(screen.getByRole('button', { name: 'Discard README.md…' }))
    expect(call).not.toHaveBeenCalledWith('worktree.discardPath', expect.anything())
    expect(screen.getByRole('dialog', { name: 'Discard changes to README.md?' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(call).toHaveBeenCalledWith('worktree.discardPath', { worktreeId: 'w1', path: 'README.md' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('changes nothing when the answer is to keep it', () => {
    withRows()
    render(<Tab />)

    fireEvent.click(screen.getByRole('button', { name: 'Discard README.md…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }))

    expect(call).not.toHaveBeenCalledWith('worktree.discardPath', expect.anything())
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('offers the same from the row’s right-click menu, in the menu’s ordinary colour', () => {
    withRows()
    render(<Tab />)

    fireEvent.contextMenu(screen.getByTitle('README.md'))
    const item = screen.getByRole('menuitem', { name: 'Discard…' })
    expect(item.className).not.toContain('danger')
    fireEvent.click(item)

    expect(screen.getByRole('dialog', { name: 'Discard changes to README.md?' })).toBeTruthy()
  })

  it('says an untracked file goes to the Trash', () => {
    withRows()
    render(<Tab />)

    fireEvent.click(screen.getByRole('button', { name: 'Discard src/new.ts…' }))

    expect(screen.getByRole('dialog').textContent).toContain('Moves to the Trash')
  })

  it('offers nothing for a file whose change is all staged', () => {
    withRows()
    render(<Tab />)
    expect(screen.queryByRole('button', { name: 'Discard src/done.ts…' })).toBeNull()
  })

  // The menu key reports no pointer; the menu opens under the row, and Escape puts the keyboard back on it.
  it('offers Discard… from the menu key, under the row, all by keyboard', () => {
    withRows()
    render(<Tab />)
    const row = screen.getByTitle('README.md')
    row.getBoundingClientRect = () => ({ left: 40, top: 100, bottom: 122, right: 300 }) as DOMRect
    row.focus()

    fireEvent.contextMenu(row, { clientX: 0, clientY: 0 })
    const menu = screen.getByRole('menu', { name: 'Actions for README.md' })
    expect([menu.style.left, menu.style.top]).toEqual(['40px', '122px'])
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(row)

    fireEvent.contextMenu(row, { clientX: 0, clientY: 0 })
    const discard = screen.getByRole('menuitem', { name: 'Discard…' })
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'End' })
    expect(document.activeElement).toBe(discard)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Enter' })
    expect(screen.getByRole('dialog', { name: 'Discard changes to README.md?' })).toBeTruthy()
  })

  it('asks on ⌫ from the row under the keyboard', () => {
    withRows()
    render(<Tab />)
    fireEvent.keyDown(screen.getByTitle('README.md'), { key: 'Backspace' })
    expect(screen.getByRole('dialog', { name: 'Discard changes to README.md?' })).toBeTruthy()
  })

  it('discards every file in Changes from Discard All, asked once, with one Undo', async () => {
    withRows()
    call.mockImplementation((method: string, params: { path: string }) =>
      method === 'worktree.discardPath'
        ? Promise.resolve({ worktreeId: 'w1', path: params.path, trashId: `t-${params.path}` })
        : new Promise(() => {})
    )
    render(<Tab />)
    fireEvent.click(screen.getByRole('button', { name: 'Discard All Changes…' }))
    const dialog = screen.getByRole('dialog', { name: 'Discard changes to 2 files?' })
    expect(dialog.textContent).toContain('New files move to the Trash')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Discard' })))

    expect(call).toHaveBeenCalledWith('worktree.discardPath', { worktreeId: 'w1', path: 'README.md' })
    expect(call).toHaveBeenCalledWith('worktree.discardPath', { worktreeId: 'w1', path: 'src/new.ts' })
    expect(call).not.toHaveBeenCalledWith('worktree.discardPath', { worktreeId: 'w1', path: 'src/done.ts' })
    expect(useWorkspaceStore.getState().notices.map((notice) => [notice.text, notice.action])).toEqual([
      [
        'Discarded 2 files',
        { label: 'Undo', undo: { kind: 'discard-many', worktreeId: 'w1', trashIds: ['t-README.md', 't-src/new.ts'] } }
      ]
    ])
  })

  it('draws Discard as an icon, its label in the tooltip rather than on every row', () => {
    withRows()
    render(<Tab />)
    const discard = screen.getByRole('button', { name: 'Discard src/new.ts…' })
    expect(discard.textContent).toBe('')
    expect(discard.getAttribute('data-tip')).toBe('Discard…')
    expect(discard.querySelector('svg[data-icon="discard"]')).not.toBeNull()
  })
})

describe('a changed file’s path', () => {
  it('reads name first, then its folder, with the whole path in the title', () => {
    seed()
    withChanges([
      { path: 'src/cart/totals.ts', kind: 'modified', staged: false, unstaged: true },
      { path: 'README.md', kind: 'modified', staged: false, unstaged: true }
    ])
    render(<ChangesTab />)
    const parts = (path: string): (string | null)[][] =>
      [...(screen.getByTitle(path).querySelector('.change__path')?.children ?? [])].map((part) => [
        part.className,
        part.textContent
      ])
    expect(parts('src/cart/totals.ts')).toEqual([
      ['change__name', 'totals.ts'],
      ['change__dir', 'src/cart']
    ])
    expect(parts('README.md')).toEqual([['change__name', 'README.md']])
  })
})

describe('what can be discarded', () => {
  it('is an unstaged change git can put back or a file the Trash can take', () => {
    expect(canDiscard({ path: 'a', kind: 'modified', staged: true, unstaged: true })).toBe(true)
    expect(canDiscard({ path: 'a', kind: 'untracked', staged: false, unstaged: true })).toBe(true)
    expect(canDiscard({ path: 'a', kind: 'deleted', staged: false, unstaged: true })).toBe(true)
    expect(canDiscard({ path: 'a', kind: 'modified', staged: true, unstaged: false })).toBe(false)
    expect(canDiscard({ path: 'a', kind: 'conflicted', staged: false, unstaged: true })).toBe(false)
    // Intent-to-add: the runtime refuses it, so it is not offered.
    expect(canDiscard({ path: 'a', kind: 'added', staged: false, unstaged: true })).toBe(false)
  })
})

describe('how much each file changed', () => {
  it('shows lines added and removed after the name, and nothing when git could not count them', () => {
    withChanges([
      { path: 'src/math.ts', kind: 'modified', staged: false, unstaged: true, added: 3, removed: 0 },
      { path: 'docs/NOTES.md', kind: 'untracked', staged: false, unstaged: true, added: 12, removed: 0 },
      { path: 'logo.png', kind: 'modified', staged: false, unstaged: true }
    ])
    render(<ChangesTab />)
    const stat = (path: string): string | null | undefined =>
      screen.getByTitle(path).querySelector('.change__stat')?.textContent
    expect(stat('src/math.ts')).toBe('+3 −0')
    expect(stat('docs/NOTES.md')).toBe('+12 −0')
    expect(stat('logo.png')).toBeUndefined()
  })
})

describe('keeping up with the base', () => {
  const agentPane = {
    id: 't-claude',
    worktreeId: 'w1',
    title: 'claude',
    cwd: '/w1',
    shell: 'claude',
    cols: 80,
    rows: 24,
    running: true,
    agent: 'claude',
    busy: false,
    lastOutputAt: 0
  } as const

  it('offers Update from main, not as the primary, when the base has moved', async () => {
    seed({ behind: 2 })
    call.mockImplementation((method: string) =>
      method === 'worktree.update'
        ? Promise.resolve({
            worktreeId: 'w1',
            baseRef: 'origin/main',
            mode: 'merge',
            outcome: 'updated',
            conflicts: [],
            updatedAt: 0
          })
        : new Promise(() => {})
    )
    render(<ChangesTab />)

    expect(screen.getByRole('button', { name: 'Push' }).className).toContain('button--primary')
    const item = within(moreMenu()).getByRole('menuitem', { name: 'Update from main' })
    await act(async () => fireEvent.click(item))
    expect(call).toHaveBeenCalledWith('worktree.update', { worktreeId: 'w1' })
  })

  it('offers Update from Parent to a child behind its parent', async () => {
    seed({ behind: 2 })
    useWorkspaceStore.setState({ worktrees: [childWorktree] })
    call.mockImplementation(() => new Promise(() => {}))
    render(<ChangesTab />)

    const item = within(moreMenu()).getByRole('menuitem', { name: 'Update from Parent' })
    await act(async () => fireEvent.click(item))
    expect(call).toHaveBeenCalledWith('worktree.update', { worktreeId: 'w1' })
  })

  it('has no update to offer when nothing is behind', () => {
    render(<ChangesTab />)
    expect(screen.queryByRole('button', { name: /Update from/ })).toBeNull()
  })

  it('says the refusal in one line', async () => {
    seed({ behind: 1, unstaged: 1 })
    call.mockImplementation((method: string) =>
      method === 'worktree.update' ? Promise.reject(new Error('Commit or stash first')) : new Promise(() => {})
    )
    render(<ChangesTab />)
    const item = within(moreMenu()).getByRole('menuitem', { name: 'Update from main' })
    await act(async () => fireEvent.click(item))
    expect(screen.getByRole('alert').textContent).toBe('Commit or stash first')
  })

  it('lists the conflicts of a stopped rebase, with Abort and the agent to ask', async () => {
    seed({ behind: 1, operation: 'rebase', conflicted: 1 })
    withChanges([{ path: 'src/math.ts', kind: 'conflicted', staged: false, unstaged: true }, ...rows.slice(0, 1)])
    useWorkspaceStore.setState({ terminals: { 't-claude': agentPane } })
    call.mockImplementation((method: string) =>
      method === 'worktree.abortUpdate' || method === 'message.send'
        ? Promise.resolve({ worktreeId: 'w1', aborted: 'rebase' })
        : new Promise(() => {})
    )
    render(<ChangesTab />)

    const conflicts = screen.getByRole('region', { name: 'Conflicts' })
    expect(conflicts.textContent).toContain('1 conflicted')
    expect(conflicts.textContent).toContain('math.ts')
    // Not twice: the conflicted file is not also a row to tick for a commit.
    expect(screen.getAllByText('math.ts')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /Update from/ })).toBeNull()

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Ask Claude Code to Resolve' })))
    // Through the message queue: pasted once the agent is at its prompt and nobody is typing there.
    const sent = call.mock.calls.find(([method]) => method === 'message.send') as [string, { text: string }]
    expect(sent[1]).toMatchObject({
      from: { you: true },
      to: { worktreeId: 'w1', terminalId: 't-claude' },
      kind: 'note'
    })
    expect(sent[1].text).toContain('src/math.ts')
    expect(sent[1].text).toContain('git rebase --continue')
    expect(call.mock.calls.some(([method]) => method === 'terminal.write')).toBe(false)

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Abort' })))
    expect(call).toHaveBeenCalledWith('worktree.abortUpdate', { worktreeId: 'w1' })
  })

  it('still offers the default agent when the worktree runs none, and starts it with the prompt', async () => {
    seed({ operation: 'merge', conflicted: 1 })
    withChanges([{ path: 'src/math.ts', kind: 'conflicted', staged: false, unstaged: true }])
    useWorkspaceStore.setState({
      agents: [
        { kind: 'codex', command: 'codex', binary: '/bin/codex' },
        { kind: 'claude', command: 'claude', binary: '/bin/claude' }
      ],
      defaultAgent: 'claude'
    })
    call.mockImplementation((method: string) =>
      method === 'terminal.create' ? Promise.resolve({ ...agentPane, id: 't-new' }) : new Promise(() => {})
    )
    render(<ChangesTab />)

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Ask Claude Code to Resolve' })))
    const created = call.mock.calls.find(([method]) => method === 'terminal.create') as [
      string,
      { worktreeId: string; command: string; prompt: string }
    ]
    expect(created[1]).toMatchObject({ worktreeId: 'w1', command: 'claude' })
    expect(created[1].prompt).toContain('src/math.ts')
    expect(created[1].prompt).toContain('git commit --no-edit')
    expect(screen.getByRole('button', { name: 'Abort' })).toBeTruthy()
  })
})

describe('a stopped update', () => {
  const parentWorktree: Worktree = {
    id: 'w0',
    projectId: 'p1',
    name: 'Checkout tax',
    branch: 'checkout-tax',
    path: '/wt/checkout-tax',
    startedFrom: 'abc',
    state: 'ready',
    createdAt: 0
  }
  const payment: Worktree = {
    ...parentWorktree,
    id: 'w1',
    name: 'Payment',
    branch: 'checkout-tax--payment',
    path: '/wt/checkout-tax--payment',
    parentId: 'w0',
    baseRef: 'checkout-tax'
  }
  const money = (markers?: number): WorktreeChange => ({
    path: 'src/money.js',
    kind: 'conflicted',
    staged: false,
    unstaged: true,
    ...(markers === undefined ? {} : { markers })
  })
  const resolved = { worktreeId: 'w1', conflicts: [] }

  beforeEach(() => {
    useWorkspaceStore.setState({ worktrees: [parentWorktree, payment] })
  })

  it('names the tasks, not their folders, and counts what is conflicted', () => {
    seed({ operation: 'merge', conflicted: 1 })
    useWorkspaceStore.setState({ worktrees: [parentWorktree, payment] })
    withChanges([money(2)])
    render(<ChangesTab />)
    const head = screen.getByRole('region', { name: 'Conflicts' }).querySelector('.changes__conflictHead')
    expect(head?.textContent).toBe('Merging Checkout tax into Payment · 1 conflicted')
  })

  it('says a rebase the other way round, and a top-level task names main', () => {
    seed({ operation: 'rebase', conflicted: 1 })
    useWorkspaceStore.setState({ worktrees: [parentWorktree, payment] })
    withChanges([money(1)])
    const { unmount } = render(<ChangesTab />)
    expect(document.querySelector('.changes__conflictHead')?.textContent).toBe(
      'Rebasing Payment onto Checkout tax · 1 conflicted'
    )
    unmount()

    useWorkspaceStore.setState({ worktrees: [{ ...payment, parentId: undefined, baseRef: undefined }] })
    render(<ChangesTab />)
    expect(document.querySelector('.changes__conflictHead')?.textContent).toBe(
      'Rebasing Payment onto main · 1 conflicted'
    )
  })

  it('marks each file Unresolved while markers remain and Resolved once they are gone', () => {
    seed({ operation: 'merge', conflicted: 2 })
    useWorkspaceStore.setState({ worktrees: [parentWorktree, payment] })
    withChanges([money(1), { path: 'src/tax.js', kind: 'conflicted', staged: false, unstaged: true, markers: 0 }])
    render(<ChangesTab />)
    const region = screen.getByRole('region', { name: 'Conflicts' })
    expect(within(region).getByTitle('src/money.js').closest('li')?.textContent).toContain('Unresolved')
    expect(within(region).getByTitle('src/tax.js').closest('li')?.textContent).toContain('Resolved')
  })

  it('marks a file resolved, or takes one side whole, per file', async () => {
    seed({ operation: 'merge', conflicted: 1 })
    useWorkspaceStore.setState({ worktrees: [parentWorktree, payment] })
    withChanges([money(0)])
    call.mockImplementation((method: string) =>
      method === 'worktree.resolve' ? Promise.resolve(resolved) : new Promise(() => {})
    )
    render(<ChangesTab />)

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Mark src/money.js Resolved' })))
    expect(call).toHaveBeenCalledWith('worktree.resolve', { worktreeId: 'w1', path: 'src/money.js' })
    const ours = screen.getByRole('button', { name: 'Take Ours for src/money.js' })
    expect(ours.getAttribute('data-tip')).toBe('Payment’s version')
    await act(async () => fireEvent.click(ours))
    expect(call).toHaveBeenCalledWith('worktree.resolve', { worktreeId: 'w1', path: 'src/money.js', take: 'ours' })
    const theirs = screen.getByRole('button', { name: 'Take Theirs for src/money.js' })
    expect(theirs.getAttribute('data-tip')).toBe('Checkout tax’s version')
    await act(async () => fireEvent.click(theirs))
    expect(call).toHaveBeenCalledWith('worktree.resolve', { worktreeId: 'w1', path: 'src/money.js', take: 'theirs' })
  })

  it('keeps Continue off until nothing is conflicted, then finishes the update with it', async () => {
    seed({ operation: 'merge', conflicted: 1 })
    useWorkspaceStore.setState({ worktrees: [parentWorktree, payment] })
    withChanges([money(1)])
    const { rerender } = render(<ChangesTab />)
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true)

    seed({ operation: 'merge', conflicted: 0, staged: 1 })
    useWorkspaceStore.setState({ worktrees: [parentWorktree, payment] })
    withChanges([{ path: 'src/money.js', kind: 'modified', staged: true, unstaged: false }])
    call.mockImplementation((method: string) =>
      method === 'worktree.continueUpdate'
        ? Promise.resolve({
            worktreeId: 'w1',
            baseRef: 'checkout-tax',
            mode: 'merge',
            outcome: 'updated',
            conflicts: [],
            updatedAt: 0
          })
        : new Promise(() => {})
    )
    rerender(<ChangesTab />)
    expect(document.querySelector('.changes__conflictHead')?.textContent).toBe(
      'Merging Checkout tax into Payment · all resolved'
    )
    const go = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement
    expect(go.disabled).toBe(false)
    await act(async () => fireEvent.click(go))
    expect(call).toHaveBeenCalledWith('worktree.continueUpdate', { worktreeId: 'w1' })
  })

  it('continues a rebase the same way, and says why it stopped when git refuses', async () => {
    seed({ operation: 'rebase', conflicted: 0 })
    useWorkspaceStore.setState({ worktrees: [parentWorktree, payment] })
    call.mockImplementation((method: string) =>
      method === 'worktree.continueUpdate'
        ? Promise.reject(new Error('could not continue the rebase'))
        : new Promise(() => {})
    )
    render(<ChangesTab />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Continue' })))
    expect(call).toHaveBeenCalledWith('worktree.continueUpdate', { worktreeId: 'w1' })
    expect(screen.getByRole('alert').textContent).toBe('could not continue the rebase')
  })
})

describe('the whole branch', () => {
  const onBranch: WorktreeChange[] = [
    { path: 'README.md', kind: 'modified', staged: false, unstaged: false, added: 1, removed: 1 },
    { path: 'src/limits.ts', kind: 'added', staged: false, unstaged: false, added: 40, removed: 0 }
  ]
  function withBranch(changes: WorktreeChange[]): void {
    useWorkspaceStore.setState({
      layouts: { w1: { worktreeId: 'w1', root: { kind: 'leaf', terminalId: 't1' }, focusedTerminalId: 't1' } },
      branchChanges: {
        w1: { worktreeId: 'w1', changes, total: changes.length, limit: 500, truncated: false, readAt: 0 }
      }
    })
  }
  const reviews = () => fileLeavesIn(useWorkspaceStore.getState().layouts.w1!.root).filter(isReviewLeaf)
  const heading = (): HTMLElement =>
    screen.getByRole('region', { name: 'Committed on branch' }).querySelector('.scm-head') as HTMLElement

  it('keeps Review All when the tree is clean and the branch is ahead, and folds the files against the base', () => {
    withBranch(onBranch)
    render(<ChangesTab />)
    expect(screen.getByText('No changes')).toBeTruthy()
    expect(heading().textContent).toBe('Committed on branch2')
    expect(heading().getAttribute('title')).toBe('vs origin/main')
    expect(screen.queryByTitle('src/limits.ts')).toBeNull()

    unfold(/^Committed on branch/)
    const group = screen.getByRole('region', { name: 'Committed on branch' })
    expect(within(group).getByTitle('src/limits.ts').querySelector('.change__stat')?.textContent).toBe('+40 −0')

    fireEvent.click(screen.getByRole('button', { name: 'Review All' }))
    expect(reviews()).toHaveLength(1)
  })

  it('counts the files past the cap it does not list', () => {
    useWorkspaceStore.setState({
      branchChanges: {
        w1: { worktreeId: 'w1', changes: onBranch, total: 2002, limit: 2, truncated: true, readAt: 0 }
      }
    })
    render(<ChangesTab />)
    expect(heading().textContent).toBe('Committed on branch2,002')
    unfold(/^Committed on branch/)
    expect(within(screen.getByRole('region', { name: 'Committed on branch' })).getByText('+2,000 more')).toBeTruthy()
  })

  it('opens the review on the branch at the file picked', () => {
    withBranch(onBranch)
    useReviewStore.setState({ scope: { w1: 'uncommitted' } })
    render(<ChangesTab />)
    unfold(/^Committed on branch/)
    fireEvent.click(within(screen.getByRole('region', { name: 'Committed on branch' })).getByTitle('src/limits.ts'))
    expect(reviews()).toHaveLength(1)
    expect(useReviewStore.getState().scope.w1).toBe('branch')
    expect(useReviewStore.getState().jump.w1).toBe('src/limits.ts')
  })

  // The owner's panel listed every file twice, once as uncommitted and again on the branch.
  it('lists a file once: still uncommitted, it is not also committed', () => {
    withBranch(onBranch)
    withChanges(rows)
    render(<ChangesTab />)
    const changes = screen.getByRole('region', { name: 'Changes' })
    expect(changes.querySelector('.scm-head')?.textContent).toBe('Changes3')
    expect(heading().textContent).toBe('Committed on branch1')
    unfold(/^Committed on branch/)
    expect(screen.getAllByTitle('README.md')).toHaveLength(1)
  })

  it('has no branch group, and no Review All, when nothing differs from the base', () => {
    withBranch([])
    render(<ChangesTab />)
    expect(screen.queryByRole('region', { name: 'Committed on branch' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Review All' })).toBeNull()
  })
})

describe('the pull request’s checks', () => {
  const PR = 'https://github.com/team/pager/pull/42'
  const withPull = (pullRequest?: WorktreeLanding['pullRequest']): void => {
    seed({ ahead: 0 })
    useWorkspaceStore.setState({
      landings: {
        w1: {
          worktreeId: 'w1',
          branch: 'rewrite-the-pager',
          base: 'main',
          host: 'github',
          published: true,
          unmerged: 1,
          merged: false,
          readAt: 0,
          ...(pullRequest === undefined ? {} : { pullRequest })
        }
      }
    })
  }
  const failing: NonNullable<WorktreeLanding['pullRequest']> = {
    number: 42,
    url: PR,
    state: 'open',
    review: 'changes',
    checks: {
      passing: 1,
      failing: 1,
      pending: 0,
      list: [
        { name: 'test', state: 'fail', url: 'https://github.com/team/pager/actions/runs/1/job/2' },
        { name: 'lint', state: 'pass' }
      ]
    }
  }
  const agent = (overrides: Partial<Terminal> = {}): Terminal => ({
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
    lastOutputAt: 0,
    ...overrides
  })

  it('says the state, the failing count and the review, each a link, with a row per check', () => {
    withPull(failing)
    render(<ChangesTab />)
    const section = screen.getByRole('region', { name: 'Pull Request #42' })

    expect(within(section).getByText('Open')).toBeTruthy()
    fireEvent.click(within(section).getByRole('button', { name: '#42' }))
    expect(openInBrowser).toHaveBeenLastCalledWith(PR)
    fireEvent.click(within(section).getByRole('button', { name: '✗ 1 failing' }))
    expect(openInBrowser).toHaveBeenLastCalledWith(`${PR}/checks`)
    fireEvent.click(within(section).getByRole('button', { name: 'Changes requested' }))
    expect(openInBrowser).toHaveBeenLastCalledWith(`${PR}/files`)
    const checks = within(within(section).getByRole('list', { name: 'Checks' })).getAllByRole('listitem')
    expect(checks.map((row) => row.textContent)).toEqual(['✗test', '✓lint'])
    fireEvent.click(within(checks[0] as HTMLElement).getByRole('button', { name: 'test' }))
    expect(openInBrowser).toHaveBeenLastCalledWith('https://github.com/team/pager/actions/runs/1/job/2')
    // Today's button stays, beside it.
    expect(screen.getByRole('button', { name: 'Open Pull Request #42' })).toBeTruthy()
  })

  it('says draft, and nothing about checks or review it was not told', () => {
    withPull({ number: 42, url: PR, state: 'open', draft: true })
    render(<ChangesTab />)
    const section = screen.getByRole('region', { name: 'Pull Request #42' })

    expect(within(section).getByText('Draft')).toBeTruthy()
    expect(within(section).queryByRole('list', { name: 'Checks' })).toBeNull()
    expect(within(section).queryByRole('button', { name: 'Send Failure to Agent' })).toBeNull()
  })

  it('is today’s button alone without gh', () => {
    withPull(undefined)
    render(<ChangesTab />)

    expect(screen.queryByRole('region', { name: /Pull Request/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Create Pull Request…' })).toBeTruthy()
  })

  it('sends the failure to an idle agent, and focuses it', async () => {
    withPull(failing)
    useWorkspaceStore.setState({ terminals: { t1: agent() } })
    call.mockImplementation((method: string) =>
      method === 'worktree.checkFailure'
        ? Promise.resolve({ worktreeId: 'w1', name: 'test', excerpt: 'FAIL src/pager.test.ts' })
        : Promise.resolve(undefined)
    )
    render(<ChangesTab />)

    fireEvent.click(screen.getByRole('button', { name: 'Send Failure to Agent' }))
    // Back from Reading Logs… once the Return that follows the paste has been typed too.
    await screen.findByRole('button', { name: 'Send Failure to Agent' })

    expect(call).toHaveBeenCalledWith('worktree.checkFailure', { worktreeId: 'w1', name: 'test' })
    const writes = call.mock.calls.filter(([method]) => method === 'terminal.write')
    expect(writes.map(([, params]) => (params as { data: string }).data.includes('FAIL src/pager.test.ts'))).toEqual([
      true,
      false
    ])
  })

  it('will not send to a working agent or a shell', () => {
    withPull(failing)
    useWorkspaceStore.setState({
      terminals: {
        t1: agent({ agentEvent: { event: 'UserPromptSubmit', at: 1 } } as Partial<Terminal>),
        t2: agent({ id: 't2', agent: undefined })
      }
    })
    render(<ChangesTab />)

    const send = screen.getByRole('button', { name: 'Send Failure to Agent' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    expect(send.title).toBe('No idle agent')
  })
})

// Zeros read from no checkout are not a clean tree, and nothing is coming to replace a Reading….
describe('a checkout missing from disk', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      worktrees: [{ ...childWorktree, parentId: undefined, baseRef: undefined, missing: true }],
      changes: {},
      statuses: { w1: status({ missing: true, ahead: 0, upstream: undefined }) }
    })
    render(<ChangesTab />)
  })

  it('says Checkout missing with the ways back, instead of Reading… or a clean tree', () => {
    expect(screen.getByText('Checkout missing')).toBeTruthy()
    for (const name of ['Restore', 'Locate…', 'Remove from teamree…']) {
      expect(screen.getByRole('button', { name })).toBeTruthy()
    }
    expect(screen.queryByText('Reading…')).toBeNull()
    expect(screen.queryByText(/clean|in sync|committed|No changes/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /^Commit/ })).toBeNull()
  })
})
