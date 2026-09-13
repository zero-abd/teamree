import { describe, expect, it } from 'vitest'
import type { Project, Worktree } from '@shared/entities'
import { buildPaletteItems, filterPalette, moveSelection, score, type PaletteItem } from './paletteModel'

function worktree(overrides: Partial<Worktree> & { id: string }): Worktree {
  return {
    projectId: 'p1',
    name: overrides.id,
    branch: `task/${overrides.id}`,
    path: `/checkouts/${overrides.id}`,
    startedFrom: 'main',
    state: 'ready',
    createdAt: 0,
    ...overrides
  }
}

const projects: Project[] = [
  { id: 'p1', name: 'atlas', path: '/repos/atlas', baseRef: 'origin/main' },
  { id: 'p2', name: 'ledger', path: '/repos/ledger', baseRef: 'origin/main' }
]

const context = (
  overrides: Partial<Parameters<typeof buildPaletteItems>[0]> = {}
): Parameters<typeof buildPaletteItems>[0] => ({
  worktrees: [],
  projects,
  activeWorktreeId: null,
  hintFor: () => '',
  ...overrides
})

describe('buildPaletteItems', () => {
  it('offers every worktree but the one already open', () => {
    const items = buildPaletteItems(
      context({
        worktrees: [worktree({ id: 'here' }), worktree({ id: 'elsewhere' })],
        activeWorktreeId: 'here'
      })
    )

    const ids = items.filter((item) => item.kind === 'worktree').map((item) => item.id)
    expect(ids).toEqual(['elsewhere'])
  })

  it('makes a worktree findable by its branch and its project, not just its name', () => {
    const [item] = buildPaletteItems(context({ worktrees: [worktree({ id: 'w1', name: 'login fix' })] }))

    expect(item?.search).toContain('login fix')
    expect(item?.search).toContain('task/w1')
    expect(item?.search).toContain('atlas')
  })

  it('says what a worktree is doing when it is not simply ready', () => {
    const [item] = buildPaletteItems(context({ worktrees: [worktree({ id: 'w1', state: 'creating' })] }))

    expect(item?.detail).toContain('creating')
  })

  it('puts worktrees before actions, since jumping is what it is opened for', () => {
    const items = buildPaletteItems(context({ worktrees: [worktree({ id: 'w1' })] }))

    expect(items[0]?.kind).toBe('worktree')
    expect(items.some((item) => item.kind === 'action')).toBe(true)
  })

  // Somebody hunting for the pane that needs them will type what they are
  // after — the state, not the name of the view.
  it('finds the all-panes view by the words a person would reach for it with', () => {
    const items = buildPaletteItems(context())

    for (const query of ['all panes', 'agents', 'waiting', 'dashboard']) {
      expect(filterPalette(items, query)[0]).toMatchObject({ kind: 'action', id: 'open-dashboard' })
    }
  })

  it('shows the key that does the same thing', () => {
    const items = buildPaletteItems(context({ hintFor: (action) => (action === 'new-terminal' ? '⌘T' : '') }))

    expect(items.find((item) => item.kind === 'action' && item.id === 'new-terminal')?.hint).toBe('⌘T')
  })
})

describe('score', () => {
  it('finds letters in order and refuses letters that are not there', () => {
    expect(score('rank results', 'rr')).not.toBeNull()
    expect(score('rank results', 'rz')).toBeNull()
  })

  it('prefers the whole query together over the same letters scattered', () => {
    const together = score('login fix', 'login') as number
    const scattered = score('l o g i n something', 'login') as number
    expect(together).toBeGreaterThan(scattered)
  })

  it('prefers a match that starts a word', () => {
    expect(score('fix login', 'login') as number).toBeGreaterThan(score('relogin fixes', 'login') as number)
  })

  it('matches an initialism across word boundaries', () => {
    expect(score('New worktree', 'nw')).not.toBeNull()
    expect(score('New worktree', 'nw') as number).toBeGreaterThan(score('now here', 'nw') as number)
  })

  it('is case-insensitive in both directions', () => {
    expect(score('Login Fix', 'login')).not.toBeNull()
    expect(score('login fix', 'LOGIN')).not.toBeNull()
  })

  it('matches everything when nothing has been typed', () => {
    expect(score('anything at all', '')).toBe(0)
  })
})

describe('filterPalette', () => {
  const items: PaletteItem[] = [
    { kind: 'worktree', id: 'w1', label: 'login fix', hint: 'task/login', detail: 'atlas', search: 'login fix' },
    {
      kind: 'worktree',
      id: 'w2',
      label: 'schema migration',
      hint: 'task/schema',
      detail: 'ledger',
      search: 'schema migration'
    },
    {
      kind: 'action',
      id: 'new-terminal',
      label: 'New terminal',
      hint: '',
      detail: 'Action',
      search: 'New terminal shell'
    }
  ]

  it('keeps everything, in order, before anything is typed', () => {
    expect(filterPalette(items, '').map((item) => item.id)).toEqual(['w1', 'w2', 'new-terminal'])
  })

  it('drops what does not match at all', () => {
    expect(filterPalette(items, 'zzz')).toEqual([])
  })

  it('ranks the thing you meant first', () => {
    expect(filterPalette(items, 'login')[0]?.id).toBe('w1')
    expect(filterPalette(items, 'schema')[0]?.id).toBe('w2')
    expect(filterPalette(items, 'terminal')[0]?.id).toBe('new-terminal')
  })

  it('finds an action by a word that is not in its label', () => {
    expect(filterPalette(items, 'shell')[0]?.id).toBe('new-terminal')
  })

  it('ignores surrounding whitespace rather than failing to match on it', () => {
    expect(filterPalette(items, '  login  ')[0]?.id).toBe('w1')
  })
})

describe('moveSelection', () => {
  it('wraps at both ends', () => {
    expect(moveSelection(3, 2, 1)).toBe(0)
    expect(moveSelection(3, 0, -1)).toBe(2)
  })

  it('stays at zero when there is nothing to select', () => {
    expect(moveSelection(0, 0, 1)).toBe(0)
  })
})
