// The acceptance test for milestone 1: the whole product, driven the way an
// agent would drive it. Nothing is mocked. The runtime runs as a real process,
// git runs against a real repository, and every assertion goes through the
// built CLI over the same socket a coding agent would use.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Project, Terminal, Worktree, WorktreeChanges, WorktreeDiff, WorktreeStatus } from '../src/shared/entities'

const CLI = join(process.cwd(), 'out/cli/index.js')
const HOST = join(process.cwd(), 'scripts/acceptance-host.mjs')

let root: string
let repoPath: string
let userDataDir: string
let host: ChildProcess
let env: NodeJS.ProcessEnv

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Runs one CLI command and returns its single JSON document's payload. */
function cli<T>(args: string[]): T {
  const stdout = execFileSync('node', [CLI, ...args, '--json'], { encoding: 'utf8', env })
  return (JSON.parse(stdout) as { data: T }).data
}

function git(args: string[], cwd: string): void {
  execFileSync('git', ['-c', 'user.email=test@teamree.local', '-c', 'user.name=teamree test', ...args], { cwd })
}

beforeAll(async () => {
  if (!existsSync(CLI)) throw new Error('run `npm run build:cli` before the acceptance suite')

  root = mkdtempSync(join(tmpdir(), 'teamree-acceptance-'))
  repoPath = join(root, 'demo-repo')
  userDataDir = join(root, 'userdata')
  mkdirSync(userDataDir, { recursive: true })
  env = { ...process.env, TEAMREE_USER_DATA_DIR: userDataDir }

  execFileSync('git', ['init', '-b', 'main', repoPath])
  writeFileSync(join(repoPath, 'README.md'), '# demo\n')
  git(['add', '.'], repoPath)
  git(['commit', '-m', 'initial'], repoPath)

  host = spawn('npx', ['tsx', HOST], { env, stdio: ['ignore', 'pipe', 'pipe'] })

  const discovery = join(userDataDir, 'runtime.json')
  for (let attempt = 0; attempt < 160 && !existsSync(discovery); attempt += 1) await sleep(250)
  if (!existsSync(discovery)) throw new Error('runtime never published a discovery file')
}, 90_000)

afterAll(async () => {
  host?.kill('SIGTERM')
  await sleep(500)
  rmSync(root, { recursive: true, force: true })
})

describe('milestone 1 acceptance', () => {
  let project: Project
  let worktree: Worktree
  let terminal: Terminal

  it('reports a running runtime through the CLI', () => {
    const status = cli<{ version: string; pid: number }>(['status'])
    expect(status.pid).toBeGreaterThan(0)
  })

  it('adds the repository as a project and detects its base ref', () => {
    project = cli<Project>(['project', 'add', repoPath])
    expect(project.baseRef).toBe('main')
    expect(cli<Project[]>(['project', 'list'])).toHaveLength(1)
  })

  it('creates a worktree in the background and settles it to ready', async () => {
    const created = cli<Worktree>(['worktree', 'create', '--project', project.id, '--name', 'login fix'])
    // Creation must not block the caller, so the first answer is always 'creating'.
    expect(created.state).toBe('creating')
    expect(created.branch).toBe('login-fix')

    for (let attempt = 0; attempt < 120; attempt += 1) {
      await sleep(250)
      const found = cli<Worktree[]>(['worktree', 'list']).find((row) => row.id === created.id)
      if (found && found.state !== 'creating') {
        worktree = found
        break
      }
    }

    expect(worktree?.state, worktree?.error).toBe('ready')
    expect(existsSync(worktree.path)).toBe(true)
  }, 60_000)

  it('gives a second worktree of the same name its own branch', () => {
    const second = cli<Worktree>(['worktree', 'create', '--project', project.id, '--name', 'login fix'])
    expect(second.branch).toBe('login-fix-2')
  })

  it('reports live git status for a dirty worktree', () => {
    writeFileSync(join(worktree.path, 'scratch.txt'), 'work in progress\n')
    const status = cli<WorktreeStatus>(['worktree', 'status', worktree.id])
    expect(status.untracked).toBe(1)
    expect(status.branch).toBe(worktree.branch)
  })

  it('names the changed paths and prints the patch for one of them', () => {
    // scratch.txt is untracked, which is the case plain `git diff` answers with
    // silence — and the case a fresh branch is usually full of.
    const changes = cli<WorktreeChanges>(['worktree', 'changes', worktree.id])
    expect(changes.changes.map((change) => change.path)).toContain('scratch.txt')
    expect(changes.changes.find((change) => change.path === 'scratch.txt')?.kind).toBe('untracked')

    const diff = cli<WorktreeDiff>(['worktree', 'diff', worktree.id, '--path', 'scratch.txt'])
    expect(diff.patch).toContain('work in progress')
  })

  it('says whether the worktree would merge back without trying it', () => {
    const preview = cli<WorktreeMergePreview>(['worktree', 'merges', worktree.id])
    // Nothing has been committed on this branch, so it merges cleanly — and
    // asking must leave the repository exactly as it was.
    expect(preview.state).toBe('clean')
    expect(preview.baseRef).toBe(project.baseRef)
    expect(cli<WorktreeStatus>(['worktree', 'status', worktree.id]).conflicted).toBe(0)
  })

  it('opens a terminal in the worktree checkout', () => {
    terminal = cli<Terminal>(['terminal', 'create', '--worktree', worktree.id])
    expect(terminal.cwd).toBe(worktree.path)
    expect(terminal.running).toBe(true)
  })

  it('runs a command in the terminal and reads the output back', async () => {
    cli([
      'terminal',
      'send',
      terminal.id,
      '--text',
      'echo TEAMREE_MARKER_OK; git rev-parse --abbrev-ref HEAD',
      '--enter'
    ])
    await sleep(3000)
    const { data } = cli<{ data: string }>(['terminal', 'read', terminal.id])
    expect(data).toContain('TEAMREE_MARKER_OK')
    // Proves the pane really is inside this worktree, not the primary checkout.
    expect(data).toContain(worktree.branch)
  }, 30_000)

  it('splits a terminal into a two-pane layout', () => {
    const split = cli<{ terminal: Terminal; layout: { root: { kind: string; children?: unknown[] } } }>([
      'terminal',
      'split',
      terminal.id,
      '--direction',
      'row'
    ])
    expect(split.layout.root.kind).toBe('split')
    expect(split.layout.root.children).toHaveLength(2)
    expect(cli<Terminal[]>(['terminal', 'list'])).toHaveLength(2)
  })

  it('runs a command to completion and reports its real exit code', () => {
    // The deterministic path an agent should use: the command owns its process,
    // so completion is a real exit rather than a guess from output going quiet.
    const result = cli<{ exitCode: number | null; output: string }>([
      'terminal',
      'run',
      '--worktree',
      worktree.id,
      '--command',
      'sh -c "sleep 1; echo BUILD_DONE; exit 3"'
    ])
    expect(result.exitCode).toBe(3)
    expect(result.output).toContain('BUILD_DONE')
  }, 30_000)

  it('waits for a worktree to settle before reporting it ready', () => {
    const created = cli<Worktree>(['worktree', 'create', '--project', project.id, '--name', 'wait target'])
    expect(created.state).toBe('creating')

    const settled = cli<Worktree>(['worktree', 'wait', created.id])
    expect(settled.state).toBe('ready')
  }, 60_000)

  it('removes a worktree and its branch', () => {
    cli(['worktree', 'remove', worktree.id, '--force', '--delete-branch'])
    const remaining = cli<Worktree[]>(['worktree', 'list'])
    expect(remaining.find((row) => row.id === worktree.id)).toBeUndefined()
  })
})
