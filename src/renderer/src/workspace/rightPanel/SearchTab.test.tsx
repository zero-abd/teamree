/** @vitest-environment jsdom */

// The Search tab through the right panel: what it asks the runtime for, how the
// streamed hits are grouped, and where a chosen hit opens.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Worktree } from '@shared/entities'
import type { SearchFileHits, WorktreeSearchEvent } from '@shared/search'

type Search = {
  params: Record<string, unknown>
  emit: (event: WorktreeSearchEvent) => void
  close: ReturnType<typeof vi.fn>
}
const searches: Search[] = []

vi.mock('../../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: () => new Promise(() => {}),
    searchContents: (params: Record<string, unknown>, onEvent: (event: WorktreeSearchEvent) => void) => {
      const close = vi.fn()
      searches.push({ params, emit: onEvent, close })
      return Promise.resolve({ close })
    },
    watchPane: () => new Promise(() => {}),
    subscribeTerminal: () => new Promise(() => {}),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('../../state/workspaceStore')
const { useSearchStore } = await import('./searchStore')
const { RightPanel } = await import('./RightPanel')
const { statusLine } = await import('./SearchTab')

const INITIAL = useWorkspaceStore.getState()
const INITIAL_SEARCH = useSearchStore.getState()

const project: Project = { id: 'p1', name: 'api', path: '/repos/api', baseRef: 'origin/main' }
const worktree = (id: string, name: string): Worktree => ({
  id,
  projectId: 'p1',
  name,
  branch: name.replace(/ /g, '-'),
  path: `/wt/${id}`,
  startedFrom: 'origin/main',
  state: 'ready',
  createdAt: 0
})

const openFileAt = vi.fn(() => Promise.resolve())
const openWorktree = vi.fn((id: string) => {
  useWorkspaceStore.setState({ activeWorktreeId: id })
  return Promise.resolve()
})

beforeEach(() => {
  searches.length = 0
  openFileAt.mockClear()
  openWorktree.mockClear()
  window.localStorage.clear()
  useSearchStore.setState(INITIAL_SEARCH, true)
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      projects: [project],
      worktrees: [worktree('w1', 'auth refresh'), worktree('w2', 'rate limits')],
      activeWorktreeId: 'w2',
      openWorktreeIds: ['w1', 'w2'],
      rightPanelOpen: true,
      rightPanelTab: 'search',
      openFileAt,
      openWorktree
    },
    true
  )
})

const field = (): HTMLInputElement => screen.getByRole('textbox', { name: 'Search in files' }) as HTMLInputElement

async function type(query: string): Promise<Search> {
  const before = searches.length
  fireEvent.change(field(), { target: { value: query } })
  await waitFor(() => expect(searches.length).toBeGreaterThan(before))
  return searches.at(-1) as Search
}

const LIMITS: SearchFileHits = {
  worktreeId: 'w1',
  path: 'src/limits.ts',
  lines: [{ line: 4, column: 14, text: 'export const limit = 3', ranges: [[13, 18]] }]
}

const MIDDLEWARE: SearchFileHits = {
  worktreeId: 'w2',
  path: 'src/middleware.ts',
  lines: [
    { line: 2, column: 11, text: 'const x = limit(2)', ranges: [[10, 15]] },
    { line: 1, column: 1, text: 'limit()', ranges: [[0, 5]] }
  ]
}

const HITS: WorktreeSearchEvent = { type: 'hits', files: [LIMITS, MIDDLEWARE] }

describe('the search tab', () => {
  it('searches this task as typed, with the toggles and globs as asked', async () => {
    render(<RightPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Match Case' }))
    fireEvent.click(screen.getByRole('button', { name: 'Use Regular Expression' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Files to include' }), {
      target: { value: 'src/**, !*.test.ts' }
    })
    const search = await type('limit\\(')
    expect(search.params).toEqual({
      worktreeId: 'w2',
      query: 'limit\\(',
      caseSensitive: true,
      regex: true,
      include: ['src/**', '!*.test.ts']
    })
    expect(screen.getByRole('button', { name: 'Match Case' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('asks for the whole project on All Tasks, and groups by task, open one first, then file, in line order', async () => {
    render(<RightPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'All Tasks' }))
    const search = await type('limit')
    expect(search.params).toEqual({ projectId: 'p1', query: 'limit' })

    act(() => {
      search.emit(HITS)
      search.emit({ type: 'done', matches: 3, truncated: false, timedOut: false, elapsedMs: 9, engine: 'rg' })
    })
    const results = screen.getByRole('list', { name: 'Results' })
    const rows = within(results)
      .getAllByRole('listitem')
      .map((row) => row.textContent)
    expect(rows).toEqual([
      'rate limits2',
      'middleware.tssrc2',
      '1limit()',
      '2const x = limit(2)',
      'auth refresh1',
      'limits.tssrc1',
      '4export const limit = 3'
    ])
    expect(screen.getByRole('status').textContent).toBe('3 matches in 2 files')
    const marks = results.querySelectorAll('mark')
    expect([...marks].map((mark) => mark.textContent)).toEqual(['limit', 'limit', 'limit'])
  })

  it('opens a hit at its line, switching to its task first', async () => {
    render(<RightPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'All Tasks' }))
    const search = await type('limit')
    act(() => search.emit(HITS))

    fireEvent.click(await screen.findByTitle('src/limits.ts:4'))
    await waitFor(() => expect(openFileAt).toHaveBeenCalledWith('w1', 'src/limits.ts', 4, 14))
    expect(openWorktree).toHaveBeenCalledWith('w1')
  })

  it('walks the hits with the arrows and opens the chosen one on Enter', async () => {
    render(<RightPanel />)
    const search = await type('limit')
    act(() => search.emit({ type: 'hits', files: [MIDDLEWARE] }))
    act(() => search.emit({ type: 'done', matches: 2, truncated: false, timedOut: false, elapsedMs: 1, engine: 'git' }))

    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    expect(screen.getByTitle('src/middleware.ts:2').getAttribute('aria-current')).toBe('true')
    fireEvent.keyDown(field(), { key: 'Enter' })
    await waitFor(() => expect(openFileAt).toHaveBeenCalledWith('w2', 'src/middleware.ts', 2, 11))
    expect(openWorktree).not.toHaveBeenCalled()
  })

  it('shows a match deep in a long line, marked, with the whole line on hover', async () => {
    render(<RightPanel />)
    const search = await type('limit')
    const text = `export function fn_0_0_40(x: number) { return clamp(x, 0, 99) + ${'y'.repeat(20)}limit(x, 40) }`
    const at = text.indexOf('limit')
    act(() =>
      search.emit({
        type: 'hits',
        files: [
          { worktreeId: 'w2', path: 'src/fns.ts', lines: [{ line: 7, column: at + 1, text, ranges: [[at, at + 5]] }] }
        ]
      })
    )
    const row = await screen.findByTitle('src/fns.ts:7')
    const snippet = row.querySelector('.search__text') as HTMLElement
    expect(snippet.textContent?.startsWith('…')).toBe(true)
    expect(snippet.textContent?.indexOf('limit')).toBe(25)
    expect(snippet.querySelector('mark')?.textContent).toBe('limit')
    expect(snippet.title).toBe(text)
  })

  it('draws streamed batches once per frame, and all of them when the search ends', async () => {
    render(<RightPanel />)
    const search = await type('limit')
    const drawn: number[] = []
    const stop = useSearchStore.subscribe((state, before) => {
      if (state.files !== before.files) drawn.push(state.files.length)
    })
    act(() => {
      search.emit({ type: 'hits', files: [LIMITS] })
      search.emit({ type: 'hits', files: [MIDDLEWARE] })
    })
    expect(drawn).toEqual([])
    await waitFor(() => expect(drawn).toEqual([2]))
    act(() => {
      search.emit({ type: 'hits', files: [{ ...LIMITS, path: 'src/late.ts' }] })
      search.emit({ type: 'done', matches: 4, truncated: false, timedOut: false, elapsedMs: 1, engine: 'rg' })
    })
    expect(drawn).toEqual([2, 3])
    stop()
  })

  it('folds a file’s hits under its header', async () => {
    render(<RightPanel />)
    const search = await type('limit')
    act(() => search.emit(HITS))
    fireEvent.click(await screen.findByRole('button', { name: /middleware\.ts/ }))
    expect(screen.queryByTitle('src/middleware.ts:2')).toBeNull()
  })

  it('cancels the search it replaces', async () => {
    render(<RightPanel />)
    const first = await type('lim')
    const second = await type('limit')
    expect(second).not.toBe(first)
    expect(first.close).toHaveBeenCalled()
    act(() => first.emit(HITS))
    expect(screen.queryByRole('list', { name: 'Results' })?.textContent ?? '').toBe('')
  })

  it('opens on ⌘⇧F’s command with the caret in the field', async () => {
    useWorkspaceStore.setState({ rightPanelOpen: false, rightPanelTab: 'files' })
    render(<RightPanel />)
    act(() => useWorkspaceStore.getState().openSearch())
    expect(useWorkspaceStore.getState().rightPanelTab).toBe('search')
    await waitFor(() => expect(document.activeElement).toBe(field()))

    // Opening a hit in another task remounts the tab; the caret stays where the file put it.
    field().blur()
    act(() => useWorkspaceStore.setState({ activeWorktreeId: 'w1' }))
    expect(document.activeElement).not.toBe(field())
  })
})

describe('the status line', () => {
  const base = { query: 'x', running: false, error: null, matches: 0, files: 0, truncated: false, timedOut: false }
  it('says how many, capped or timed out, or what failed', () => {
    expect(statusLine({ ...base, query: '' })).toBeNull()
    expect(statusLine({ ...base, running: true })).toBe('Searching…')
    expect(statusLine(base)).toBe('No matches')
    expect(statusLine({ ...base, matches: 1, files: 1 })).toBe('1 match in 1 file')
    expect(statusLine({ ...base, matches: 2000, files: 40, truncated: true })).toBe('2,000+ matches in 40 files')
    expect(statusLine({ ...base, matches: 3, files: 2, timedOut: true })).toBe('3 matches in 2 files · timed out')
    expect(statusLine({ ...base, error: 'Unmatched ( or \\(' })).toBe('Unmatched ( or \\(')
  })
})
