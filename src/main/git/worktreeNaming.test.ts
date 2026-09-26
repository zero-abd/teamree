import { describe, expect, it } from 'vitest'
import {
  allocateBranchName,
  allocateChildBranchName,
  branchCollides,
  checkoutDirName,
  childCheckoutDirName,
  slugify,
  taskNamesForAgents
} from './worktreeNaming'

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
  // Every shape a fan-out comes in; read the second column as the sidebar.
  const cases: ReadonlyArray<{ what: string; agents: readonly string[]; names: readonly string[] }> = [
    { what: 'no agent at all is still one worktree', agents: [], names: ['task'] },
    { what: 'one agent keeps the task name it would have had alone', agents: ['claude'], names: ['task'] },
    {
      what: 'two agents each carry the agent that runs in them',
      agents: ['claude', 'codex'],
      names: ['task claude', 'task codex']
    },
    {
      what: 'one agent run twice numbers from the second',
      agents: ['claude', 'claude'],
      names: ['task claude', 'task claude 2']
    },
    {
      what: 'three different agents',
      agents: ['claude', 'codex', 'cursor'],
      names: ['task claude', 'task codex', 'task cursor']
    },
    {
      what: 'a repeat among three',
      agents: ['claude', 'codex', 'claude'],
      names: ['task claude', 'task codex', 'task claude 2']
    },
    {
      what: 'three runs of one agent',
      agents: ['claude', 'claude', 'claude'],
      names: ['task claude', 'task claude 2', 'task claude 3']
    },
    {
      what: 'two of each, in the order the fan-out hands them over',
      agents: ['claude', 'codex', 'claude', 'codex'],
      names: ['task claude', 'task codex', 'task claude 2', 'task codex 2']
    }
  ]

  for (const { what, agents, names } of cases) {
    it(what, () => {
      expect(taskNamesForAgents('task', agents)).toEqual(names)
    })
  }

  // A `task claude 2` with no `task claude` beside it was the bug: the counter
  // counted a run the naming rule had skipped.
  it('never repeats a name, and never numbers a run without its unnumbered first', () => {
    for (const { agents } of cases) {
      const names = taskNamesForAgents('task', agents)
      expect(names).toHaveLength(Math.max(1, agents.length))
      expect(new Set(names).size).toBe(names.length)
      for (const name of names) {
        // Only the rule under test can put a digit on the end of `task`.
        const unnumbered = name.replace(/ \d+$/, '')
        if (unnumbered !== name) expect(names).toContain(unnumbered)
      }
    }
  })

  it('slugifies into branch names with the same two properties', () => {
    expect(taskNamesForAgents('task', ['claude', 'codex', 'claude']).map(slugify)).toEqual([
      'task-claude',
      'task-codex',
      'task-claude-2'
    ])
    for (const { agents } of cases) {
      const branches = taskNamesForAgents('task', agents).map(slugify)
      expect(new Set(branches).size).toBe(branches.length)
      for (const branch of branches) {
        const unnumbered = branch.replace(/-\d+$/, '')
        if (unnumbered !== branch) expect(branches).toContain(unnumbered)
      }
    }
  })

  // The suffix distinguishes runs; what the repository holds is the allocator's job.
  it('leaves collisions with existing branches to the allocator', () => {
    const taken: string[] = []
    for (const name of taskNamesForAgents('task', ['claude', 'codex', 'claude'])) {
      taken.push(allocateBranchName(name, taken))
    }
    expect(taken).toEqual(['task-claude', 'task-codex', 'task-claude-2'])

    const second: string[] = [...taken]
    const names = taskNamesForAgents('task', ['claude', 'codex']).map((name) => {
      const branch = allocateBranchName(name, second)
      second.push(branch)
      return branch
    })
    expect(names).toEqual(['task-claude-3', 'task-codex-2'])
  })
})

describe('child names', () => {
  it('hang the slug off the parent branch with --, and count up when taken', () => {
    expect(allocateChildBranchName('rework-auth', 'Write migration', [])).toBe('rework-auth--write-migration')
    expect(allocateChildBranchName('feat/auth', 'tests', ['feat/auth--tests'])).toBe('feat/auth--tests-2')
  })

  it('put the checkout beside the parent, named after its directory and the branch tail', () => {
    expect(childCheckoutDirName('/wt/app/rework-auth-2', 'rework-auth', 'rework-auth--tests-2')).toBe(
      'rework-auth-2--tests-2'
    )
    expect(childCheckoutDirName('/wt/app/feat-auth', 'feat/auth', 'feat/auth--x')).toBe('feat-auth--x')
    expect(childCheckoutDirName('/wt/app/a', 'a', 'mine/own')).toBe('a--mine-own')
  })
})
