// The coordination ledger end to end: a real runtime, a real repository, two sibling
// worktrees changing the same line, and every read through the built CLI over the socket.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error -- untyped .mjs, deliberately outside the TypeScript build.
import { childEnv } from '../scripts/child-env.mjs'
import type { Project, Worktree } from '../src/shared/entities'
import type { WorktreeClaims } from '../src/shared/ledgerMethods'
import type { ProjectContext } from '../src/shared/memory'

const CLI = join(process.cwd(), 'out/cli/index.js')
const HOST = join(process.cwd(), 'scripts/acceptance-host.mjs')

let root: string
let repoPath: string
let userDataDir: string
let host: ChildProcess
let env: NodeJS.ProcessEnv
let project: Project
let a: Worktree
let b: Worktree

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function cli<T>(args: string[], cwd = root): T {
  const stdout = execFileSync('node', [CLI, ...args, '--json'], { encoding: 'utf8', env, cwd })
  return (JSON.parse(stdout) as { data: T }).data
}

function cliText(args: string[], cwd = root): string {
  return execFileSync('node', [CLI, ...args], { encoding: 'utf8', env, cwd })
}

function git(args: string[], cwd: string): void {
  execFileSync('git', ['-c', 'user.email=test@teamree.local', '-c', 'user.name=teamree test', ...args], { cwd })
}

/** The ledger re-reads git a few seconds after files move, so reads are polled against a deadline. */
async function eventually<T>(read: () => T, done: (value: T) => boolean, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms
  let value = read()
  while (!done(value) && Date.now() < deadline) {
    await sleep(500)
    value = read()
  }
  return value
}

// No --prompt: that needs an agent, and no agent runs here. The name stands in for the goal.
async function createWorktree(name: string): Promise<Worktree> {
  const created = cli<Worktree>(['worktree', 'create', '--project', project.id, '--name', name])
  return eventually(
    () => cli<Worktree[]>(['worktree', 'list']).find((row) => row.id === created.id) as Worktree,
    (row) => row.state !== 'creating'
  )
}

beforeAll(async () => {
  if (!existsSync(CLI)) throw new Error('run `npm run build:cli` before the acceptance suite')
  root = mkdtempSync(join(tmpdir(), 'teamree-context-'))
  repoPath = join(root, 'repo')
  userDataDir = join(root, 'userdata')
  mkdirSync(userDataDir, { recursive: true })
  env = { ...childEnv(process.env), TEAMREE_USER_DATA_DIR: userDataDir }

  execFileSync('git', ['init', '-b', 'main', repoPath])
  git(['config', 'user.email', 'test@teamree.local'], repoPath)
  git(['config', 'user.name', 'teamree test'], repoPath)
  writeFileSync(join(repoPath, 'README.md'), 'one\ntwo\nthree\n')
  git(['add', '.'], repoPath)
  git(['commit', '-m', 'initial'], repoPath)

  host = spawn('npx', ['tsx', HOST], { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
  const discovery = join(userDataDir, 'runtime.json')
  for (let attempt = 0; attempt < 160 && !existsSync(discovery); attempt += 1) await sleep(250)
  if (!existsSync(discovery)) throw new Error('runtime never published a discovery file')

  project = cli<Project>(['project', 'add', repoPath])
  a = await createWorktree('rate limits')
  b = await createWorktree('login fix')
}, 90_000)

afterAll(async () => {
  if (host?.pid !== undefined) {
    try {
      process.kill(-host.pid, 'SIGTERM')
    } catch {
      // Already gone.
    }
  }
  await sleep(500)
  rmSync(root, { recursive: true, force: true })
})

describe('teamree context over the socket', () => {
  it('says there is no overlap in one line, from inside the worktree', () => {
    expect(a.state).toBe('ready')
    expect(cliText(['context'], join(a.path))).toBe('No overlap.\n')
    expect(cliText(['context', '--text', '--worktree', a.id])).toBe('')
    // A pane's own identity picks the worktree wherever the command runs.
    const fromPane = execFileSync('node', [CLI, 'context', '--json'], {
      encoding: 'utf8',
      cwd: root,
      env: { ...env, TEAMREE_WORKTREE_ID: b.id }
    })
    expect(JSON.parse(fromPane).data.worktreeId).toBe(b.id)
  })

  it('names the sibling, the conflict merge-tree found, and the decision on that file', async () => {
    writeFileSync(join(a.path, 'README.md'), 'one\ntwo from a\nthree\n')
    git(['commit', '-am', 'a edits'], a.path)
    writeFileSync(join(b.path, 'README.md'), 'one\ntwo from b\nthree\n')
    git(['commit', '-am', 'b edits'], b.path)

    expect(cli<WorktreeClaims>(['claim', 'src/limits/**', '--worktree', a.id]).globs).toEqual(['src/limits/**'])
    cli(['note', 'README stays one screen', '--path', 'README.md', '--worktree', a.id])

    const context = await eventually(
      () => cli<ProjectContext>(['context', '--worktree', b.id]),
      (row) => (row.siblings[0]?.conflicts ?? []).length > 0
    )
    expect(context.self.goal).toBe('login fix')
    expect(context.siblings).toEqual([
      expect.objectContaining({
        worktreeId: a.id,
        name: 'rate limits',
        overlap: ['README.md'],
        conflicts: ['README.md'],
        decisions: [expect.objectContaining({ text: 'README stays one screen', paths: ['README.md'] })]
      })
    ])
    const textOnly = cli<ProjectContext>(['context', '--text', '--worktree', b.id])
    expect(textOnly.siblings).toEqual([])
    expect(textOnly.text).toContain('conflict: README.md')
    expect(cliText(['context', '--text', '--budget', '200', '--worktree', b.id])).toBe(
      [
        'goal: login fix',
        'sibling rate limits',
        '  conflict: README.md',
        '  decision: README stays one screen (README.md)',
        ''
      ].join('\n')
    )
  }, 40_000)

  it('forgets the decision once its worktree lands, and logs the landing on this machine', async () => {
    git(['merge', '--no-ff', '-m', 'land a', a.branch], repoPath)
    const context = await eventually(
      () => cli<ProjectContext>(['context', '--worktree', b.id]),
      (row) => row.text === ''
    )
    expect(context.siblings).toEqual([])

    // Written a moment after the answer: the file is read until it has caught up.
    const ledger = await eventually(
      () => JSON.parse(readFileSync(join(userDataDir, 'memory', `${project.id}.json`), 'utf8')),
      (row) => row.landings.length > 0,
      5_000
    )
    expect(ledger.notes).toEqual([])
    expect(ledger.landings).toEqual([
      expect.objectContaining({ worktreeId: a.id, into: 'main', conflicts: [], shared: ['README.md'] })
    ])
  }, 40_000)
})
