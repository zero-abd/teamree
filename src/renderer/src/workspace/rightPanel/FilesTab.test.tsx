/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree, WorktreeChange, WorktreeFileMatches, WorktreeFiles } from '@shared/entities'

const listing: WorktreeFiles = {
  worktreeId: 'w1',
  path: '',
  entries: [
    { name: 'src', kind: 'dir', ignored: false },
    { name: 'NOTES.md', kind: 'file', ignored: false },
    { name: 'logo.png', kind: 'file', ignored: false },
    { name: 'package.json', kind: 'file', ignored: false },
    { name: 'totals.ts', kind: 'file', ignored: false }
  ],
  truncated: false,
  readAt: 0
}

const found: WorktreeFileMatches = {
  worktreeId: 'w1',
  query: 'tot',
  paths: ['src/cart/totals.ts'],
  truncated: false,
  readAt: 0
}

vi.mock('../../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: (method: string) =>
      method === 'worktree.files'
        ? Promise.resolve(listing)
        : method === 'worktree.findFiles'
          ? Promise.resolve(found)
          : new Promise(() => {}),
    watchPane: () => new Promise(() => {}),
    subscribeTerminal: () => new Promise(() => {}),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('../../state/workspaceStore')
const { FilesTab } = await import('./FilesTab')

const INITIAL = useWorkspaceStore.getState()

const worktree = {
  id: 'w1',
  projectId: 'p1',
  name: 'rewrite',
  branch: 'rewrite',
  path: '/repos/pager-wt/rewrite',
  startedFrom: 'main',
  state: 'ready',
  createdAt: 0
} as Worktree

const changes: WorktreeChange[] = [
  { path: 'totals.ts', kind: 'modified', staged: false, unstaged: true },
  { path: 'NOTES.md', kind: 'untracked', staged: false, unstaged: true },
  { path: 'src/cart/totals.ts', kind: 'modified', staged: false, unstaged: true }
]

const revealInFinder = vi.fn(async () => {})

beforeEach(() => {
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      revealInFinder,
      activeWorktreeId: 'w1',
      worktrees: [worktree],
      changes: { w1: { worktreeId: 'w1', changes, total: changes.length, limit: 500, truncated: false, readAt: 0 } }
    },
    true
  )
})

afterEach(() => {
  cleanup()
  revealInFinder.mockClear()
})

/** The tree row drawn for `name`. */
async function rowFor(name: string): Promise<HTMLElement> {
  const item = await screen.findByRole('treeitem', { name: new RegExp(`^${name.replace('.', '\\.')}`) })
  return item.querySelector<HTMLElement>('.tree__row') as HTMLElement
}

describe('the files tab’s rows', () => {
  it('draws a folder and each kind of file with its own icon', async () => {
    render(<FilesTab worktree={worktree} />)
    const icons = await Promise.all(
      ['src', 'NOTES.md', 'logo.png', 'package.json', 'totals.ts'].map(async (name) =>
        (await rowFor(name)).querySelector('svg[data-icon]')?.getAttribute('data-icon')
      )
    )
    expect(icons).toEqual(['folder', 'file-text', 'file-image', 'file-data', 'file-code'])
  })

  it('opens the folder icon with the folder', async () => {
    render(<FilesTab worktree={worktree} />)
    fireEvent.click(await rowFor('src'))
    expect((await rowFor('src')).querySelector('svg[data-icon]')?.getAttribute('data-icon')).toBe('folder-open')
  })

  it('colours a changed file’s name by what git says of it, with the letter beside it', async () => {
    render(<FilesTab worktree={worktree} />)
    const modified = await rowFor('totals.ts')
    expect(modified.querySelector('.tree__name')?.className).toContain('tree__name--modified')
    expect(modified.querySelector('.tree__status')?.textContent).toBe('M')

    const untracked = await rowFor('NOTES.md')
    expect(untracked.querySelector('.tree__name')?.className).toContain('tree__name--untracked')
    expect(untracked.querySelector('.tree__status')?.textContent).toBe('?')

    const clean = await rowFor('package.json')
    expect(clean.querySelector('.tree__name')?.className).toBe('tree__name')
    expect(clean.querySelector('.tree__status')).toBeNull()
  })

  it('keeps Reveal in Finder on every row as an icon, named for the row', async () => {
    render(<FilesTab worktree={worktree} />)
    const reveal = await screen.findByRole('button', { name: 'Reveal totals.ts in Finder' })
    expect(reveal.getAttribute('title')).toBe('Reveal in Finder')
    expect(reveal.querySelector('svg[data-icon="reveal"]')).not.toBeNull()
    fireEvent.click(reveal)
    expect(revealInFinder).toHaveBeenCalledWith(`${worktree.path}/totals.ts`, 'totals.ts')
  })

  it('lists a found file by its name first, its folder after it, dim, in its status colour', async () => {
    render(<FilesTab worktree={worktree} />)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find files' }), { target: { value: 'tot' } })
    const list = await screen.findByRole('list', { name: 'Files matching tot' })
    const row = within(list).getByTitle('src/cart/totals.ts')
    const name = row.querySelector('.tree__name') as HTMLElement
    expect(name.className).toContain('tree__name--modified')
    expect([...name.children].map((part) => [part.className, part.textContent])).toEqual([
      ['tree__file', 'totals.ts'],
      ['tree__dir', 'src/cart']
    ])
    expect(row.querySelector('svg[data-icon]')?.getAttribute('data-icon')).toBe('file-code')
  })
})
