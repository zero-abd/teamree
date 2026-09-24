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
import { resolvePlatformModifier } from '../keyboard/platformModifier'

vi.mock('../terminal/TerminalView', () => ({
  TerminalView: ({ terminalId, focused }: { terminalId: string; focused: boolean }) => (
    <div data-testid={`surface-${terminalId}`} data-focused={String(focused)} />
  )
}))

// And the page, which owns an editor and a file: the tree's job is to put it
// in the leaf and hand it the path.
vi.mock('../markdown/MarkdownPane', () => ({
  MarkdownPane: ({ paneId, path, focused }: { paneId: string; path: string; focused: boolean }) => (
    <div data-testid={`page-${paneId}`} data-path={path} data-focused={String(focused)} />
  )
}))

vi.mock('../files/FileView', () => ({
  FileView: ({ paneId, path }: { paneId: string; path: string }) => (
    <div data-testid={`viewer-${paneId}`} data-path={path} />
  )
}))

const { PaneTree } = await import('./PaneTree')
const { shownRoot } = await import('./paneLayout')
const useStore = await import('../state/workspaceStore')

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
const onRelaunch = vi.fn()
const onResize = vi.fn()

function mount(node: PaneNode, terminals: Terminal[], focusedTerminalId: string | null = null): void {
  render(
    <PaneTree
      node={node}
      path={[]}
      worktreeId="w1"
      terminals={Object.fromEntries(terminals.map((entry) => [entry.id, entry]))}
      focusedTerminalId={focusedTerminalId}
      onFocus={onFocus}
      onClose={onClose}
      onRelaunch={onRelaunch}
      onResize={onResize}
      isAppChord={() => false}
      modifier={resolvePlatformModifier('darwin')}
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
  onRelaunch.mockReset()
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
    mount(row(leaf('t1'), leaf('t2')), [terminal('t2')])
    expect(screen.getByRole('region', { name: 'terminal' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Close pane terminal' })).toBeTruthy()
  })

  // The tab above it already says its name and draws its dot.
  it('draws no bar, no name and no dot of its own when it is the only pane', () => {
    mount(leaf('t1'), [terminal('t1', { title: 'claude', busy: true })])
    expect(screen.getByRole('region', { name: 'claude' })).toBeTruthy()
    expect(document.querySelector('.pane__bar')).toBeNull()
    expect(document.querySelector('.activity')).toBeNull()
    expect(screen.queryByText('claude')).toBeNull()
    expect(screen.queryByRole('button', { name: /Close pane/ })).toBeNull()
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

  // The grid size is a fact about the PTY, not about the work, and it was the
  // one thing on every bar that nobody acted on. It stays reachable — on the
  // name's hover — for whoever is checking that a split did what they meant.
  it('keeps the pane’s size off the bar and on the name’s hover', () => {
    mount(row(leaf('t1'), leaf('t2')), [terminal('t1', { cols: 132, rows: 43 }), terminal('t2')])
    expect(screen.queryByText('132×43')).toBeNull()
    expect(screen.getByText('t1').getAttribute('title')).toBe('t1 · 132×43')
  })

  // The dot lives on the tab only; a bar under it drawing it again was every dot twice.
  it('names each of two panes on a bar of its own, with no dot', () => {
    mount(row(leaf('t1'), leaf('t2')), [terminal('t1', { busy: true }), terminal('t2')])
    expect(document.querySelectorAll('.pane__bar')).toHaveLength(2)
    expect(document.querySelectorAll('.activity')).toHaveLength(0)
    expect(screen.getByText('t1').className).toBe('pane__title')
  })

  it('says a lone pane exited, and offers to run it again, without naming it', () => {
    mount(leaf('t1'), [terminal('t1', { title: 'claude', agent: 'claude', running: false, exitCode: 1 })])
    expect(document.querySelector('.pane__bar')).toBeNull()
    expect(screen.getByText('exited 1')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Run claude again' })).toBeTruthy()
    expect(document.querySelector('.pane__title')).toBeNull()
  })

  // The scrollback under the badge says "[no conversation to resume — fresh
  // claude below]", and a badge two lines above it reading "new shell" was the
  // window disagreeing with itself about what is running in the pane.
  it('says an agent started over is a fresh agent, in the words the banner uses', () => {
    mount(leaf('t1'), [terminal('t1', { agent: 'claude', restored: 'restarted' })])
    expect(screen.getByText('fresh claude').getAttribute('title')).toContain('fresh claude')
    expect(screen.queryByText('new shell')).toBeNull()
  })

  it('distinguishes a resumed conversation from a pane that only came back', () => {
    mount(row(leaf('t1'), leaf('t2')), [terminal('t1', { restored: 'agent' }), terminal('t2', { restored: 'shell' })])
    expect(screen.getByText('resumed').getAttribute('title')).toContain('session resumed')
    expect(screen.getByText('new shell').getAttribute('title')).toContain('previous process gone')
  })

  it('says nothing about restoring for a pane opened now', () => {
    mount(leaf('t1'), [terminal('t1')])
    expect(screen.queryByText('resumed')).toBeNull()
    expect(screen.queryByText('new shell')).toBeNull()
  })

  // The pane that died is the one somebody is standing in front of wondering
  // what to do, and there is only ever one answer: run it again.
  it('offers to run the agent again, by name, once the pane has exited', () => {
    mount(leaf('t1'), [terminal('t1', { running: false, exitCode: 1, agent: 'claude' })])
    screen.getByRole('button', { name: 'Run claude again' }).click()
    expect(onRelaunch).toHaveBeenCalledExactlyOnceWith('t1')
  })

  it('offers a shell for an exited pane that was not running an agent', () => {
    mount(leaf('t1'), [terminal('t1', { running: false, exitCode: 0 })])
    expect(screen.getByRole('button', { name: 'New shell' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /again/ })).toBeNull()
  })

  it('offers it to the pane that died and not to the live one beside it', () => {
    mount(row(leaf('t1'), leaf('t2')), [
      terminal('t1', { running: false, agent: 'claude' }),
      terminal('t2', { agent: 'claude' })
    ])
    expect(screen.getAllByRole('button', { name: 'Run claude again' })).toHaveLength(1)
    // Two claude panes nobody named: called `claude 1` and `claude 2`, as the strip does.
    const alive = screen.getByRole('region', { name: 'Claude Code 2' })
    expect(within(alive).queryByRole('button', { name: /again|New shell/ })).toBeNull()
  })

  it('offers each dead pane its own, out of two', () => {
    mount(row(leaf('t1'), leaf('t2')), [
      terminal('t1', { running: false, agent: 'claude' }),
      terminal('t2', { running: false, agent: 'codex' })
    ])
    screen.getByRole('button', { name: 'Run codex again' }).click()
    expect(onRelaunch).toHaveBeenCalledExactlyOnceWith('t2')
  })

  it('marks only the focused pane as focused', () => {
    mount(row(leaf('t1'), leaf('t2')), [terminal('t1'), terminal('t2')], 't2')
    expect(screen.getByTestId('surface-t1').dataset.focused).toBe('false')
    expect(screen.getByTestId('surface-t2').dataset.focused).toBe('true')
  })
})

describe('what a pane is called', () => {
  // One pane, one name. The tab strip says the label somebody gave the pane;
  // the pane bar and its close button said the program's title; and a rename
  // reached the tab and nothing else.
  it('reads the same name as the tab strip: the label, else the title', () => {
    mount(row(leaf('t1'), leaf('t2')), [
      terminal('t1', { agent: 'codex', title: 'codex', label: 'Race two agents codex' }),
      terminal('t2', { title: 'zsh' })
    ])
    expect(screen.getByRole('button', { name: 'Close pane Race two agents codex' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Race two agents codex' })).toBeTruthy()
    expect(screen.getByText('Race two agents codex').className).toBe('pane__title')
    expect(screen.getByRole('button', { name: 'Close pane zsh' })).toBeTruthy()
  })

  // Two panes of the same agent are told apart along the top as `Claude Code 1`
  // and `Claude Code 2`; the bar under each tab says the same thing.
  it('numbers unnamed twins the way the strip does', () => {
    mount(row(leaf('t1'), leaf('t2')), [
      terminal('t1', { agent: 'claude', title: 'node' }),
      terminal('t2', { agent: 'claude', title: 'node' })
    ])
    expect(screen.getByRole('button', { name: 'Close pane Claude Code 1' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Close pane Claude Code 2' })).toBeTruthy()
  })
})

describe('closing the right pane', () => {
  // The chord is taught in the menu bar, in Help, in the palette and on the
  // front door; the hover on a close button is not a fifth place.
  it('names which pane each button closes, and no chord', () => {
    mount(row(leaf('t1'), leaf('t2')), [terminal('t1', { title: 'claude' }), terminal('t2')])
    const button = screen.getByRole('button', { name: 'Close pane claude' })
    expect(button.getAttribute('title')).toBe('Close pane')
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

describe('a file leaf', () => {
  it('is drawn as the page for its file, beside the terminals, and focused when the layout says so', () => {
    const root: PaneNode = {
      kind: 'split',
      direction: 'row',
      sizes: [0.5, 0.5],
      children: [
        { kind: 'leaf', terminalId: 't1' },
        { kind: 'leaf', terminalId: 'file:1', pane: 'file', path: 'docs/NOTES.md' }
      ]
    }
    mount(root, [terminal('t1')], 'file:1')
    expect(screen.getByTestId('surface-t1').dataset.focused).toBe('false')
    const page = screen.getByTestId('page-file:1')
    expect(page.dataset.path).toBe('docs/NOTES.md')
    expect(page.dataset.focused).toBe('true')
  })

  it('draws any other file with the file viewer', () => {
    const root: PaneNode = {
      kind: 'split',
      direction: 'row',
      sizes: [0.5, 0.5],
      children: [
        { kind: 'leaf', terminalId: 'file:1', pane: 'file', path: 'docs/NOTES.md' },
        { kind: 'leaf', terminalId: 'file:2', pane: 'file', path: 'src/app.ts' }
      ]
    }
    mount(root, [], 'file:2')
    expect(screen.getByTestId('page-file:1').dataset.path).toBe('docs/NOTES.md')
    expect(screen.getByTestId('viewer-file:2').dataset.path).toBe('src/app.ts')
  })
})

describe('the file column', () => {
  const file = (id: string, path: string): PaneNode => ({ kind: 'leaf', terminalId: id, pane: 'file', path })
  const column: PaneNode = {
    kind: 'split',
    direction: 'column',
    sizes: [0.5, 0.5],
    children: [file('file:1', 'docs/NOTES.md'), file('file:2', 'src/app.ts')],
    tabs: true,
    shown: 'file:2',
    preview: 'file:2'
  }

  it('draws its files as tabs, only the shown one open, the preview set apart', () => {
    mount(row(leaf('t1'), column), [terminal('t1')], 't1')
    const tabs = within(screen.getByRole('tablist', { name: 'Open files' })).getAllByRole('tab')
    expect(tabs.map((tab) => [tab.textContent, tab.getAttribute('aria-selected')])).toEqual([
      ['NOTES.md', 'false'],
      ['app.ts', 'true']
    ])
    expect(tabs[1]!.className).toContain('column__name--preview')
    expect(screen.getByTestId('page-file:1').closest('[hidden]')).not.toBeNull()
    expect(screen.getByTestId('viewer-file:2').closest('[hidden]')).toBeNull()
    expect(document.querySelectorAll('.gutter')).toHaveLength(1)
  })

  it('focuses a tab on a click and closes it from its ×', () => {
    mount(row(leaf('t1'), column), [terminal('t1')], 't1')
    fireEvent.click(screen.getByRole('tab', { name: 'NOTES.md' }))
    expect(onFocus).toHaveBeenCalledWith('file:1')
    fireEvent.click(screen.getByRole('button', { name: 'Close NOTES.md' }))
    expect(onClose).toHaveBeenCalledWith('file:1')
  })

  it('gives the layout back on Escape in a zoomed diff, and keeps Escape for an editor', () => {
    const { useWorkspaceStore } = useStore
    useWorkspaceStore.setState({ expandedTerminalId: 'file:2', diffPanes: { 'file:2': true } })
    mount(shownRoot(row(leaf('t1'), column), 'file:2')!, [terminal('t1')], 'file:2')
    expect(screen.queryByTestId('surface-t1')).toBeNull()
    fireEvent.keyDown(screen.getByTestId('viewer-file:2'), { key: 'Escape' })
    expect(useWorkspaceStore.getState().expandedTerminalId).toBeNull()

    useWorkspaceStore.setState({ expandedTerminalId: 'file:2', diffPanes: {} })
    fireEvent.keyDown(screen.getByTestId('viewer-file:2'), { key: 'Escape' })
    expect(useWorkspaceStore.getState().expandedTerminalId).toBe('file:2')
    useWorkspaceStore.setState({ expandedTerminalId: null })
  })
})
