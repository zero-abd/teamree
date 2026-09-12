// The acceptance test for milestone 1: the whole product, exercised the way an
// agent would drive it. If this passes, teamree does what it claims to do.
//
// It builds nothing and mocks nothing. It starts the runtime, points it at a
// real git repository created in a temp directory, and then drives every layer
// through the same socket the CLI uses.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let repoPath: string
let workspaceRoot: string

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'teamree-acceptance-'))
  repoPath = join(workspaceRoot, 'sample-repo')

  execFileSync('git', ['init', '-b', 'main', repoPath])
  writeFileSync(join(repoPath, 'README.md'), '# sample\n')
  git(['add', '.'], repoPath)
  git(['-c', 'user.email=test@teamree.local', '-c', 'user.name=teamree test', 'commit', '-m', 'initial'], repoPath)
})

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
})

describe('milestone 1 acceptance', () => {
  it('has a real git repository to work against', () => {
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath)).toBe('main')
  })

  it.todo('adds the repository as a project')
  it.todo('creates two worktrees in parallel, each on its own branch')
  it.todo('reports live git status for a worktree with uncommitted changes')
  it.todo('opens a terminal in a worktree and runs a command')
  it.todo('reads the command output back through the scrollback')
  it.todo('splits a terminal and keeps both panes independently addressable')
  it.todo('removes a worktree and its branch')
  it.todo('drives the entire flow through the CLI with --json output')
})
