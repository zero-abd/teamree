/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@shared/entities'

const call = vi.fn(async (_method: string, _params: unknown): Promise<unknown> => ({ written: true }))

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
const { PatchView } = await import('../workspace/PatchView')
const { pasted } = await import('./reviewComments')

const INITIAL = useWorkspaceStore.getState()

const PATCH = `diff --git a/src/math.ts b/src/math.ts
--- a/src/math.ts
+++ b/src/math.ts
@@ -5,3 +5,7 @@ export function add(a: number, b: number): number {
 export function mul(a: number, b: number): number {
   return a * b
 }
+
+export function sub(a: number, b: number): number {
+  return a - b
+}
`

const pane = (id: string, fields: Partial<Terminal>): Terminal =>
  ({
    id,
    worktreeId: 'w1',
    title: 'zsh',
    shell: '/bin/zsh',
    running: true,
    busy: false,
    lastOutputAt: 0,
    ...fields
  }) as Terminal

const writes = (): unknown[] => call.mock.calls.filter(([method]) => method === 'terminal.write').map(([, p]) => p)

function mount(terminals: Record<string, Terminal>): void {
  useWorkspaceStore.setState({ ...INITIAL, activeWorktreeId: 'w1', terminals }, true)
  render(<PatchView patch={PATCH} truncated={false} layout="inline" commentsIn="w1" />)
}

beforeEach(() => {
  call.mockClear()
  useReviewStore.setState({ viewed: {}, batch: {}, queued: {} })
})

afterEach(() => {
  cleanup()
})

describe('a comment on diff lines', () => {
  it('opens under the line its gutter + was clicked on, and a shift-click takes the lines down to another', () => {
    mount({ claude: pane('claude', { agent: 'claude' }) })
    fireEvent.click(screen.getByRole('button', { name: 'Comment on line 9' }))
    expect(screen.getByRole('group', { name: 'Comment on src/math.ts:9' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Comment on line 11' }), { shiftKey: true })
    expect(screen.getByRole('group', { name: 'Comment on src/math.ts:9-11' })).toBeTruthy()
    expect(document.querySelectorAll('.patch__row--picked')).toHaveLength(3)
  })

  it('sends to the worktree’s agent pane by name, typed as a paste and then Return', async () => {
    mount({ shell: pane('shell', {}), claude: pane('claude', { agent: 'claude' }) })
    fireEvent.click(screen.getByRole('button', { name: 'Comment on line 10' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment' }), { target: { value: 'Name it subtract.' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send to Claude Code' }))
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
    expect(writes()).toEqual([
      {
        terminalId: 'claude',
        data: pasted('src/math.ts:10\n```diff\n+  return a - b\n```\nName it subtract.')
      },
      { terminalId: 'claude', data: '\r' }
    ])
    expect(screen.queryByRole('group', { name: /^Comment on/ })).toBeNull()
  })

  it('offers no Send without an agent pane, and writes nothing to a shell', () => {
    mount({ shell: pane('shell', {}) })
    fireEvent.click(screen.getByRole('button', { name: 'Comment on line 10' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment' }), { target: { value: 'x' } })
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Comment' }), { key: 'Enter' })
    expect(writes()).toEqual([])
  })

  it('keeps a comment for the batch without typing anything', () => {
    mount({ claude: pane('claude', { agent: 'claude' }) })
    fireEvent.click(screen.getByRole('button', { name: 'Comment on line 9' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment' }), { target: { value: 'Test this.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add to Batch' }))
    expect(useReviewStore.getState().batch.w1).toHaveLength(1)
    expect(writes()).toEqual([])
  })

  it('opens on the selected lines with c', () => {
    mount({ claude: pane('claude', { agent: 'claude' }) })
    const texts = document.querySelectorAll('.patch__text')
    const range = document.createRange()
    range.setStart(texts[4]!.firstChild!, 0)
    range.setEnd(texts[5]!.firstChild!, 1)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    fireEvent.keyDown(document.body, { key: 'c' })
    expect(screen.getByRole('group', { name: 'Comment on src/math.ts:9-10' })).toBeTruthy()
  })

  it('picks among several agent panes', () => {
    mount({ claude: pane('claude', { agent: 'claude' }), codex: pane('codex', { agent: 'codex' }) })
    fireEvent.click(screen.getByRole('button', { name: 'Comment on line 9' }))
    const picker = screen.getByRole('combobox', { name: 'Agent pane' }) as HTMLSelectElement
    expect([...picker.options].map((option) => option.text)).toEqual(['Claude Code', 'Codex'])
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
  })
})
