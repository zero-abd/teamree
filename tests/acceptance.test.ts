// The acceptance test for milestone 1: the whole product, driven the way an
// agent would drive it. Nothing is mocked. The runtime runs as a real process,
// git runs against a real repository, and every assertion goes through the
// built CLI over the same socket a coding agent would use.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  Project,
  Terminal,
  Worktree,
  WorktreeChanges,
  WorktreeCommit,
  WorktreeDiff,
  WorktreeLog,
  WorktreeMergePreview,
  WorktreeStatus
} from '../src/shared/entities'

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
  // On the repository itself, not just on this file's own git calls: the
  // commits that matter here are made by the app, through its own CLI, and it
  // uses whatever identity the machine has. A fresh CI runner has none, so a
  // fixture that configured only its own commands passed locally and failed
  // there with "Author identity unknown".
  git(['config', 'user.email', 'test@teamree.local'], repoPath)
  git(['config', 'user.name', 'teamree test'], repoPath)
  writeFileSync(join(repoPath, 'README.md'), '# demo\n')
  git(['add', '.'], repoPath)
  git(['commit', '-m', 'initial'], repoPath)

  // Its own process group, because `npx` puts two wrapper processes between us
  // and the runtime and does not pass a signal down to it. Killing the wrapper
  // left the runtime alive holding its socket, its discovery file and an inotify
  // instance — two orphans per run, and this suite runs often. They accumulated
  // until the per-user inotify limit was exhausted and every filesystem-watch
  // test on the machine began failing for reasons that had nothing to do with
  // the watcher.
  // stdin is a pipe rather than /dev/null, and nothing is ever written to it:
  // it is how the runtime learns this process has gone, so that a suite killed
  // part-way through does not leave a runtime behind holding a socket and a
  // discovery file. See `scripts/acceptance-host.mjs`.
  host = spawn('npx', ['tsx', HOST], { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })

  const discovery = join(userDataDir, 'runtime.json')
  for (let attempt = 0; attempt < 160 && !existsSync(discovery); attempt += 1) await sleep(250)
  if (!existsSync(discovery)) throw new Error('runtime never published a discovery file')
}, 90_000)

afterAll(async () => {
  // Negative pid: signal the whole group, so the runtime goes with the wrapper.
  if (host?.pid !== undefined) {
    try {
      process.kill(-host.pid, 'SIGTERM')
    } catch {
      // Already gone, which is the outcome this wanted anyway.
    }
  }
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
    // Inside this run's own directory and nowhere else. The checkout root is
    // not part of `userDataDir`, and left at its default it is the person's
    // `~/.teamree/worktrees` — shared with their real projects, with the smoke
    // script, and with every other copy of this suite running on the machine.
    // Two of those pick checkout names out of one directory while reading two
    // different stores, so they choose the same free name and one of them then
    // reads a path the other has taken or removed. Asserting the root here is
    // what keeps that from coming back: a run that can be run twice at once is
    // a run whose checkouts are somewhere only it can see.
    expect(worktree.path.startsWith(root)).toBe(true)
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

  it('commits only the path it was given, and says what landed', () => {
    writeFileSync(join(worktree.path, 'kept.txt'), 'keep me\n')
    // No `--` here: it would terminate flag parsing and swallow the --json the
    // harness appends, which is exactly what `--` is supposed to do. It is only
    // needed for a path that could be read as a flag.
    const committed = cli<WorktreeCommit>(['worktree', 'commit', worktree.id, '--message', 'keep this one', 'kept.txt'])

    expect(committed.paths).toEqual(['kept.txt'])
    expect(committed.shortSha).toHaveLength(7)
    // scratch.txt was never named, so it is still sitting there untracked.
    const after = cli<WorktreeChanges>(['worktree', 'changes', worktree.id])
    expect(after.changes.map((change) => change.path)).toContain('scratch.txt')
    expect(after.changes.map((change) => change.path)).not.toContain('kept.txt')
  })

  it('shows what the worktree committed, which nothing else would say', () => {
    // The commit above left the changes list empty for that path. Without a log
    // the app would have nothing at all to show for the work.
    const log = cli<WorktreeLog>(['worktree', 'log', worktree.id])
    expect(log.commits.map((commit) => commit.subject)).toContain('keep this one')
    expect(log.commits[0]?.shortSha).toHaveLength(7)
  })

  it('says whether the worktree would merge back without trying it', () => {
    const preview = cli<WorktreeMergePreview>(['worktree', 'merges', worktree.id])
    // One commit was made above, so there is something to merge and it merges
    // cleanly — and asking must leave the repository exactly as it was.
    expect(preview.state).toBe('clean')
    expect(preview.ahead).toBe(1)
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

    // Polled, like every other wait in this file, rather than slept against.
    // A shell is not on a schedule: a fixed sleep makes the deadline part of
    // the assertion, so a loaded machine — and this repository runs its suite
    // alongside packaging builds — reports a pane that was merely slow as a
    // product defect, and prints a missing marker instead of "it never came".
    // Polling makes the deadline the failure mode and costs nothing when the
    // shell answers in the usual few hundred milliseconds.
    //
    // The budget is wall-clock rather than a count of turns, because each turn
    // spawns the CLI: a fixed 80 turns costs 20s of sleeping plus however long
    // 80 process launches take, which overran the case's own timeout and
    // reported "test timed out" instead of showing what the pane did hold.
    let data = ''
    const ready = (): boolean => data.includes('TEAMREE_MARKER_OK') && data.includes(worktree.branch)
    const deadline = Date.now() + 20_000
    while (!ready() && Date.now() < deadline) {
      await sleep(250)
      data = cli<{ data: string }>(['terminal', 'read', terminal.id]).data
    }

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

  it("takes the removed worktree's terminals with it, rather than leaving them running", async () => {
    // The panes opened above were still running when the row went. Nothing
    // else closes them: the sidebar only walks worktrees and the dashboard
    // drops panes whose worktree is gone, so a pane left alive here is an
    // agent still working in a directory that no longer exists, reachable
    // only by id and still counted in the status bar.
    //
    // Polled rather than asserted at once: the close is started off the
    // worktree.removed event, so it is in flight while the remove is
    // answering.
    let stranded = cli<Terminal[]>(['terminal', 'list']).filter((row) => row.worktreeId === worktree.id)
    for (let attempt = 0; attempt < 20 && stranded.length > 0; attempt += 1) {
      await sleep(250)
      stranded = cli<Terminal[]>(['terminal', 'list']).filter((row) => row.worktreeId === worktree.id)
    }
    expect(stranded).toEqual([])
  }, 30_000)
})
