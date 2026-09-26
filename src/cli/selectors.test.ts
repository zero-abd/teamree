import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CliError } from './exit.js'
import type { Worktree } from '../shared/entities.js'
import { canonicalPath, selectOne, selectWorktree } from './selectors.js'

const ITEMS = [
  { id: 'wt_1a2b3c', name: 'fix-login', path: '/repos/api-fix-login', aliases: ['feature/fix-login'] },
  { id: 'wt_9z8y7x', name: 'Fix-Login-2', path: '/repos/api-fix-login-2', aliases: ['feature/fix-login-2'] },
  { id: 'wt_1a2bff', name: 'docs', path: '/repos/api-docs', aliases: ['docs'] }
]

describe('selectOne', () => {
  it('matches an exact id first', () => {
    expect(selectOne('worktree', 'wt_1a2b3c', ITEMS).name).toBe('fix-login')
  })

  it('matches a name, case-insensitively when unambiguous', () => {
    expect(selectOne('worktree', 'fix-login', ITEMS).id).toBe('wt_1a2b3c')
    expect(selectOne('worktree', 'FIX-LOGIN-2', ITEMS).id).toBe('wt_9z8y7x')
  })

  it('matches a path, absolute or relative to the cwd', () => {
    const dir = mkdtempSync(join(tmpdir(), 'teamree-sel-'))
    mkdirSync(join(dir, 'checkout'))
    const items = [{ id: 'w', name: 'n', path: join(dir, 'checkout') }]
    expect(selectOne('worktree', join(dir, 'checkout'), items).id).toBe('w')
    expect(selectOne('worktree', join(dir, 'checkout', '.'), items).id).toBe('w')
  })

  it('matches a unique id prefix', () => {
    expect(selectOne('worktree', 'wt_9', ITEMS).id).toBe('wt_9z8y7x')
  })

  it('matches a branch only after everything else', () => {
    expect(selectOne('worktree', 'feature/fix-login-2', ITEMS).id).toBe('wt_9z8y7x')
    // "docs" is both a name and another row's branch; the name tier wins.
    expect(selectOne('worktree', 'docs', ITEMS).id).toBe('wt_1a2bff')
  })

  it('refuses an ambiguous prefix instead of guessing', () => {
    try {
      selectOne('worktree', 'wt_1a2b', ITEMS)
      throw new Error('expected an ambiguity error')
    } catch (error) {
      expect(error).toBeInstanceOf(CliError)
      expect((error as CliError).code).toBe('ambiguous_selector')
      expect((error as CliError).exitCode).toBe(1)
      expect((error as CliError).message).toMatch(/matches 2 worktrees by id-prefix/)
    }
  })

  it('reports a miss with the known names', () => {
    try {
      selectOne('project', 'ghost', ITEMS)
      throw new Error('expected a not-found error')
    } catch (error) {
      expect((error as CliError).code).toBe('not_found')
      expect((error as CliError).hint).toContain('fix-login')
    }
  })

  it('quotes the known names, so ones with spaces read apart', () => {
    const items = [
      { id: 'wt_1', name: 'fix login', path: '/repos/a', aliases: [] },
      { id: 'wt_2', name: 'fix login codex', path: '/repos/b', aliases: [] }
    ]
    try {
      selectOne('worktree', 'ghost', items)
      throw new Error('expected a not-found error')
    } catch (error) {
      expect((error as CliError).hint).toBe('Known worktrees: "fix login", "fix login codex".')
    }
  })

  it('says so when nothing exists at all', () => {
    expect(() => selectOne('project', 'x', [])).toThrow(/No projects exist yet|No project matches/)
  })
})

describe('canonicalPath', () => {
  it('absolutises and normalises', () => {
    expect(canonicalPath('a/b/..')).toBe(join(process.cwd(), 'a'))
  })
})

describe('here', () => {
  const root = canonicalPath(mkdtempSync(join(tmpdir(), 'teamree-here-')))
  const at = (id: string, dir: string): Worktree => {
    mkdirSync(join(root, dir, 'src'), { recursive: true })
    return {
      id,
      projectId: 'p',
      name: dir,
      branch: dir,
      path: join(root, dir),
      startedFrom: 'main',
      state: 'ready',
      createdAt: 1
    }
  }
  const worktrees = [at('w1', 'auth'), at('w2', 'auth--tests')]

  it('is the pane’s own worktree first', () => {
    const caller = { env: { TEAMREE_WORKTREE_ID: 'w2' }, cwd: root }
    expect(selectWorktree(worktrees, 'here', caller).id).toBe('w2')
  })

  it('is the checkout holding the cwd, from a subdirectory too, when the pane says nothing', () => {
    expect(selectWorktree(worktrees, 'here', { env: {}, cwd: join(root, 'auth', 'src') }).id).toBe('w1')
    expect(
      selectWorktree(worktrees, 'here', { env: { TEAMREE_WORKTREE_ID: 'gone' }, cwd: join(root, 'auth--tests') }).id
    ).toBe('w2')
  })

  it('is refused outside every checkout', () => {
    expect(() => selectWorktree(worktrees, 'here', { env: {}, cwd: tmpdir() })).toThrow(CliError)
  })
})
