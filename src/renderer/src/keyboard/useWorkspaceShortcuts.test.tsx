/** @vitest-environment jsdom */

// Which pane a chord acts on.
//
// The window's key handler is the one place where "the focused pane" has to
// mean both kinds of pane at once: your own, whose focus is a field in a layout
// the runtime keeps, and a teammate's, whose focus is a field in this window
// because the runtime has never heard of it. Close is the chord where getting
// that wrong is worst — the two closes are `terminal.close` on this machine and
// dropping a subscription to somebody else's — so it is the one asserted here.

import { fireEvent, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConsentRequest, Layout } from '@shared/entities'

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: () => new Promise(() => {}),
    watchPane: () => new Promise(() => {}),
    subscribeTerminal: () => new Promise(() => {}),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { resolvePlatformModifier } = await import('./platformModifier')
const { useWorkspaceShortcuts } = await import('./useWorkspaceShortcuts')

const INITIAL = useWorkspaceStore.getState()
const MAC = resolvePlatformModifier('darwin')

const closeTerminal = vi.fn()
const closeWatchedPane = vi.fn()
const openDialog = vi.fn()

function Harness(): null {
  useWorkspaceShortcuts(MAC)
  return null
}

function seed(overrides: Record<string, unknown>): void {
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      closeTerminal,
      closeWatchedPane,
      openDialog,
      activeWorktreeId: 'w1',
      layouts: { w1: { worktreeId: 'w1', root: { kind: 'leaf', terminalId: 't1' }, focusedTerminalId: 't1' } },
      ...overrides
    },
    true
  )
  render(<Harness />)
}

/** The last `isAppChord` a harness was handed: what the terminals ask before keeping a key. */
let isAppChord: ((event: KeyboardEvent) => boolean) | null = null

function ChordHarness(): null {
  isAppChord = useWorkspaceShortcuts(MAC)
  return null
}

/** The close chord, on macOS, where the whole app runs. */
const pressClose = (): void => {
  fireEvent.keyDown(window, { key: 'w', metaKey: true })
}

beforeEach(() => {
  closeTerminal.mockReset()
  closeWatchedPane.mockReset()
  openDialog.mockReset()
})

/** One waiting question, as `teamwork.requests` hands it over. */
function question(): Record<string, { projectId: string; requests: ConsentRequest[] }> {
  return {
    p1: {
      projectId: 'p1',
      requests: [
        {
          id: 'ask_1',
          projectId: 'p1',
          terminalId: 't1',
          handle: 'priya',
          publicKey: 'Lx9TqvJ2mR0aUf7cHbN4sKwEdY1gZp6VtQiOnA3XjBM=',
          since: 1_000,
          at: 1_500,
          expiresAt: 2_000,
          writes: 4,
          bytes: 4,
          preview: 'npm test',
          clipped: false
        }
      ]
    }
  }
}

describe('the close chord', () => {
  it('closes the pane of your own that has the focus', () => {
    seed({})
    pressClose()
    expect(closeTerminal).toHaveBeenCalledExactlyOnceWith('t1')
    expect(closeWatchedPane).not.toHaveBeenCalled()
  })

  // Closing a teammate's pane is the whole of stopping the watch: the pane is
  // the subscription, and nothing flows once it is gone.
  it('stops the watch when the focused pane is a teammate’s, and leaves yours alone', () => {
    seed({ focusedWatchId: 'watch:p1:priya:t7' })
    pressClose()
    expect(closeWatchedPane).toHaveBeenCalledExactlyOnceWith('watch:p1:priya:t7')
    expect(closeTerminal).not.toHaveBeenCalled()
  })
})

// A question about a teammate's keystrokes is a modal this window did not open,
// and the one modal here that refuses Escape. `dialog` was the only thing the
// key handler knew could be up, so every chord went on firing underneath it —
// on a window the person cannot see and, because that prompt will not dismiss,
// cannot get back to. Cmd-, opened the colour editor under the scrim and took
// the focus with it; Cmd-W stopped a watch the owner was in the middle of being
// asked about.
/** A terminal, a markdown file and a terminal, with the first maximized. */
const STRIP: Layout = {
  worktreeId: 'w1',
  root: {
    kind: 'split',
    direction: 'row',
    sizes: [0.4, 0.3, 0.3],
    children: [
      { kind: 'leaf', terminalId: 't1' },
      { kind: 'leaf', terminalId: 'file:n', pane: 'file', path: 'NOTES.md' },
      { kind: 'leaf', terminalId: 't3' }
    ]
  },
  focusedTerminalId: 't1'
}

describe('the tab chords', () => {
  const focused = (): string | null | undefined => useWorkspaceStore.getState().layouts.w1?.focusedTerminalId

  beforeEach(() => {
    useWorkspaceStore.setState(
      { ...INITIAL, activeWorktreeId: 'w1', layouts: { w1: STRIP }, expandedTerminalId: 't1' },
      true
    )
    render(<ChordHarness />)
  })

  it('shows the Nth tab on ⌘N and the last on ⌘9, out of a maximized pane', () => {
    const press = new KeyboardEvent('keydown', { key: '2', metaKey: true, bubbles: true, cancelable: true })
    window.dispatchEvent(press)
    expect(press.defaultPrevented).toBe(true)
    expect(focused()).toBe('file:n')
    expect(useWorkspaceStore.getState().expandedTerminalId).toBeNull()

    fireEvent.keyDown(window, { key: '9', metaKey: true })
    expect(focused()).toBe('t3')
  })

  it('leaves a number with no tab alone', () => {
    const press = new KeyboardEvent('keydown', { key: '5', metaKey: true, bubbles: true, cancelable: true })
    window.dispatchEvent(press)
    expect(press.defaultPrevented).toBe(false)
    expect(focused()).toBe('t1')
  })

  it('walks the strip on ⌃Tab and back on ⌃⇧Tab', () => {
    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true })
    expect(focused()).toBe('file:n')
    expect(useWorkspaceStore.getState().expandedTerminalId).toBeNull()
    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true, shiftKey: true })
    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true, shiftKey: true })
    expect(focused()).toBe('t3')
  })

  // What keeps the chords from the pty: the terminal's key handler refuses an app chord.
  it('counts both as app chords, so a terminal never types them', () => {
    const chord = (init: KeyboardEventInit): boolean => isAppChord?.(new KeyboardEvent('keydown', init)) ?? false
    expect(chord({ key: '1', metaKey: true })).toBe(true)
    expect(chord({ key: '9', metaKey: true })).toBe(true)
    expect(chord({ key: 'Tab', ctrlKey: true })).toBe(true)
    expect(chord({ key: 'Tab', ctrlKey: true, shiftKey: true })).toBe(true)
    expect(chord({ key: 'Tab' })).toBe(false)
    expect(chord({ key: '1', ctrlKey: true })).toBe(false)
  })
})

describe('a question waiting on the owner', () => {
  it('takes the keyboard, exactly as a dialog of this window\u2019s own does', () => {
    seed({ consent: question() })
    pressClose()
    fireEvent.keyDown(window, { key: ',', metaKey: true })
    expect(closeTerminal).not.toHaveBeenCalled()
    expect(closeWatchedPane).not.toHaveBeenCalled()
    expect(openDialog).not.toHaveBeenCalled()
  })

  it('gives it back once the question has been answered', () => {
    seed({ consent: { p1: { projectId: 'p1', requests: [] } } })
    pressClose()
    expect(closeTerminal).toHaveBeenCalledExactlyOnceWith('t1')
  })
})

describe('Escape out of a zoomed pane', () => {
  const zoomed = (): void =>
    seed({
      expandedTerminalId: 't1',
      layouts: {
        w1: {
          worktreeId: 'w1',
          root: {
            kind: 'split',
            direction: 'row',
            sizes: [0.5, 0.5],
            children: [
              { kind: 'leaf', terminalId: 't1' },
              { kind: 'leaf', terminalId: 't2' }
            ]
          },
          focusedTerminalId: 't1'
        }
      }
    })

  function press(target: HTMLElement): boolean {
    if (!target.isConnected) document.body.append(target)
    return fireEvent.keyDown(target, { key: 'Escape' })
  }

  it('gives the layout back from the strip, a pane or a list: anything that is not typed in', () => {
    zoomed()
    const tab = document.createElement('button')
    expect(press(tab)).toBe(false)
    expect(useWorkspaceStore.getState().expandedTerminalId).toBeNull()
    tab.remove()
  })

  it('leaves Escape to a terminal, an editor or a field', () => {
    zoomed()
    const terminal = document.createElement('div')
    terminal.className = 'xterm'
    const textarea = document.createElement('textarea')
    terminal.append(textarea)
    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    const field = document.createElement('input')
    document.body.append(terminal)
    for (const target of [textarea, editor, field]) {
      press(target)
      expect(useWorkspaceStore.getState().expandedTerminalId).toBe('t1')
    }
    for (const target of [terminal, editor, field]) target.remove()
  })

  it('leaves Escape alone when something else took it first, or nothing is zoomed', () => {
    zoomed()
    const menu = document.createElement('div')
    menu.addEventListener('keydown', (event) => event.preventDefault())
    press(menu)
    expect(useWorkspaceStore.getState().expandedTerminalId).toBe('t1')
    menu.remove()

    useWorkspaceStore.setState({ expandedTerminalId: null })
    const plain = document.createElement('button')
    expect(press(plain)).toBe(true)
    plain.remove()
  })
})
