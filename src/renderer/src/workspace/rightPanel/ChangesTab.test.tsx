/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeChange, WorktreeLog, WorktreePush, WorktreeStatus } from '@shared/entities'
import { fileLeavesIn, isCommitLeaf } from '@shared/filePane'

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

const { useWorkspaceStore } = await import('../../state/workspaceStore')
const { ChangesTab, canDiscard } = await import('./ChangesTab')
const { ConfirmDiscardDialog } = await import('../../dialogs/ConfirmDiscardDialog')
const { FilePane } = await import('../../panes/FilePane')

const INITIAL = useWorkspaceStore.getState()

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

beforeEach(() => {
  call.mockReset()
  call.mockImplementation(() => new Promise(() => {}))
  openInBrowser.mockReset()
  seed()
})

describe('pushing from the changes tab', () => {
  it('pushes, shows it is busy, then offers the review page', async () => {
    const push = pendingPush()
    render(<ChangesTab />)

    fireEvent.click(screen.getByRole('button', { name: 'Push' }))
    expect(call).toHaveBeenCalledWith('worktree.push', { worktreeId: 'w1' })
    expect(screen.getByRole('button', { name: 'Pushing…' })).toHaveProperty('disabled', true)

    await act(async () => push.resolve(pushed))
    fireEvent.click(screen.getByRole('button', { name: 'Open review' }))
    expect(openInBrowser).toHaveBeenCalledWith(pushed.reviewUrl)
    expect(screen.queryByRole('button', { name: 'Push' })).toBeNull()
  })

  it('says why a push failed once, in one clause beside the button, with git’s words behind it', async () => {
    const push = pendingPush()
    render(<ChangesTab />)

    fireEvent.click(screen.getByRole('button', { name: 'Push' }))
    const said = "fatal: '/tmp/missing.git' does not appear to be a git repository"
    await act(async () => push.reject(refusal('Remote not found', said)))

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe('Remote not found')
    expect(alert.parentElement?.lastElementChild?.textContent).toBe('Push')
    const error = screen.getByRole('button', { name: 'Remote not found' })
    expect(error.title).toBe(said)
    expect(useWorkspaceStore.getState().notices).toEqual([])

    const copyToClipboard = vi.fn(async () => {})
    act(() => useWorkspaceStore.setState({ copyToClipboard }))
    fireEvent.click(error)
    expect(copyToClipboard).toHaveBeenCalledWith(said, 'the error')
  })

  it('offers neither force nor a pull that does not exist when the remote is ahead', async () => {
    const push = pendingPush()
    render(<ChangesTab />)

    fireEvent.click(screen.getByRole('button', { name: 'Push' }))
    await act(async () => push.reject(refusal('Rejected: remote is ahead', 'rejected (fetch first)')))

    expect(screen.getByRole('alert').textContent).toBe('Rejected: remote is ahead')
    expect(screen.getByRole('button', { name: 'Push' })).toHaveProperty('disabled', false)
    expect(screen.queryByRole('button', { name: /force|pull/i })).toBeNull()
  })

  it('says a failure git never explained as one clause too', async () => {
    const push = pendingPush()
    render(<ChangesTab />)

    fireEvent.click(screen.getByRole('button', { name: 'Push' }))
    await act(async () => push.reject(new Error('worktree w1 is not ready for pushing')))

    expect(screen.getByRole('alert').textContent).toBe('Push failed')
    expect(screen.getByRole('button', { name: 'Push failed' }).title).toBe('worktree w1 is not ready for pushing')
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

  it('toasts Pushed, and nothing more, when it lands', async () => {
    const push = pendingPush()
    render(<ChangesTab />)

    fireEvent.click(screen.getByRole('button', { name: 'Push' }))
    await act(async () => push.resolve({ ...pushed, setUpstream: true, uncommitted: 2 }))

    const [notice] = useWorkspaceStore.getState().notices
    expect(notice).toMatchObject({
      text: 'Pushed',
      tone: 'info',
      action: { label: 'Open review', url: pushed.reviewUrl }
    })
  })

  it('hides Publish on a worktree with nothing in it', () => {
    seed({ upstream: null, ahead: 0 })
    useWorkspaceStore.setState({ logs: { w1: { ...log, commits: [] } } })
    render(<ChangesTab />)
    expect(screen.queryByRole('button', { name: 'Publish branch' })).toBeNull()
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
    expect(primary('Commit All')).toBe(true)
    expect(primary('Push')).toBe(false)
  })

  it('is Push once everything is committed and some of it is not on the remote', () => {
    seed({ ahead: 2 })
    render(<ChangesTab />)
    expect(primary('Push')).toBe(true)
  })

  it('is Commit, with Publish quiet, on a new branch that has only edits', () => {
    seed({ upstream: null, ahead: 0 })
    withChanges(rows)
    render(<ChangesTab />)
    expect(primary('Commit All')).toBe(true)
    expect(primary('Publish branch')).toBe(false)
  })

  it('is Publish on a new branch with commits and nothing uncommitted', () => {
    seed({ upstream: null, ahead: 1 })
    render(<ChangesTab />)
    expect(primary('Publish branch')).toBe(true)
  })
})

describe('committing', () => {
  it('commits every listed change, new files included, when nothing is ticked, and only the ticked ones otherwise', () => {
    withChanges(rows)
    render(<ChangesTab />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Commit message' }), { target: { value: 'Rank' } })

    fireEvent.click(screen.getByRole('checkbox', { name: 'Include src/app.ts in the next commit' }))
    expect(screen.queryByRole('button', { name: 'Commit All' })).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include src/app.ts in the next commit' }))

    fireEvent.click(screen.getByRole('button', { name: 'Commit All' }))
    expect(call).toHaveBeenCalledWith('worktree.commit', {
      worktreeId: 'w1',
      message: 'Rank',
      paths: ['README.md', 'src/app.ts', 'src/gone.ts']
    })
  })

  it('switches to Commit once a file is ticked', () => {
    withChanges(rows)
    render(<ChangesTab />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include README.md in the next commit' }))
    expect(screen.getByRole('button', { name: 'Commit' })).toBeTruthy()
  })

  // An agent that only created files is the common case: its work must be one click from a commit.
  it('commits all on a worktree whose only changes are new files', () => {
    withChanges([{ path: 'src/app.ts', kind: 'untracked', staged: false, unstaged: true }])
    render(<ChangesTab />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Commit message' }), { target: { value: 'Rank' } })

    const commitAll = screen.getByRole('button', { name: 'Commit All' })
    expect(commitAll).toHaveProperty('disabled', false)
    fireEvent.click(commitAll)
    expect(call).toHaveBeenCalledWith('worktree.commit', { worktreeId: 'w1', message: 'Rank', paths: ['src/app.ts'] })
  })
})

describe('what git has staged', () => {
  const partly: WorktreeChange = { path: 'src/rank.ts', kind: 'modified', staged: true, unstaged: true }
  const whole: WorktreeChange = { path: 'src/done.ts', kind: 'modified', staged: true, unstaged: false }
  const loose: WorktreeChange = { path: 'README.md', kind: 'modified', staged: false, unstaged: true }
  const box = (path: string): HTMLInputElement =>
    screen.getByRole('checkbox', { name: `Include ${path} in the next commit` }) as HTMLInputElement

  it('commits the index alone, naming no paths, when something is staged and nothing ticked', () => {
    withChanges([partly, loose])
    render(<ChangesTab />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Commit message' }), { target: { value: 'Rank' } })

    expect(screen.queryByRole('button', { name: 'Commit All' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Commit Staged' }))
    expect(call).toHaveBeenCalledWith('worktree.commit', { worktreeId: 'w1', message: 'Rank' })
  })

  it('shows a partly staged row mixed, and a ticked one whole', () => {
    withChanges([partly, loose])
    render(<ChangesTab />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Commit message' }), { target: { value: 'Rank' } })
    expect(box('src/rank.ts').indeterminate).toBe(true)
    expect(box('src/rank.ts').checked).toBe(false)

    fireEvent.click(box('src/rank.ts'))
    expect(box('src/rank.ts').indeterminate).toBe(false)
    expect(box('src/rank.ts').checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))
    expect(call).toHaveBeenCalledWith('worktree.commit', { worktreeId: 'w1', message: 'Rank', paths: ['src/rank.ts'] })
  })

  it('shows a wholly staged row ticked, and counts it', () => {
    withChanges([whole, loose])
    render(<ChangesTab />)
    expect(box('src/done.ts').checked).toBe(true)
    expect(screen.getByText('1/2')).toBeTruthy()
    const all = screen.getByRole('checkbox', { name: 'All' }) as HTMLInputElement
    expect(all.indeterminate).toBe(true)

    fireEvent.click(all)
    expect(all.checked).toBe(true)
    expect(screen.getByText('2/2')).toBeTruthy()
    fireEvent.click(all)
    expect(box('src/done.ts').checked).toBe(true)
    expect(box('README.md').checked).toBe(false)
  })

  const commitButton = (): HTMLElement => screen.getByRole('button', { name: /^Commit/ })

  it('unstages a wholly staged row when it is unticked, and the button follows', () => {
    withChanges([whole, loose])
    render(<ChangesTab />)
    expect(commitButton().textContent).toBe('Commit Staged')

    fireEvent.click(box('src/done.ts'))
    expect(call).toHaveBeenCalledWith('worktree.unstagePath', { worktreeId: 'w1', path: 'src/done.ts' })
    expect(useWorkspaceStore.getState().stagedPaths).toEqual([])

    act(() => withChanges([{ ...whole, staged: false, unstaged: true }, loose]))
    expect(box('src/done.ts').checked).toBe(false)
    expect(commitButton().textContent).toBe('Commit All')
  })

  it('unstages the whole of a partly staged row when it is ticked and then unticked', () => {
    withChanges([partly, loose])
    render(<ChangesTab />)
    fireEvent.click(box('src/rank.ts'))
    expect(commitButton().textContent).toBe('Commit')
    expect(call).not.toHaveBeenCalledWith('worktree.unstagePath', expect.anything())

    fireEvent.click(box('src/rank.ts'))
    expect(call).toHaveBeenCalledWith('worktree.unstagePath', { worktreeId: 'w1', path: 'src/rank.ts' })
    expect(useWorkspaceStore.getState().stagedPaths).toEqual([])

    act(() => withChanges([{ ...partly, staged: false }, loose]))
    expect(box('src/rank.ts').checked).toBe(false)
    expect(box('src/rank.ts').indeterminate).toBe(false)
    expect(commitButton().textContent).toBe('Commit All')
  })

  it('leaves an unstaged row to the tick alone', () => {
    withChanges([loose])
    render(<ChangesTab />)
    fireEvent.click(box('README.md'))
    fireEvent.click(box('README.md'))
    expect(call).not.toHaveBeenCalledWith('worktree.unstagePath', expect.anything())
  })

  it('leaves All nothing to do when git already holds every change', () => {
    withChanges([whole])
    render(<ChangesTab />)
    const all = screen.getByRole('checkbox', { name: 'All' }) as HTMLInputElement
    expect(all.checked).toBe(true)
    expect(all.disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Commit Staged' })).toBeTruthy()
  })
})

describe('the changes header', () => {
  it('names the branch and how far it is from its upstream, with the push button after', () => {
    seed({ ahead: 1, behind: 2 })
    render(<ChangesTab />)
    const head = screen.getByRole('button', { name: 'Push' }).parentElement as HTMLElement
    expect(head.querySelector('.changes__ref')?.textContent).toBe('rewrite-the-pager · ↑1 ↓2')
    expect(head.lastElementChild?.textContent).toBe('Push')
  })

  it('counts against the base when the branch tracks nothing, and says what each arrow measures', () => {
    seed({ upstream: null, ahead: 2, behind: 3 })
    render(<ChangesTab />)
    const ref = document.querySelector('.changes__ref') as HTMLElement
    expect(ref.textContent).toBe('rewrite-the-pager · ↑2 ↓3')
    expect(ref.title).toBe('↑ origin/main  ↓ origin/main')
    expect(screen.getByRole('button', { name: 'Publish branch' })).toBeTruthy()
  })
})

describe('the ahead and behind arrows', () => {
  it('shows nothing when both are zero', () => {
    seed({ ahead: 0, behind: 0 })
    render(<ChangesTab />)
    expect(document.querySelector('.changes__ref')?.textContent).toBe('rewrite-the-pager')
  })

  it('shows only the arrow that is not zero', () => {
    seed({ ahead: 2, behind: 0 })
    render(<ChangesTab />)
    expect(document.querySelector('.changes__ref')?.textContent).toBe('rewrite-the-pager · ↑2')
    cleanup()
    seed({ ahead: 0, behind: 3 })
    render(<ChangesTab />)
    expect(document.querySelector('.changes__ref')?.textContent).toBe('rewrite-the-pager · ↓3')
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

  it('is headed Commits with its count as a pill, the base ref in the hover', () => {
    seed()
    render(<ChangesTab />)
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
            author: 'A',
            committedAt: '',
            subject: 'Rank by recency',
            patch,
            truncated: false,
            readAt: 0
          })
        : new Promise(() => {})
    )
    render(<ChangesTab />)

    const row = screen.getByRole('button', { name: 'aaaaaaa Rank by recency' })
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
    expect(screen.queryByRole('button', { name: 'Stage' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Diff' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Inline' })).toBeTruthy()
    expect(call).not.toHaveBeenCalledWith('file.read', expect.anything())
  })
})

describe('ticking every file', () => {
  it('is a checkbox named All, with the count after it', () => {
    seed()
    useWorkspaceStore.setState({
      changes: {
        w1: {
          worktreeId: 'w1',
          changes: [
            { path: 'README.md', kind: 'modified', staged: false, unstaged: true },
            { path: 'src/app.ts', kind: 'untracked', staged: false, unstaged: true }
          ],
          total: 2,
          limit: 500,
          truncated: false,
          readAt: 0
        }
      }
    })
    render(<ChangesTab />)

    const all = screen.getByRole('checkbox', { name: 'All' })
    expect(screen.getByText('0/2')).toBeTruthy()
    fireEvent.click(all)
    expect(all).toHaveProperty('checked', true)
    expect(screen.getByText('2/2')).toBeTruthy()
    expect(screen.queryByText(/selected/)).toBeNull()
  })

  it('is mixed while only some are ticked', () => {
    withChanges(rows)
    render(<ChangesTab />)
    const all = screen.getByRole('checkbox', { name: 'All' }) as HTMLInputElement

    fireEvent.click(screen.getByRole('checkbox', { name: 'Include README.md in the next commit' }))
    expect(all.indeterminate).toBe(true)
    expect(all.checked).toBe(false)

    fireEvent.click(all)
    expect(all.indeterminate).toBe(false)
    expect(all.checked).toBe(true)
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
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }))

    expect(call).not.toHaveBeenCalledWith('worktree.discardPath', expect.anything())
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('offers the same from the row’s right-click menu', () => {
    withRows()
    render(<Tab />)

    fireEvent.contextMenu(screen.getByTitle('README.md'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Discard…' }))

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
