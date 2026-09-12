import { describe, expect, it } from 'vitest'
import { allocateBranchName, branchCollides, checkoutDirName, slugify } from './worktreeNaming'

describe('slugify', () => {
  it('reduces a task title to a safe branch fragment', () => {
    expect(slugify('Fix the login page')).toBe('fix-the-login-page')
    expect(slugify('  Refactor   PARSER!!  ')).toBe('refactor-parser')
    expect(slugify('feat/add-oauth')).toBe('feat-add-oauth')
    expect(slugify('café déjà vu')).toBe('cafe-deja-vu')
  })

  it('never produces a name git would reject', () => {
    expect(slugify('...')).toBe('worktree')
    expect(slugify('')).toBe('worktree')
    expect(slugify('-leading and trailing-')).toBe('leading-and-trailing')
    expect(slugify('index.lock')).toBe('index-lock')
    expect(slugify('a'.repeat(200)).length).toBeLessThanOrEqual(60)
  })
})

describe('branchCollides', () => {
  it('treats a ref that is a directory prefix of another as taken', () => {
    const taken = new Set(['feature/login', 'main'])
    expect(branchCollides('feature', taken)).toBe(true)
    expect(branchCollides('feature/login', taken)).toBe(true)
    expect(branchCollides('MAIN', taken)).toBe(true) // loose refs live on case-insensitive filesystems
    expect(branchCollides('feature-login', taken)).toBe(false)
  })
})

describe('allocateBranchName', () => {
  it('appends the first free counter', () => {
    expect(allocateBranchName('Fix login', [])).toBe('fix-login')
    expect(allocateBranchName('Fix login', ['fix-login'])).toBe('fix-login-2')
    expect(allocateBranchName('Fix login', ['fix-login', 'fix-login-2'])).toBe('fix-login-3')
    expect(allocateBranchName('Fix login', ['fix-login-2'])).toBe('fix-login')
  })
})

describe('checkoutDirName', () => {
  it('flattens a namespaced branch into one directory level', () => {
    expect(checkoutDirName('feature/add-oauth')).toBe('feature-add-oauth')
  })
})
