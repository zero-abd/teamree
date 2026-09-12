import { describe, expect, it } from 'vitest'
import { parseWorktreeList } from './worktreeInventory'

describe('parseWorktreeList', () => {
  it('reads the records git prints for a primary checkout and its worktrees', () => {
    const entries = parseWorktreeList(
      [
        'worktree /repos/app',
        'HEAD aaaa',
        'branch refs/heads/main',
        '',
        'worktree /repos/.teamree/app/fix-login',
        'HEAD bbbb',
        'branch refs/heads/fix-login',
        '',
        'worktree /repos/.teamree/app/spike',
        'HEAD cccc',
        'detached',
        'locked',
        ''
      ].join('\n')
    )

    expect(entries).toHaveLength(3)
    expect(entries[0]).toEqual({
      path: '/repos/app',
      head: 'aaaa',
      branch: 'main',
      bare: false,
      detached: false,
      locked: false
    })
    expect(entries[1]?.branch).toBe('fix-login')
    expect(entries[2]).toMatchObject({ detached: true, locked: true })
    expect(entries[2]?.branch).toBeUndefined()
  })

  it('handles a bare primary repository and a trailing record with no blank line', () => {
    const entries = parseWorktreeList(
      'worktree /repos/app.git\nbare\n\nworktree /repos/wt\nHEAD dddd\nbranch refs/heads/wt'
    )

    expect(entries[0]?.bare).toBe(true)
    expect(entries[1]?.path).toBe('/repos/wt')
    expect(entries[1]?.branch).toBe('wt')
  })

  it('unquotes paths that git C-quoted', () => {
    const entries = parseWorktreeList('worktree "/repos/a\\tb"\nHEAD eeee\n')
    expect(entries[0]?.path).toBe('/repos/a\tb')
  })
})
