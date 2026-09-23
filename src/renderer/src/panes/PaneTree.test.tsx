/** @vitest-environment jsdom */

// The split tree, as a person with a keyboard meets it.
//
// `paneLayout.test.ts` already proves the arithmetic of a drag. What only the
// rendered tree can settle is whether the arithmetic is aimed at the right
// pane: a nested split addresses its children by a path, and a path built one
// level short quietly resizes somebody else's panes. The same goes for the
// close button — in a tree of four panes there are four of them, and three are
// wrong.
//
// The other half is what a pane says about itself. A shell that died keeps its
// scrollback, so without the badge it is indistinguishable from one sitting at
// a prompt, and "indistinguishable from working" is the failure mode worth a
// test.
//
// `TerminalView` is replaced by a marker. It owns an xterm, a subscription and
// a resize observer, none of which this component decides anything about.

import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneNode, Terminal } from '@shared/entities'

vi.mock('../terminal/TerminalView', () => ({
  TerminalView: ({ terminalId, focused }: { terminalId: string; focused: boolean }) => (
    <div data-testid={`surface-${terminalId}`} data-focused={String(focused)} />
  )
}))

const { PaneTree } = await import('./PaneTree')
const { shownRoot } = await import('./paneLayout')

const terminal = (id: string, overrides: Partial<Terminal> = {}): Terminal => ({
  id,
  worktreeId: 'w1',
  title: id,
  cwd: '/repos/pager',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  running: true,
  busy: false,
  lastOutputAt: 0,
  ...overrides
})

const onFocus = vi.fn()
const onClose = vi.fn()
const onResize = vi.fn()

function mount(node: PaneNode, terminals: Terminal[], focusedTerminalId: string | null = null): void {
  render(
    <PaneTree
      node={node}
      path={[]}
      terminals={Object.fromEntries(terminals.map((entry) => [entry.id, entry]))}
      focusedTerminalId={focusedTerminalId}
      onFocus={onFocus}
      onClose={onClose}
      onResize={onResize}
      isAppChord={() => false}
      closeHint="⌘W"
      searchTerminalId={null}
      searchToken={0}
      onCloseSearch={() => {}}
    />
  )
}

/** jsdom has no layout, so the axis a drag divides has to be stated. */
function giveSplitsWidth(px = 1000): void {
  for (const split of document.querySelectorAll('.split')) {
    Object.defineProperty(split, 'clientWidth', { get: () => px })
    Object.defineProperty(split, 'clientHeight', { get: () => px })
  }
}

const leaf = (terminalId: string): PaneNode => ({ kind: 'leaf', terminalId })

const row = (...children: PaneNode[]): PaneNode => ({
  kind: 'split',
  direction: 'row',
  sizes: children.map(() => 1 / children.length),
  children
})

beforeEach(() => {
  onFocus.mockReset()
  onClose.mockReset()
  onResize.mockReset()
})

describe('one pane', () => {
  it('is a region named for the terminal in it', () => {
    mount(leaf('t1'), [terminal('t1', { title: 'claude' })])
    expect(screen.getByRole('region', { name: 'claude' })).toBeTruthy()
  })

  // A layout can name a terminal the store has not caught up with yet, and a
  // pane with no label at all reads as a rendering bug rather than a wait.
  it('still renders, named plainly, for a terminal the store has not got', () => {
    mount(leaf('t1'), [])
    expect(screen.getByRole('region', { name: 'terminal' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Close pane' })).toBeTruthy()
  })

  it('says nothing about exiting while the shell is alive', () => {
    mount(leaf('t1'), [terminal('t1')])
    expect(screen.queryByText(/exited/)).toBeNull()
  })

  // The pane keeps its scrollback after the shell dies, so without this it
  // looks exactly like one waiting at a prompt.
  it('says the shell exited, and with which code', () => {
    mount(leaf('t1'), [terminal('t1', { running: false, exitCode: 137 })])
    expect(screen.getByText('exited 137')).toBeTruthy()
  })

  it('says it exited even when nothing reported a code', () => {
    mount(leaf('t1'), [terminal('t1', { running: false })])
    expect(screen.getByText('exited')).toBeTruthy()
  })

  it('reports code 0 as a code, not as no code at all', () => {
    mount(leaf('t1'), [terminal('t1', { running: false, exitCode: 0 })])
    expect(screen.getByText('exited 0')).toBeTruthy()
  })

  it('shows the pane’s size, which is what a split changed', () => {
    mount(leaf('t1'), [terminal('t1', { cols: 132, rows: 43 })])
    expect(screen.getByText('132×43')).toBeTruthy()
  })

  it('distinguishes a resumed conversation from a pane that only came back', () => {
    mount(row(leaf('t1'), leaf('t2')), [terminal('t1', { restored: 'agent' }), terminal('t2', { restored: 'shell' })])
    expect(screen.getByText('resumed').getAttribute('title')).toContain('session resumed')
    expect(screen.getByText('new shell').getAttribute('title')).toContain('whatever it was running is gone')
  })

  it('says nothing about restoring for a pane opened now', () => {
    mount(leaf('t1'), [terminal('t1')])
    expect(screen.queryByText('resumed')).toBeNull()
    expect(screen.queryByText('new shell')).toBeNull()
  })

  it('marks only the focused pane as focused', () => {
    mount(row(leaf('t1'), leaf('t2')), [terminal('t1'), terminal('t2')], 't2')
    expect(screen.getByTestId('surface-t1').dataset.focused).toBe('false')
    expect(screen.getByTestId('surface-t2').dataset.focused).toBe('true')
  })
})

describe('closing the right pane', () => {
  it('names which pane each button closes, and carries the chord that does it', () => {
    mount(leaf('t1'), [terminal('t1', { title: 'claude' })])
    const button = screen.getByRole('button', { name: 'Close pane claude' })
    expect(button.getAttribute('title')).toBe('Close pane · ⌘W')
  })

  it('closes the pane it belongs to, out of four', () => {
    const tree = row(row(leaf('t1'), leaf('t2')), row(leaf('t3'), leaf('t4')))
    mount(
      tree,
      ['t1', 't2', 't3', 't4'].map((id) => terminal(id, { title: id }))
    )
    screen.getByRole('button', { name: 'Close pane t3' }).click()
    expect(onClose).toHaveBeenCalledExactlyOnceWith('t3')
  })
})

describe('the gutters between panes', () => {
  it('are separators that say which two panes they divide, and how far along they sit', () => {
    mount(row(leaf('t1'), leaf('t2'), leaf('t3')), [terminal('t1'), terminal('t2'), terminal('t3')])
    const separators = screen.getAllByRole('separator')
    expect(separators).toHaveLength(2)
    expect(separators[0]?.getAttribute('aria-label')).toBe('Resize panes 1 and 2')
    expect(separators[1]?.getAttribute('aria-label')).toBe('Resize panes 2 and 3')
    expect(separators[0]?.getAttribute('aria-valuenow')).toBe('33')
  })

  it('call a row’s gutter vertical and a column’s horizontal', () => {
    mount(
      {
        kind: 'split',
        direction: 'column',
        sizes: [0.5, 0.5],
        children: [leaf('t1'), row(leaf('t2'), leaf('t3'))]
      },
      [terminal('t1'), terminal('t2'), terminal('t3')]
    )
    const [outer, inner] = screen.getAllByRole('separator')
    expect(outer?.getAttribute('aria-orientation')).toBe('horizontal')
    expect(inner?.getAttribute('aria-orientation')).toBe('vertical')
  })

  it('are reachable by tab, so a split is adjustable without a pointer', () => {
    mount(row(leaf('t1'), leaf('t2')), [terminal('t1'), terminal('t2')])
    expect(screen.getByRole('separator').getAttribute('tabindex')).toBe('0')
  })

  it('move the boundary on the arrow keys that match their axis', () => {
    mount(row(leaf('t1'), leaf('t2')), [terminal('t1'), terminal('t2')])
    giveSplitsWidth()
    const separator = screen.getByRole('separator')
    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    expect(onResize).toHaveBeenCalledOnce()
    const [path, sizes] = onResize.mock.calls[0] as [number[], number[]]
    expect(path).toEqual([])
    expect(sizes[0] ?? 0).toBeGreaterThan(0.5)
    expect((sizes[0] ?? 0) + (sizes[1] ?? 0)).toBeCloseTo(1)
  })

  it('ignore the arrows that run along the gutter rather than across it', () => {
    mount(row(leaf('t1'), leaf('t2')), [terminal('t1'), terminal('t2')])
    giveSplitsWidth()
    expect(fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowUp' })).toBe(true)
    expect(onResize).not.toHaveBeenCalled()
  })

  // The path is what says whose sizes these are. Built one level short, a nudge
  // inside a nested split silently rearranges the outer one instead.
  it('address a nested split by its own path, not its parent’s', () => {
    mount(row(leaf('t1'), row(leaf('t2'), leaf('t3'))), [terminal('t1'), terminal('t2'), terminal('t3')])
    giveSplitsWidth()
    const separators = screen.getAllByRole('separator')
    fireEvent.keyDown(separators[1] as HTMLElement, { key: 'ArrowLeft' })
    const [path, sizes] = onResize.mock.calls[0] as [number[], number[]]
    expect(path).toEqual([1])
    expect(sizes).toHaveLength(2)
    expect(sizes[0] ?? 1).toBeLessThan(0.5)
  })

  it('do nothing at all before the split has been laid out', () => {
    mount(row(leaf('t1'), leaf('t2')), [terminal('t1'), terminal('t2')])
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowRight' })
    expect(onResize).not.toHaveBeenCalled()
  })
})

describe('a tree of panes', () => {
  it('renders every leaf once, whatever the nesting', () => {
    mount(row(leaf('t1'), row(leaf('t2'), row(leaf('t3'), leaf('t4')))), [
      terminal('t1'),
      terminal('t2'),
      terminal('t3'),
      terminal('t4')
    ])
    expect(screen.getAllByRole('region')).toHaveLength(4)
    for (const id of ['t1', 't2', 't3', 't4']) expect(screen.getByTestId(`surface-${id}`)).toBeTruthy()
  })

  it('keeps each pane’s own header with its own pane', () => {
    mount(row(leaf('t1'), leaf('t2')), [
      terminal('t1', { title: 'claude', running: false, exitCode: 1 }),
      terminal('t2', { title: 'zsh' })
    ])
    const dead = screen.getByRole('region', { name: 'claude' })
    const alive = screen.getByRole('region', { name: 'zsh' })
    expect(within(dead).getByText('exited 1')).toBeTruthy()
    expect(within(alive).queryByText(/exited/)).toBeNull()
  })
})

// Maximising, from the only angle that settles it: what is on screen. The store
// holds an id and `shownRoot` turns the tree into one leaf; whether that is
// really one pane, and really the same pane rather than a fresh one, is a
// question about the render.
describe('one pane filling the workspace', () => {
  const tree = row(leaf('t1'), leaf('t2'))
  const panes = [terminal('t1', { title: 'zsh' }), terminal('t2', { title: 'claude' })]

  it('draws the maximised pane and nothing beside it', () => {
    mount(shownRoot(tree, 't2')!, panes, 't2')
    expect(screen.getByRole('region', { name: 'claude' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'zsh' })).toBeNull()
    // No split around it either: a gutter with nothing on the far side of it is
    // a handle that drags nothing.
    expect(document.querySelectorAll('.split')).toHaveLength(0)
  })

  it('draws the whole tree again once nothing is maximised', () => {
    mount(shownRoot(tree, null)!, panes, 't2')
    expect(screen.getByRole('region', { name: 'claude' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'zsh' })).toBeTruthy()
  })
})
