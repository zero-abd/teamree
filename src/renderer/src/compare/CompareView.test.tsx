/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree, WorktreeCompare } from '@shared/entities'
import { fileLeavesIn, isCompareLeaf } from '@shared/filePane'

const call = vi.fn()

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
const { FilePane } = await import('../panes/FilePane')

const INITIAL = useWorkspaceStore.getState()
const TASK = 'Add a sub function to src/math.ts'

function worktree(id: string, agent: string): Worktree {
  const name = `${TASK} ${agent}`
  return {
    id,
    projectId: 'p1',
    name,
    branch: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    path: `/wt/${id}`,
    startedFrom: 'origin/main',
    state: 'ready',
    createdAt: 1,
    task: TASK
  }
}

const filePatch = (path: string, added: string[], status: 'new' | 'modified' = 'modified'): string =>
  [
    `diff --git a/${path} b/${path}`,
    ...(status === 'new' ? ['new file mode 100644', 'index 0000000..1111111'] : ['index 1111111..2222222 100644']),
    status === 'new' ? '--- /dev/null' : `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${status === 'new' ? '0,0' : '1,1'} +1,${added.length + (status === 'new' ? 0 : 1)} @@`,
    ...(status === 'new' ? [] : [' export {}']),
    ...added.map((line) => `+${line}`),
    ''
  ].join('\n')

const SUB = filePatch('src/math.ts', ['export const sub = (a: number, b: number) => a - b'])

const compared: WorktreeCompare = {
  base: 'c'.repeat(40),
  left: {
    worktreeId: 'w-claude',
    head: 'a'.repeat(40),
    patch: SUB + filePatch('src/math.test.ts', ['test(sub)'], 'new'),
    truncated: false
  },
  right: { worktreeId: 'w-codex', head: 'c'.repeat(40), patch: SUB, truncated: false },
  readAt: 0
}

beforeEach(() => {
  call.mockReset()
  call.mockImplementation(() => new Promise(() => {}))
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      worktrees: [worktree('w-claude', 'claude'), worktree('w-codex', 'codex')],
      activeWorktreeId: 'w-claude',
      layouts: {
        'w-claude': { worktreeId: 'w-claude', root: { kind: 'leaf', terminalId: 't1' }, focusedTerminalId: 't1' }
      }
    },
    true
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('opening a compare', () => {
  it('adds a tab to the file column titled by both runs, focused, and goes back to it the second time', async () => {
    await useWorkspaceStore.getState().openCompare('w-claude', 'w-codex', 'claude vs codex')
    const leaves = fileLeavesIn(useWorkspaceStore.getState().layouts['w-claude']!.root)
    expect(leaves).toHaveLength(1)
    const leaf = leaves[0]!
    expect(isCompareLeaf(leaf) && leaf.compare).toBe('w-codex')
    expect(leaf.path).toBe('claude vs codex')
    expect(useWorkspaceStore.getState().layouts['w-claude']!.focusedTerminalId).toBe(leaf.terminalId)

    await useWorkspaceStore.getState().openCompare('w-claude', 'w-codex', 'claude vs codex')
    expect(fileLeavesIn(useWorkspaceStore.getState().layouts['w-claude']!.root)).toHaveLength(1)
  })
})

describe('the compare pane', () => {
  const renderCompare = (): void => {
    render(
      <FilePane
        paneId="file:x"
        worktreeId="w-claude"
        path="claude vs codex"
        compare="w-codex"
        focused
        onFocus={() => {}}
        onClose={() => {}}
      />
    )
  }

  it('reads both runs against their shared start and heads each side with its agent, task and Open', async () => {
    call.mockResolvedValue(compared)
    const openWorktree = vi.fn(async () => {})
    useWorkspaceStore.setState({ openWorktree })
    renderCompare()

    expect(call).toHaveBeenCalledWith('worktree.compare', { worktreeId: 'w-claude', otherId: 'w-codex' })
    const claude = await screen.findByRole('group', { name: `claude · ${TASK}` })
    const codex = screen.getByRole('group', { name: `codex · ${TASK}` })
    expect(within(claude).getByText('2 files')).toBeTruthy()
    expect(within(codex).getByText('1 file')).toBeTruthy()

    fireEvent.click(within(codex).getByRole('button', { name: 'Open' }))
    expect(openWorktree).toHaveBeenCalledWith('w-codex')
  })

  it('pairs each file both runs touched, marks one only a run touched, and offers nothing to stage', async () => {
    call.mockResolvedValue(compared)
    renderCompare()

    const math = await screen.findByRole('region', { name: 'src/math.ts' })
    expect(within(math).getByText('same')).toBeTruthy()
    expect(math.querySelectorAll('.patch__row--added')).toHaveLength(2)

    const test = screen.getByRole('region', { name: 'src/math.test.ts' })
    expect(within(test).getByText('only claude')).toBeTruthy()
    expect(within(test).getByText('Untouched')).toBeTruthy()
    expect(test.querySelectorAll('.patch__row--added')).toHaveLength(1)

    expect(screen.queryByRole('button', { name: 'Stage' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Side by side' })).toBeTruthy()
  })

  it('opens side by side whatever the diff preference, and stacks the runs on Inline without changing it', async () => {
    call.mockResolvedValue(compared)
    useWorkspaceStore.setState({ diffLayout: 'inline' })
    // jsdom lays nothing out; a pane wide enough for two columns.
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200)
    renderCompare()
    await screen.findByRole('region', { name: 'src/math.ts' })
    expect(document.querySelector('.compare--split')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Inline' }))
    expect(document.querySelector('.compare--inline')).not.toBeNull()
    expect(useWorkspaceStore.getState().diffLayout).toBe('inline')
  })

  it('says why when the runs cannot be read', async () => {
    call.mockRejectedValue(new Error('these worktrees have no commit in common'))
    renderCompare()
    expect(await screen.findByText('these worktrees have no commit in common')).toBeTruthy()
  })
})
