/** @vitest-environment jsdom */

// ⌘⇧↓ and ⌘⇧↑ select to the end and start of the text in a code pane, as in every Mac text field:
// Go to Next Needing You must not take them, even with a pane asking.

import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileContent, Terminal } from '@shared/entities'

// CodeMirror reads the platform once, when it loads, to bind ⌘ rather than Ctrl.
vi.hoisted(() => Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true }))

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

const { EditorView } = await import('@codemirror/view')
const { useWorkspaceStore } = await import('../state/workspaceStore')
const { resolvePlatformModifier } = await import('../keyboard/platformModifier')
const { useWorkspaceShortcuts } = await import('../keyboard/useWorkspaceShortcuts')
const { FileView } = await import('./FileView')

// jsdom has no layout; CodeMirror measures text ranges.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList
Range.prototype.getBoundingClientRect = () => new DOMRect()

const INITIAL = useWorkspaceStore.getState()
const MAC = resolvePlatformModifier('darwin')
const revealPane = vi.fn(async () => {})

const TEXT = 'one\ntwo\nthree\n'
const content: FileContent = {
  worktreeId: 'w1',
  path: 'src/app.ts',
  content: TEXT,
  exists: true,
  size: TEXT.length,
  modifiedAt: 1,
  encoding: 'utf-8',
  lineEnding: '\n'
}

const asking: Terminal = {
  id: 't2',
  worktreeId: 'w2',
  title: 'claude',
  cwd: '/w2',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  running: true,
  busy: false,
  agent: 'claude',
  screenSays: 'waiting',
  lastOutputAt: 0
}

function Shortcuts(): null {
  useWorkspaceShortcuts(MAC)
  return null
}

beforeEach(() => {
  call.mockReset()
  call.mockImplementation(async (method: string) => (method === 'file.read' ? content : undefined))
  revealPane.mockClear()
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      projects: [{ id: 'p1', name: 'p', path: '/p', baseRef: 'main' }],
      worktrees: [
        {
          id: 'w1',
          projectId: 'p1',
          name: 'a',
          branch: 'a',
          path: '/w1',
          startedFrom: 'main',
          state: 'ready',
          createdAt: 0
        },
        {
          id: 'w2',
          projectId: 'p1',
          name: 'b',
          branch: 'b',
          path: '/w2',
          startedFrom: 'main',
          state: 'ready',
          createdAt: 0
        }
      ],
      activeWorktreeId: 'w1',
      terminals: { t2: asking },
      revealPane
    },
    true
  )
})

async function editor(): Promise<InstanceType<typeof EditorView>> {
  render(
    <>
      <Shortcuts />
      <FileView paneId="file:1" worktreeId="w1" path="src/app.ts" focused onFocus={() => {}} onClose={() => {}} />
    </>
  )
  const found = await waitFor(() => {
    const element = document.querySelector('.cm-content')
    if (!(element instanceof HTMLElement)) throw new Error('no editor yet')
    return element
  })
  return EditorView.findFromDOM(found)!
}

describe('the select keys in a code pane', () => {
  it('extends the selection to the end and the start, with a pane asking elsewhere', async () => {
    const view = await editor()
    act(() => view.dispatch({ selection: { anchor: 4 } }))

    fireEvent.keyDown(view.contentDOM, {
      key: 'ArrowDown',
      code: 'ArrowDown',
      keyCode: 40,
      metaKey: true,
      shiftKey: true
    })
    expect(view.state.selection.main).toMatchObject({ anchor: 4, head: TEXT.length })

    fireEvent.keyDown(view.contentDOM, { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38, metaKey: true, shiftKey: true })
    expect(view.state.selection.main).toMatchObject({ anchor: 4, head: 0 })
    expect(revealPane).not.toHaveBeenCalled()
  })

  it('leaves ⌃⌘↓ to go to the pane that is asking', async () => {
    const view = await editor()
    act(() => view.dispatch({ selection: { anchor: 4 } }))

    fireEvent.keyDown(view.contentDOM, {
      key: 'ArrowDown',
      code: 'ArrowDown',
      keyCode: 40,
      metaKey: true,
      ctrlKey: true
    })
    await waitFor(() => expect(revealPane).toHaveBeenCalledWith('w2', 't2'))
    expect(view.state.selection.main).toMatchObject({ anchor: 4, head: 4 })
  })
})
