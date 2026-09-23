/** @vitest-environment jsdom */

// The window's end of the menu bar, and the thing this whole change had to not
// break: one keypress doing one thing.
//
// There are two ways to reach a command now. A chord, which on macOS is
// consumed by the menu item that carries it and everywhere else is handled
// here; and a menu item, whose choice comes back over IPC. If both ever ran for
// one press, ⌘D would split two panes. The arrangement that prevents it is that
// the window never turns a key into a menu choice and never turns a menu choice
// into a key — the two arrive separately and both end at `runWorkspaceCommand`
// — and that is what is asserted below: each path, exercised on its own, moves
// the store exactly once.
//
// The other half is the publishing. `Menu.setApplicationMenu` replaces the bar
// and, on macOS, shuts a menu the user has open, so it must happen when the
// menu has something different to say and at no other time. A pane's output
// arrives many times a second and changes none of the twelve answers.

import { render } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
const { resolvePlatformModifier } = await import('../keyboard/platformModifier')
const { useWorkspaceShortcuts } = await import('../keyboard/useWorkspaceShortcuts')
const { useMenuBar } = await import('./useMenuBar')

type Published = { command: string; label: string; accelerator: string; section: string; enabled: boolean }

const INITIAL = useWorkspaceStore.getState()
const MAC = resolvePlatformModifier('darwin')

const closeTerminal = vi.fn()
const createTerminal = vi.fn()
const publish = vi.fn<(items: readonly Published[]) => void>()

/** Whatever the main process would call when an item is chosen. */
let choose: ((command: string) => void) | null = null
let listening = 0

/** Both halves of the window's keyboard: the chords and the menu bar. */
function Harness(): null {
  useWorkspaceShortcuts(MAC)
  useMenuBar()
  return null
}

function seed(overrides: Record<string, unknown> = {}): void {
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      closeTerminal,
      createTerminal,
      projects: [{ id: 'p1', name: 'p1', path: '/p1', baseRef: 'origin/main' }],
      activeWorktreeId: 'w1',
      layouts: { w1: { worktreeId: 'w1', root: { kind: 'leaf', terminalId: 't1' }, focusedTerminalId: 't1' } },
      ...overrides
    },
    true
  )
}

/** The items of the most recent publish. */
function latest(): Published[] {
  const call = publish.mock.calls.at(-1)
  return call ? [...call[0]] : []
}

beforeEach(() => {
  closeTerminal.mockReset()
  createTerminal.mockReset()
  publish.mockReset()
  choose = null
  listening = 0
  ;(window as unknown as { teamree: unknown }).teamree = {
    menu: {
      publish,
      onCommand: (listener: (command: string) => void) => {
        choose = listener
        listening += 1
        return () => {
          choose = null
          listening -= 1
        }
      }
    }
  }
})

afterEach(() => {
  delete (window as unknown as { teamree?: unknown }).teamree
})

describe('one keypress, one thing', () => {
  // The chord, which is what happens on Windows and Linux, and on macOS
  // whenever the item is disabled and AppKit lets the key through to the page.
  it('closes exactly one pane when the chord is pressed', () => {
    seed()
    render(<Harness />)
    fireEvent.keyDown(window, { key: 'w', metaKey: true })

    expect(closeTerminal).toHaveBeenCalledExactlyOnceWith('t1')
    expect(createTerminal).not.toHaveBeenCalled()
  })

  // And the menu item, which is what happens on macOS for every chord the menu
  // has taken — and for a mouse anywhere.
  it('closes exactly one pane when the menu says the item was chosen', () => {
    seed()
    render(<Harness />)
    choose?.('close-pane')

    expect(closeTerminal).toHaveBeenCalledExactlyOnceWith('t1')
  })

  // Neither path feeds the other. A key that reached the page does not become a
  // publish that becomes a choice, and a choice does not become a keystroke.
  it('does not turn one into the other', () => {
    seed()
    render(<Harness />)
    const publishesBefore = publish.mock.calls.length

    fireEvent.keyDown(window, { key: 't', metaKey: true })
    expect(createTerminal).toHaveBeenCalledTimes(1)
    // The store did not change — no pane really opened, the action is a stub —
    // so nothing was republished, and there was no second dispatch to publish.
    expect(publish.mock.calls.length).toBe(publishesBefore)
  })

  // What arrives on that channel is a string this window published a moment
  // ago. It is checked against the table anyway.
  it('ignores a command it does not have', () => {
    seed()
    render(<Harness />)
    choose?.('eject-the-warp-core')
    expect(closeTerminal).not.toHaveBeenCalled()
  })

  // A menu is drawn from a snapshot and chosen afterwards. Between the two the
  // pane can exit, and the click then means nothing.
  it('does nothing when the item was live but the window has since moved on', () => {
    seed()
    render(<Harness />)
    expect(latest().find((item) => item.command === 'close-pane')?.enabled).toBe(true)

    useWorkspaceStore.setState({ layouts: {}, activeWorktreeId: null })
    choose?.('close-pane')
    expect(closeTerminal).not.toHaveBeenCalled()
  })
})

describe('what the window tells the main process', () => {
  it('describes its menus as soon as it is up', () => {
    seed()
    render(<Harness />)

    expect(publish).toHaveBeenCalledTimes(1)
    expect(latest().map((item) => item.command)).toContain('close-pane')
    expect(latest().find((item) => item.command === 'new-terminal')?.accelerator).toBe('CommandOrControl+T')
  })

  it('says again when an answer has changed', () => {
    seed({ layouts: {}, activeWorktreeId: null })
    render(<Harness />)
    expect(latest().find((item) => item.command === 'close-pane')?.enabled).toBe(false)

    useWorkspaceStore.setState({
      activeWorktreeId: 'w1',
      layouts: { w1: { worktreeId: 'w1', root: { kind: 'leaf', terminalId: 't1' }, focusedTerminalId: 't1' } }
    })

    expect(publish).toHaveBeenCalledTimes(2)
    expect(latest().find((item) => item.command === 'close-pane')?.enabled).toBe(true)
  })

  // The store changes many times a second while a pane is printing, and none of
  // those change a single one of the twelve answers. Every one that reached the
  // main process would replace the application menu — and close a menu somebody
  // had open to read.
  it('says nothing again when the change was not about the menu', () => {
    seed()
    render(<Harness />)
    expect(publish).toHaveBeenCalledTimes(1)

    useWorkspaceStore.setState({ notices: [{ id: 1, text: 'anything', tone: 'info' }] })
    useWorkspaceStore.setState({ sidebarWidth: 321 })
    useWorkspaceStore.setState({ dashboardOpen: true })

    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('stops listening and stops publishing when the window goes', () => {
    seed()
    const view = render(<Harness />)
    expect(listening).toBe(1)

    view.unmount()
    expect(listening).toBe(0)

    useWorkspaceStore.setState({ layouts: {}, activeWorktreeId: null })
    expect(publish).toHaveBeenCalledTimes(1)
  })
})
