/** @vitest-environment jsdom */

// A file tab is a leaf of the tree: opened beside the focused pane, closed by
// rewriting the tree, and held open by a question while it has unsaved edits.
// The viewer under it reads, edits and saves through the runtime.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileContent, FileView as FileViewAnswer, Layout, PaneNode, Worktree } from '@shared/entities'
import { fileColumnIn, fileLeaf, fileLeavesIn } from '@shared/filePane'
import { resolvePlatformModifier } from '../keyboard/platformModifier'

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

vi.mock('../terminal/TerminalView', () => ({ TerminalView: () => <div /> }))

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { FileView } = await import('./FileView')
const { paneTabs } = await import('../workspace/paneTabs')
const { PaneTree } = await import('../panes/PaneTree')
const { TerminalTabs } = await import('../workspace/TerminalTabs')

const INITIAL = useWorkspaceStore.getState()

const terminalOnly: Layout = { worktreeId: 'w1', root: { kind: 'leaf', terminalId: 't1' }, focusedTerminalId: 't1' }

const text = (body: string, modifiedAt = 100): FileContent => ({
  worktreeId: 'w1',
  path: 'src/app.ts',
  content: body,
  exists: true,
  size: body.length,
  modifiedAt,
  encoding: 'utf-8',
  lineEnding: '\n'
})

// jsdom has no layout; CodeMirror measures text ranges.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList
Range.prototype.getBoundingClientRect = () => new DOMRect()

beforeEach(() => {
  call.mockReset()
  call.mockImplementation(async (method: string, params: { root?: unknown }) => {
    if (method === 'layout.set') return params
    return undefined
  })
  useWorkspaceStore.setState(
    { ...INITIAL, activeWorktreeId: 'w1', layouts: { w1: terminalOnly }, unsavedFiles: {}, editedFiles: {} },
    true
  )
})

const layout = (): Layout => useWorkspaceStore.getState().layouts.w1!

describe('file tabs in the store', () => {
  it('opens beside the focused pane, focuses it, and reuses the tab for the same path', () => {
    useWorkspaceStore.getState().openFilePane('w1', 'src/app.ts')
    const [leaf] = fileLeavesIn(layout().root)
    expect(leaf?.path).toBe('src/app.ts')
    expect(layout().focusedTerminalId).toBe(leaf?.terminalId)
    expect(paneTabs(layout().root, {}).map((tab) => [tab.label, tab.kind])).toEqual([
      ['terminal', undefined],
      ['app.ts', 'file']
    ])

    useWorkspaceStore.getState().focusPane('t1')
    useWorkspaceStore.getState().openFilePane('w1', 'src/app.ts')
    expect(fileLeavesIn(layout().root)).toHaveLength(1)
    expect(layout().focusedTerminalId).toBe(leaf?.terminalId)
    expect(call.mock.calls.filter(([method]) => method === 'terminal.create')).toHaveLength(0)
  })

  it('opens further files as tabs of one column, leaving the terminal its width', () => {
    useWorkspaceStore.getState().openFilePane('w1', 'a.ts')
    const sizes = (layout().root as Extract<PaneNode, { kind: 'split' }>).sizes
    useWorkspaceStore.getState().focusPane('t1')
    useWorkspaceStore.getState().openFilePane('w1', 'b.png')
    useWorkspaceStore.getState().openFilePane('w1', 'c.ts')
    const root = layout().root
    expect(root).toMatchObject({ kind: 'split', direction: 'row', sizes })
    expect(root?.kind === 'split' && root.children[0]).toEqual({ kind: 'leaf', terminalId: 't1' })
    const column = fileColumnIn(root)
    expect(fileLeavesIn(column).map((leaf) => leaf.path)).toEqual(['a.ts', 'b.png', 'c.ts'])
    const c = fileLeavesIn(column).at(-1)!.terminalId
    expect(column?.shown).toBe(c)
    expect(layout().focusedTerminalId).toBe(c)
  })

  it('shows a tab when it takes the focus', () => {
    useWorkspaceStore.getState().openFilePane('w1', 'a.ts')
    useWorkspaceStore.getState().openFilePane('w1', 'b.ts')
    const a = fileLeavesIn(layout().root)[0]!.terminalId
    useWorkspaceStore.getState().focusPane(a)
    expect(fileColumnIn(layout().root)?.shown).toBe(a)
  })

  it('replaces the preview tab with the next preview, until it is opened for good or edited', () => {
    const open = (path: string, mode?: 'preview'): void => useWorkspaceStore.getState().openFilePane('w1', path, mode)
    const paths = (): string[] => fileLeavesIn(layout().root).map((leaf) => leaf.path)
    open('a.ts', 'preview')
    open('b.ts', 'preview')
    expect(paths()).toEqual(['b.ts'])
    expect(fileColumnIn(layout().root)?.preview).toBe(fileLeavesIn(layout().root)[0]!.terminalId)

    open('b.ts')
    expect(fileColumnIn(layout().root)?.preview).toBeUndefined()
    open('c.ts', 'preview')
    expect(paths()).toEqual(['b.ts', 'c.ts'])

    const c = fileLeavesIn(layout().root)[1]!.terminalId
    useWorkspaceStore.getState().setFileUnsaved(c, true)
    expect(fileColumnIn(layout().root)?.preview).toBeUndefined()
    open('d.ts', 'preview')
    expect(paths()).toEqual(['b.ts', 'c.ts', 'd.ts'])

    const d = fileLeavesIn(layout().root)[2]!.terminalId
    useWorkspaceStore.getState().pinFilePane(d)
    open('e.ts', 'preview')
    expect(paths()).toEqual(['b.ts', 'c.ts', 'd.ts', 'e.ts'])
  })

  it('still splits beside the focused pane when asked, rather than adding a tab', () => {
    useWorkspaceStore.getState().openFilePane('w1', 'a.ts')
    useWorkspaceStore.getState().openFilePane('w1', 'b.ts', 'split')
    const root = layout().root
    expect(fileColumnIn(root)?.children).toHaveLength(1)
    expect(root).toMatchObject({ kind: 'split', direction: 'row' })
    if (root?.kind !== 'split') return
    expect(root.children[1]).toBe(fileColumnIn(root))
    expect(root.children[2]).toMatchObject({ kind: 'leaf', pane: 'file', path: 'b.ts' })
  })

  it('shows the next tab when the shown one closes, and makes the column again at its old width', async () => {
    useWorkspaceStore.getState().openFilePane('w1', 'a.ts')
    const sizes = (layout().root as Extract<PaneNode, { kind: 'split' }>).sizes
    useWorkspaceStore.getState().openFilePane('w1', 'b.ts')
    const [a, b] = fileLeavesIn(layout().root).map((leaf) => leaf.terminalId)
    await useWorkspaceStore.getState().closeTerminal(b!)
    expect(fileColumnIn(layout().root)?.shown).toBe(a)
    expect(layout().focusedTerminalId).toBe(a)
    await useWorkspaceStore.getState().closeTerminal(a!)
    expect(layout().root).toEqual({ kind: 'leaf', terminalId: 't1' })
    useWorkspaceStore.getState().openFilePane('w1', 'a.ts')
    expect((layout().root as Extract<PaneNode, { kind: 'split' }>).sizes).toEqual(sizes)
  })

  it('closes a clean tab by rewriting the tree, never by ending a terminal', async () => {
    useWorkspaceStore.getState().openFilePane('w1', 'a.png')
    const id = fileLeavesIn(layout().root)[0]!.terminalId
    await useWorkspaceStore.getState().closeTerminal(id)
    expect(fileLeavesIn(layout().root)).toEqual([])
    expect(layout().focusedTerminalId).toBe('t1')
    expect(call).not.toHaveBeenCalledWith('terminal.close', expect.anything())
  })

  it('asks before closing a tab with unsaved edits, and forgets the dot once closed', async () => {
    useWorkspaceStore.getState().openFilePane('w1', 'src/app.ts')
    const id = fileLeavesIn(layout().root)[0]!.terminalId
    useWorkspaceStore.getState().setFileEdited(id, { worktreeId: 'w1', path: 'src/app.ts' })
    await useWorkspaceStore.getState().closeTerminal(id)
    expect(useWorkspaceStore.getState().dialog).toEqual({ kind: 'confirm-close-file', terminalId: id })
    expect(fileLeavesIn(layout().root)).toHaveLength(1)

    await useWorkspaceStore.getState().forceCloseTerminal(id)
    expect(fileLeavesIn(layout().root)).toEqual([])
    expect(useWorkspaceStore.getState().unsavedFiles).toEqual({})
  })
})

describe('the strip over a file column', () => {
  it('shows the column as one tab: the shown file, the others counted, a click focusing it', () => {
    for (const path of ['a.ts', 'src/app.ts', 'b.ts', 'c.ts']) useWorkspaceStore.getState().openFilePane('w1', path)
    const app = fileLeavesIn(layout().root)[1]!.terminalId
    useWorkspaceStore.getState().focusPane(app)
    useWorkspaceStore.getState().focusPane('t1')
    render(<TerminalTabs modifier={resolvePlatformModifier('darwin')} />)
    const tabs = within(screen.getByRole('tablist', { name: 'Terminals in this worktree' })).getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual(['terminal', 'app.ts+3'])
    fireEvent.click(tabs[1]!)
    expect(layout().focusedTerminalId).toBe(app)
    expect(screen.getByRole('button', { name: 'Close 4 files' })).toBeTruthy()
  })
})

describe('the file viewer', () => {
  const mount = (path = 'src/app.ts') =>
    render(<FileView paneId="file:1" worktreeId="w1" path={path} focused onFocus={() => {}} onClose={() => {}} />)

  const editorView = async (): Promise<EditorView> => {
    const content = await waitFor(() => {
      const found = document.querySelector('.cm-content')
      if (!(found instanceof HTMLElement)) throw new Error('no editor yet')
      return found
    })
    return EditorView.findFromDOM(content)!
  }

  it('edits, marks the tab unsaved, and saves against the version it read', async () => {
    let onDisk = text('const a = 1\n')
    call.mockImplementation(async (method: string, params: { content?: string }) => {
      if (method === 'file.read') return onDisk
      if (method === 'file.write') {
        onDisk = text(params.content ?? '', 200)
        return { worktreeId: 'w1', path: 'src/app.ts', size: onDisk.size, modifiedAt: 200 }
      }
      return undefined
    })
    mount()
    const view = await editorView()
    expect(view.state.doc.toString()).toBe('const a = 1\n')

    act(() => view.dispatch({ changes: { from: 10, to: 11, insert: '2' } }))
    expect(useWorkspaceStore.getState().unsavedFiles['file:1']).toBe(true)

    expect(await useWorkspaceStore.getState().saveFiles(['file:1'])).toBe(true)
    await waitFor(() => expect(useWorkspaceStore.getState().unsavedFiles['file:1']).toBeUndefined())
    expect(call).toHaveBeenCalledWith('file.write', {
      worktreeId: 'w1',
      path: 'src/app.ts',
      content: 'const a = 2\n',
      encoding: 'utf-8',
      expectedModifiedAt: 100
    })
    expect(onDisk).toMatchObject({ content: 'const a = 2\n' })
  })

  it('offers Reload and Overwrite when the file changed under the edit', async () => {
    call.mockImplementation(async (method: string) => {
      if (method === 'file.read') return text('x\n')
      if (method === 'file.write') throw Object.assign(new Error('changed on disk'), { code: 'conflict' })
      return undefined
    })
    mount()
    const view = await editorView()
    act(() => view.dispatch({ changes: { from: 0, insert: 'y' } }))
    expect(await act(() => useWorkspaceStore.getState().saveFiles(['file:1']))).toBe(false)
    expect(await screen.findByRole('button', { name: 'Overwrite' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).not.toMatch(/\.(\s|$)/)
  })

  it('draws an image, a PDF, media and a binary file by what the runtime answered', async () => {
    const answers: Record<string, FileViewAnswer> = {
      'a.png': { kind: 'image', url: 'teamree-file://grant/1/a.png', mime: 'image/png' },
      'a.pdf': { kind: 'pdf', url: 'teamree-file://grant/2/a.pdf', mime: 'application/pdf' },
      'a.mp4': { kind: 'media', url: 'teamree-file://grant/3/a.mp4', mime: 'video/mp4' },
      'a.bin': { kind: 'binary' },
      'big.log': { kind: 'tooLarge', limit: 10 }
    }
    call.mockImplementation(async (method: string, params: { path: string; viewer?: boolean }) =>
      method === 'file.read' && params.viewer
        ? {
            worktreeId: 'w1',
            path: params.path,
            content: '',
            exists: true,
            size: 2048,
            modifiedAt: 1,
            view: answers[params.path]
          }
        : undefined
    )
    let view = mount('a.png')
    expect((await screen.findByRole('img', { name: 'a.png' })).getAttribute('src')).toBe('teamree-file://grant/1/a.png')
    view.unmount()
    view = mount('a.pdf')
    await waitFor(() =>
      expect(document.querySelector('iframe')?.getAttribute('src')).toBe('teamree-file://grant/2/a.pdf')
    )
    view.unmount()
    view = mount('a.mp4')
    await waitFor(() =>
      expect(document.querySelector('video')?.getAttribute('src')).toBe('teamree-file://grant/3/a.mp4')
    )
    view.unmount()
    view = mount('a.bin')
    expect(await screen.findByText('Binary · 2.0 KB')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open in default app' })).toBeTruthy()
    view.unmount()
    mount('big.log')
    expect(await screen.findByText('Too large · 2.0 KB')).toBeTruthy()
  })

  it('shows the working-tree diff for the file on Diff', async () => {
    call.mockImplementation(async (method: string, params: { staged?: boolean }) => {
      if (method === 'file.read') return text('a\n')
      if (method === 'worktree.diff') {
        return {
          worktreeId: 'w1',
          path: 'src/app.ts',
          staged: params.staged ?? false,
          patch: params.staged
            ? ''
            : 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-b\n+a\n',
          truncated: false,
          readAt: 1
        }
      }
      return undefined
    })
    mount()
    await editorView()
    fireEvent.click(screen.getByRole('button', { name: 'Diff' }))
    await waitFor(() => expect(call).toHaveBeenCalledWith('worktree.diff', { worktreeId: 'w1', path: 'src/app.ts' }))
    await waitFor(() => expect(document.querySelector('.patch')).not.toBeNull())
    expect(screen.getByRole('button', { name: 'Diff' }).getAttribute('aria-pressed')).toBe('true')
  })

  const changes = (total: number) => ({ worktreeId: 'w1', changes: [], total, limit: 1, truncated: false, readAt: 1 })
  const patchOf = (patch: string, staged = false) => ({
    worktreeId: 'w1',
    path: 'src/app.ts',
    staged,
    patch,
    truncated: false,
    readAt: 1
  })

  it('disables Diff for a file with nothing to show, and enables it once it changes', async () => {
    let total = 0
    call.mockImplementation(async (method: string) => {
      if (method === 'file.read') return text('a\n')
      if (method === 'worktree.changes') return changes(total)
      return undefined
    })
    mount()
    await editorView()
    const diff = screen.getByRole('button', { name: 'Diff' }) as HTMLButtonElement
    await waitFor(() => expect(diff.disabled).toBe(true))
    expect(call).toHaveBeenCalledWith('worktree.changes', { worktreeId: 'w1', path: 'src/app.ts', limit: 1 })

    total = 1
    act(() => useWorkspaceStore.setState((state) => ({ worktreeFilesEpoch: state.worktreeFilesEpoch + 1 })))
    await waitFor(() => expect(diff.disabled).toBe(false))
  })

  it('says No changes in an open diff once its change is discarded', async () => {
    let working = 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-b\n+a\n'
    call.mockImplementation(async (method: string, params: { staged?: boolean }) => {
      if (method === 'file.read') return text('a\n')
      if (method === 'worktree.changes') return changes(working === '' ? 0 : 1)
      if (method === 'worktree.diff') return patchOf(params.staged ? '' : working, params.staged)
      return undefined
    })
    mount()
    await editorView()
    const diff = screen.getByRole('button', { name: 'Diff' }) as HTMLButtonElement
    await waitFor(() => expect(diff.disabled).toBe(false))
    fireEvent.click(diff)
    await waitFor(() => expect(document.querySelector('.patch')).not.toBeNull())

    working = ''
    act(() => useWorkspaceStore.setState((state) => ({ worktreeFilesEpoch: state.worktreeFilesEpoch + 1 })))
    expect(await screen.findByText('No changes')).toBeTruthy()
    expect(document.querySelector('.patch')).toBeNull()
    expect(diff.disabled).toBe(false)
    fireEvent.click(diff)
    await waitFor(() => expect(diff.disabled).toBe(true))
  })
})

describe('one header for code and markdown', () => {
  const MAC = resolvePlatformModifier('darwin')
  const worktree = { id: 'w1', projectId: 'p1', name: 'w', branch: 'w', path: '/repos/w', state: 'ready' } as Worktree
  const root: PaneNode = {
    kind: 'split',
    direction: 'row',
    sizes: [0.5, 0.5],
    children: [fileLeaf('file:code', 'src/app.ts'), fileLeaf('file:md', 'docs/guide.md')]
  }
  const patch = (path: string): string =>
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-b\n+a\n`
  let total = 1

  beforeEach(() => {
    total = 1
    call.mockImplementation(async (method: string, params: { path: string; staged?: boolean }) => {
      if (method === 'file.read') return { ...text('a\n'), path: params.path }
      if (method === 'worktree.changes')
        return { worktreeId: 'w1', changes: [], total, limit: 1, truncated: false, readAt: 1 }
      if (method === 'worktree.diff') {
        const body = params.staged ? '' : patch(params.path)
        return { worktreeId: 'w1', path: params.path, staged: false, patch: body, truncated: false, readAt: 1 }
      }
      return undefined
    })
    useWorkspaceStore.setState({
      worktrees: [worktree],
      layouts: { w1: { worktreeId: 'w1', root, focusedTerminalId: 'file:code' } },
      loadEditors: async () => {}
    })
    render(
      <>
        <TerminalTabs modifier={MAC} />
        <PaneTree
          node={root}
          path={[]}
          worktreeId="w1"
          terminals={{}}
          focusedTerminalId="file:code"
          onFocus={() => {}}
          onClose={() => {}}
          onRelaunch={() => {}}
          onResize={() => {}}
          isAppChord={() => false}
          modifier={MAC}
          searchTerminalId={null}
          searchToken={0}
          onCloseSearch={() => {}}
        />
      </>
    )
  })

  const header = (name: string): HTMLElement => screen.getByRole('region', { name }).querySelector('header')!
  /** The bar left to right: glyph, `dir/` and name, the dot, then every button by its name. */
  const parts = (name: string): string[] =>
    [...header(name).children].flatMap((part) => {
      if (part.classList.contains('file__glyph')) return ['glyph']
      if (part.classList.contains('file__path'))
        return [`${part.querySelector('.file__dir')?.textContent}|${part.textContent}`]
      if (part.classList.contains('file__unsaved')) return ['dot']
      if (part.tagName === 'BUTTON') return [part.getAttribute('aria-label') ?? part.textContent ?? '']
      return []
    })
  const menuLabels = (): string[] =>
    within(screen.getByRole('menu'))
      .getAllByRole('menuitem')
      .filter((item) => item.parentElement === screen.getByRole('menu'))
      .map((item) => item.querySelector('.row-menu__label')?.textContent ?? '')

  it('lays both out alike: glyph, path, the dot only when dirty, tools, ⋯, ×', async () => {
    await screen.findByText('a', { selector: '.ProseMirror p' })
    expect(parts('app.ts')).toEqual(['glyph', 'src/|src/app.ts', 'Diff', 'More for app.ts', 'Close pane app.ts'])
    expect(parts('guide.md')).toEqual([
      'glyph',
      'docs/|docs/guide.md',
      'Diff',
      'More for guide.md',
      'Close pane guide.md'
    ])

    act(() => useWorkspaceStore.setState({ unsavedFiles: { 'file:code': true, 'file:md': true } }))
    expect(parts('app.ts').slice(0, 3)).toEqual(['glyph', 'src/|src/app.ts', 'dot'])
    expect(parts('guide.md').slice(0, 3)).toEqual(['glyph', 'docs/|docs/guide.md', 'dot'])
  })

  it('draws the tab’s dirty dot as the header draws it', () => {
    act(() => useWorkspaceStore.setState({ unsavedFiles: { 'file:md': true } }))
    const tabDot = within(screen.getByRole('tab', { name: 'guide.md' })).getByTestId('unsaved')
    expect(header('guide.md').querySelector('.file__unsaved')?.outerHTML).toBe(tabDot.outerHTML)
  })

  it('opens the right-click menu from ⋯, Open as artifact in it for a page', async () => {
    for (const name of ['app.ts', 'guide.md']) {
      fireEvent.contextMenu(header(name), { clientX: 300, clientY: 60 })
      const rightClick = menuLabels()
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
      fireEvent.click(screen.getByRole('button', { name: `More for ${name}` }))
      expect(menuLabels()).toEqual(rightClick)
      expect(rightClick.includes('Open as Artifact')).toBe(name === 'guide.md')
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    }
    expect(screen.queryByRole('button', { name: 'Open as Artifact' })).toBeNull()
  })

  it('closes on a second ⋯, the focus back on it', () => {
    const more = screen.getByRole('button', { name: 'More for app.ts' })
    fireEvent.click(more)
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.click(more)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(more)
  })

  it('copies the page as it stands from Open as artifact, then opens a new chat', async () => {
    const copy = vi.fn(async () => {})
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    useWorkspaceStore.setState({ copyToClipboard: copy })
    await screen.findByText('a', { selector: '.ProseMirror p' })
    fireEvent.click(screen.getByRole('button', { name: 'More for guide.md' }))
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Open as Artifact' }))
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://claude.ai/new', '_blank', 'noopener'))
    expect(copy).toHaveBeenCalledWith('a\n', 'guide.md')
    open.mockRestore()
  })

  it('offers a page its diff when it has changes, as a code file', async () => {
    const diff = within(header('guide.md')).getByRole('button', { name: 'Diff' }) as HTMLButtonElement
    await waitFor(() => expect(diff.disabled).toBe(false))
    fireEvent.click(diff)
    await waitFor(() => expect(screen.getByRole('region', { name: 'guide.md' }).querySelector('.patch')).not.toBeNull())
    expect(diff.getAttribute('aria-pressed')).toBe('true')
    expect(within(header('guide.md')).getByRole('button', { name: 'Inline' })).toBeTruthy()
  })

  it('leaves Diff off on a page with nothing changed', async () => {
    total = 0
    act(() => useWorkspaceStore.setState((state) => ({ worktreeFilesEpoch: state.worktreeFilesEpoch + 1 })))
    const diff = within(header('guide.md')).getByRole('button', { name: 'Diff' }) as HTMLButtonElement
    await waitFor(() => expect(diff.disabled).toBe(true))
  })
})
