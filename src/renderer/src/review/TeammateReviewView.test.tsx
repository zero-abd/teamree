/** @vitest-environment jsdom */

// A teammate's task as a read-only tab: their diff, comments batched on its lines, and one send back to them.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TeammatePresence, Worktree } from '@shared/entities'
import type { TeammateDiff } from '@shared/teammateReview'

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
const { useTeammateReview } = await import('./teammateReviewStore')
const { TeammateReviewView } = await import('./TeammateReviewView')

const INITIAL = useWorkspaceStore.getState()
const TASK = 'peer:bobkey:wt_fix'

const PATCH = `diff --git a/footer.txt b/footer.txt
--- a/footer.txt
+++ b/footer.txt
@@ -1,2 +1,2 @@
 © 2026
-old
+new
`

const diff = (over: Partial<TeammateDiff> = {}): TeammateDiff => ({
  worktreeId: TASK,
  handle: 'bob',
  branch: 'fix-footer',
  source: 'peer',
  patch: PATCH,
  truncated: false,
  readAt: 0,
  ...over
})

const presence: TeammatePresence = {
  state: 'read',
  projectId: 'p1',
  worktrees: [
    {
      id: TASK,
      name: 'fix footer copy',
      task: 'Fix the footer copy',
      branch: 'fix-footer',
      state: 'ready',
      panes: [],
      handle: 'bob',
      publicKey: 'bobkey',
      heardAt: 0,
      live: true
    }
  ],
  teammates: [{ handle: 'bob', publicKey: 'bobkey', connected: true, heardAt: 0 }],
  readAt: 0
}

let answer: TeammateDiff | Error = diff()

beforeEach(() => {
  answer = diff()
  call.mockReset()
  call.mockImplementation((method: string) => {
    if (method === 'teamwork.teammateDiff')
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
    if (method === 'teamwork.sendReview') return Promise.resolve({ delivered: true })
    return new Promise(() => {})
  })
  useTeammateReview.setState({ batch: {} })
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      activeWorktreeId: 'w1',
      worktrees: [{ id: 'w1', projectId: 'p1', name: 'mine', state: 'ready' } as unknown as Worktree],
      teammates: { p1: presence }
    },
    true
  )
})

afterEach(() => {
  cleanup()
})

function view(): void {
  render(<TeammateReviewView projectId="p1" worktreeId={TASK} title="bob · fix footer copy" onClose={() => {}} />)
}

async function mount(): Promise<void> {
  view()
  await waitFor(() => expect(document.querySelectorAll('.patch__file')).toHaveLength(1))
}

describe('a teammate’s task', () => {
  it('reads their diff, says where it came from, and shows their task over it', async () => {
    await mount()
    expect(call).toHaveBeenCalledWith('teamwork.teammateDiff', { projectId: 'p1', worktreeId: TASK })
    expect(screen.getByText('bob · fix footer copy · unpushed · 1 file · +1 −1')).toBeTruthy()
    expect(document.querySelector('.review__task')?.textContent).toBe('Fix the footer copy')
    cleanup()
    answer = diff({ source: 'origin' })
    await mount()
    expect(screen.getByText('bob · fix footer copy · origin/fix-footer · 1 file · +1 −1')).toBeTruthy()
  })

  it('says why when there is nothing to read', async () => {
    answer = new Error('bob has not pushed fix-footer')
    view()
    expect(await screen.findByText('bob has not pushed fix-footer')).toBeTruthy()
  })

  it('batches comments on its lines and sends them to its owner in one go', async () => {
    await mount()
    fireEvent.click(screen.getAllByRole('button', { name: 'Comment on line 2' }).at(-1)!)
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment' }), { target: { value: 'Say the brand name' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Comment' }), { key: 'Enter' })
    expect(screen.queryByRole('group', { name: /^Comment on/ })).toBeNull()
    expect(screen.getByText('Say the brand name')).toBeTruthy()
    expect(call).not.toHaveBeenCalledWith('teamwork.sendReview', expect.anything())

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send 1 to bob' }))
      await Promise.resolve()
    })
    expect(call).toHaveBeenCalledWith('teamwork.sendReview', {
      projectId: 'p1',
      worktreeId: TASK,
      comments: [
        {
          path: 'footer.txt',
          lines: [{ kind: 'added', text: 'new', oldNumber: null, newNumber: 2 }],
          note: 'Say the brand name'
        }
      ]
    })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Send 1 to bob' })).toBeNull())
    expect(useWorkspaceStore.getState().notices.map((notice) => notice.text)).toContain('Sent 1 comment to bob')
  })

  it('keeps the comments when the send is refused, and says why', async () => {
    await mount()
    call.mockImplementation((method: string) =>
      method === 'teamwork.sendReview'
        ? Promise.reject(new Error('bob is offline'))
        : method === 'teamwork.teammateDiff'
          ? Promise.resolve(diff())
          : new Promise(() => {})
    )
    fireEvent.click(screen.getAllByRole('button', { name: 'Comment on line 2' }).at(-1)!)
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment' }), { target: { value: 'x' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Comment' }), { key: 'Enter', metaKey: true })
    await waitFor(() =>
      expect(useWorkspaceStore.getState().notices.map((notice) => notice.text)).toContain('Not sent: bob is offline')
    )
    expect(useTeammateReview.getState().batch[TASK]).toHaveLength(1)
  })
})
