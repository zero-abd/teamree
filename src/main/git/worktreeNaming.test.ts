import { describe, expect, it } from 'vitest'
import { allocateBranchName, branchCollides, checkoutDirName, slugify, taskNamesForAgents } from './worktreeNaming'

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

describe('taskNamesForAgents', () => {
  it('leaves one agent with the task name it would have had alone', () => {
    expect(taskNamesForAgents('task', ['claude'])).toEqual(['task'])
    expect(taskNamesForAgents('task', [])).toEqual(['task'])
  })

  it('names the later attempts after the agent that runs them', () => {
    expect(taskNamesForAgents('task', ['claude', 'codex', 'claude'])).toEqual(['task', 'task codex', 'task claude 2'])
  })

  // Racing two runs of one model is as ordinary as racing two models, so the
  // repeat has to get a number rather than the same suffix twice.
  it('counts an agent that comes round again', () => {
    expect(taskNamesForAgents('task', ['claude', 'claude', 'claude'])).toEqual([
      'task',
      'task claude 2',
      'task claude 3'
    ])
  })

  it('slugifies into the branch names the suffix promises', () => {
    const branches = taskNamesForAgents('task', ['claude', 'codex', 'claude']).map(slugify)
    expect(branches).toEqual(['task', 'task-codex', 'task-claude-2'])
  })

  // The suffix distinguishes the runs from each other; it says nothing about
  // what the repository already holds, which is still the allocator's job.
  it('leaves collisions with existing branches to the allocator', () => {
    const taken: string[] = []
    for (const name of taskNamesForAgents('task', ['claude', 'codex', 'claude'])) {
      taken.push(allocateBranchName(name, taken))
    }
    expect(taken).toEqual(['task', 'task-codex', 'task-claude-2'])

    const second: string[] = ['task', 'task-codex', 'task-claude-2']
    const names = taskNamesForAgents('task', ['claude', 'codex']).map((name) => {
      const branch = allocateBranchName(name, second)
      second.push(branch)
      return branch
    })
    expect(names).toEqual(['task-2', 'task-codex-2'])
  })
})
