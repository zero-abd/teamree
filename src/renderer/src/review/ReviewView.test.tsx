/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '@shared/entities'

const call = vi.fn((_method: string, _params: unknown): Promise<unknown> => new Promise(() => {}))

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
const { useReviewStore } = await import('./reviewStore')
const { FilePane } = await import('../panes/FilePane')

const INITIAL = useWorkspaceStore.getState()

const MATH = `diff --git a/src/math.ts b/src/math.ts
--- a/src/math.ts
+++ b/src/math.ts
@@ -5,3 +5,5 @@ export function add(a: number, b: number): number {
 }
+
+export const sub = (a: number, b: number) => a - b
`
const NOTES = `diff --git a/docs/NOTES.md b/docs/NOTES.md
new file mode 100644
--- /dev/null
+++ b/docs/NOTES.md
@@ -0,0 +1 @@
+# Notes
`

let answer = MATH + NOTES

const worktree = {
  id: 'w1',
  projectId: 'p1',
  name: 'Add a sub function',
  task: 'Add a sub function to src/math.ts\nand note it in docs/NOTES.md',
  state: 'ready'
} as unknown as Worktree

beforeEach(() => {
  answer = MATH + NOTES
  call.mockImplementation((method: string, params: unknown) => {
    if (method !== 'worktree.diff') return new Promise(() => {})
    expect(params).toMatchObject({ worktreeId: 'w1', head: true })
    return Promise.resolve({ worktreeId: 'w1', staged: false, patch: answer, truncated: false, readAt: 0 })
  })
  useReviewStore.setState({ viewed: {}, batch: {}, queued: {} })
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      activeWorktreeId: 'w1',
      worktrees: [worktree],
      changes: {
        w1: {
          worktreeId: 'w1',
          changes: [
            { path: 'docs/NOTES.md', kind: 'untracked', staged: false, unstaged: true },
            { path: 'src/math.ts', kind: 'modified', staged: false, unstaged: true }
          ],
          total: 2,
          limit: 500,
          truncated: false,
          readAt: 0
        }
      }
    },
    true
  )
})

afterEach(() => {
  cleanup()
})

async function mount(): Promise<void> {
  render(
    <FilePane paneId="file:r" worktreeId="w1" path="Review" review focused onFocus={() => {}} onClose={() => {}} />
  )
  await waitFor(() => expect(document.querySelectorAll('.patch__file')).toHaveLength(2))
}

const opened = (): boolean[] =>
  [...document.querySelectorAll<HTMLDetailsElement>('.patch__file')].map((file) => file.open)

describe('Review All', () => {
  it('reads every change against HEAD and draws each file in the Changes list’s order under the task', async () => {
    await mount()
    const names = [...document.querySelectorAll('.patch__fileName')].map((name) => name.textContent)
    expect(names).toEqual(['docs/NOTES.md', 'src/math.ts'])
    expect(document.querySelector('.review__task')?.textContent).toBe(worktree.task)
    expect(screen.getByText('2 files · +3 −0')).toBeTruthy()
  })

  it('folds a file marked viewed, keeps it viewed through a re-read, and opens it again once it changes', async () => {
    await mount()
    const [notes] = screen.getAllByRole('checkbox', { name: 'Viewed' })
    fireEvent.click(notes!)
    expect(opened()).toEqual([false, true])
    expect(screen.getByText('2 files · +3 −0 · 1/2 viewed')).toBeTruthy()

    const reads = (): number => call.mock.calls.filter(([method]) => method === 'worktree.diff').length
    const before = reads()
    act(() => useWorkspaceStore.setState((state) => ({ worktreeFilesEpoch: state.worktreeFilesEpoch + 1 })))
    await waitFor(() => expect(reads()).toBe(before + 1))
    expect(opened()).toEqual([false, true])

    answer = MATH + NOTES.replace('+# Notes', '+# Notes\n+sub() added.').replace('@@ -0,0 +1 @@', '@@ -0,0 +1,2 @@')
    act(() => useWorkspaceStore.setState((state) => ({ worktreeFilesEpoch: state.worktreeFilesEpoch + 1 })))
    await waitFor(() => expect(opened()).toEqual([true, true]))
    expect((screen.getAllByRole('checkbox', { name: 'Viewed' })[0] as HTMLInputElement).checked).toBe(false)
  })
})
