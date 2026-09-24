import { describe, expect, it } from 'vitest'
import { taskNamesForAgents } from '@shared/branchName'
import { taskName } from '../dialogs/taskPlan'
import { agentWords, paneInWorktree, worktreeDisplay, worktreeLabel } from './worktreeDisplay'

const TASK = 'Add a subtract function to src/math.ts'

/** What `startTask` stores for one run: the name `taskCreates` hands out, its slug as the branch. */
function run(name: string, task: string = TASK): { name: string; branch: string; task: string } {
  return { name, branch: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), task }
}

describe('worktreeDisplay', () => {
  // The stored name is cut to "Add a subtract function".
  it('names each run of a task by its agent and the whole task line', () => {
    const [claude, codex] = taskNamesForAgents(taskName(TASK), ['claude', 'codex']).map((name) => run(name))
    expect(worktreeDisplay(claude!)).toEqual({ agent: { text: 'claude', kind: 'claude' }, title: TASK })
    expect(worktreeDisplay(codex!)).toEqual({ agent: { text: 'codex', kind: 'codex' }, title: TASK })
  })

  it('still knows runs named before small words were dropped from a cut name', () => {
    expect(worktreeDisplay(run('Add a subtract function to claude'))).toEqual({
      agent: { text: 'claude', kind: 'claude' },
      title: TASK
    })
    expect(worktreeDisplay(run('Add a subtract function to'))).toEqual({ title: TASK })
  })

  it('keeps the counter with the agent and knows installed commands only for the glyph', () => {
    const names = taskNamesForAgents(taskName(TASK), ['claude', 'claude', 'kilocode'])
    const kindOf = agentWords([{ kind: 'kilo', command: 'kilocode', binary: '/bin/kilocode' }])
    expect(names.map((name) => worktreeDisplay(run(name), kindOf).agent)).toEqual([
      { text: 'claude', kind: 'claude' },
      { text: 'claude 2', kind: 'claude' },
      { text: 'kilocode', kind: 'kilo' }
    ])
    expect(worktreeDisplay(run(names[2]!))).toEqual({ agent: { text: 'kilocode' }, title: TASK })
  })

  it('shows a lone run by its task line, whole', () => {
    expect(worktreeDisplay(run(taskName(TASK)))).toEqual({ title: TASK })
    expect(worktreeDisplay(run('Fix the pager claude', 'Fix the pager claude.'))).toEqual({
      title: 'Fix the pager claude'
    })
  })

  it('splits a name given on the command line only at a word naming an agent', () => {
    expect(worktreeDisplay(run('perf claude 2', 'Speed up the build'))).toEqual({
      agent: { text: 'claude 2', kind: 'claude' },
      title: 'perf'
    })
    expect(worktreeDisplay(run('perf', 'Speed up the build'))).toEqual({ title: 'perf' })
  })

  it('keeps a renamed or taskless name whole, agent word and all', () => {
    expect(
      worktreeDisplay({ ...run('Subtract, the careful one'), branch: 'add-a-subtract-function-to-claude' })
    ).toEqual({
      title: 'Subtract, the careful one',
      branch: 'add-a-subtract-function-to-claude'
    })
    expect(worktreeDisplay({ name: 'pager claude', branch: 'pager-claude' })).toEqual({ title: 'pager claude' })
  })

  // `perf / perf`: a branch that is the name slugified says nothing the name does not.
  it('shows the branch only when it says more than the name', () => {
    expect(worktreeDisplay({ name: 'perf', branch: 'perf' }).branch).toBeUndefined()
    expect(worktreeDisplay({ name: 'Fix login', branch: 'fix-login' }).branch).toBeUndefined()
    expect(worktreeDisplay({ name: 'perf', branch: 'perf-2' }).branch).toBe('perf-2')
    expect(worktreeDisplay({ name: 'perf', branch: 'feature/perf' }).branch).toBe('feature/perf')
  })
})

describe('worktreeLabel', () => {
  // Where no glyph can be drawn: a dialog title, a tooltip, an accessible name.
  it('names the worktree by its title, and a run’s agent after it in words', () => {
    expect(worktreeLabel(worktreeDisplay(run(`${taskName(TASK)} claude`)))).toBe(`${TASK} (Claude Code)`)
    expect(worktreeLabel(worktreeDisplay(run(`${taskName(TASK)} codex 2`)))).toBe(`${TASK} (Codex 2)`)
    const kilo = taskNamesForAgents(taskName(TASK), ['kilocode'])[0]!
    expect(worktreeLabel(worktreeDisplay(run(`${kilo} kilocode`)))).toBe(`${TASK} (kilocode)`)
    expect(worktreeLabel(worktreeDisplay({ name: 'perf', branch: 'perf' }))).toBe('perf')
  })
})

describe('paneInWorktree', () => {
  const worktree = run(`${taskName(TASK)} claude`)

  it('gives the pane named after its worktree the worktree title', () => {
    expect(paneInWorktree({ label: worktree.name }, worktree).label).toBe(TASK)
  })

  it('leaves every other pane as it is', () => {
    const pane = { label: 'server' }
    expect(paneInWorktree(pane, worktree)).toBe(pane)
    expect(paneInWorktree({ label: worktree.name }, undefined).label).toBe(worktree.name)
  })
})
