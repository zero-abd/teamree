// The whole product driven the way an agent would: a real runtime process, a real repository, and every
// assertion through the built CLI over the agent's socket. Nothing is mocked.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
// @ts-expect-error -- untyped .mjs, deliberately outside the TypeScript build.
import { childEnv } from '../scripts/child-env.mjs'
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
import type { WorktreeNest } from '../src/shared/nesting'
import { PANE_IDENTITY_ENV } from '../src/shared/tasks'

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
  env = { ...childEnv(process.env), TEAMREE_USER_DATA_DIR: userDataDir }

  execFileSync('git', ['init', '-b', 'main', repoPath])
  // On the repository itself: the app commits through its own CLI with the machine's identity, which a
  // fresh runner lacks.
  git(['config', 'user.email', 'test@teamree.local'], repoPath)
  git(['config', 'user.name', 'teamree test'], repoPath)
  writeFileSync(join(repoPath, 'README.md'), '# demo\n')
  git(['add', '.'], repoPath)
  git(['commit', '-m', 'initial'], repoPath)

  // Its own process group: `npx` does not pass signals down, and orphaned runtimes once exhausted the
  // inotify limit. stdin is a pipe so the runtime notices this process going (acceptance-host.mjs).
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
      // Already gone.
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
    // Inside this run's directory, not `~/.teamree/worktrees`, so concurrent runs cannot pick the same name.
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
    // Untracked, which plain `git diff` answers with silence.
    const changes = cli<WorktreeChanges>(['worktree', 'changes', worktree.id])
    expect(changes.changes.map((change) => change.path)).toContain('scratch.txt')
    expect(changes.changes.find((change) => change.path === 'scratch.txt')?.kind).toBe('untracked')

    const diff = cli<WorktreeDiff>(['worktree', 'diff', worktree.id, '--path', 'scratch.txt'])
    expect(diff.patch).toContain('work in progress')
  })

  it('commits only the path it was given, and says what landed', () => {
    writeFileSync(join(worktree.path, 'kept.txt'), 'keep me\n')
    // No `--`: it would swallow the --json the harness appends.
    const committed = cli<WorktreeCommit>(['worktree', 'commit', worktree.id, '--message', 'keep this one', 'kept.txt'])

    expect(committed.paths).toEqual(['kept.txt'])
    expect(committed.shortSha).toHaveLength(7)
    // scratch.txt was never named, so it is still sitting there untracked.
    const after = cli<WorktreeChanges>(['worktree', 'changes', worktree.id])
    expect(after.changes.map((change) => change.path)).toContain('scratch.txt')
    expect(after.changes.map((change) => change.path)).not.toContain('kept.txt')
  })

  it('shows what the worktree committed, which nothing else would say', () => {
    const log = cli<WorktreeLog>(['worktree', 'log', worktree.id])
    expect(log.commits.map((commit) => commit.subject)).toContain('keep this one')
    expect(log.commits[0]?.shortSha).toHaveLength(7)
  })

  it('says whether the worktree would merge back without trying it', () => {
    const preview = cli<WorktreeMergePreview>(['worktree', 'merges', worktree.id])
    // One commit above, so it merges cleanly, and asking must leave the repository untouched.
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

    // Polled against a wall-clock budget, not slept: a loaded machine should report "never came", not a
    // slow pane as a defect, and a turn count overran the case's own timeout.
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
    // The deterministic path: the command owns its process, so completion is a real exit.
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
    // Removing the worktree must close its panes (nothing else will); polled, since the close starts off
    // the worktree.removed event.
    let stranded = cli<Terminal[]>(['terminal', 'list']).filter((row) => row.worktreeId === worktree.id)
    for (let attempt = 0; attempt < 20 && stranded.length > 0; attempt += 1) {
      await sleep(250)
      stranded = cli<Terminal[]>(['terminal', 'list']).filter((row) => row.worktreeId === worktree.id)
    }
    expect(stranded).toEqual([])
  }, 30_000)
})

describe('child worktrees', () => {
  let project: Project
  let parent: Worktree
  let child: Worktree
  const deeper: Worktree[] = []

  const settle = (created: Worktree): Worktree => cli<Worktree>(['worktree', 'wait', created.id])
  const refusal = (args: string[], extra: NodeJS.ProcessEnv = {}): { code: string; message: string } => {
    const failed = spawnSync('node', [CLI, ...args, '--json'], { encoding: 'utf8', env: { ...env, ...extra } })
    expect(failed.status).not.toBe(0)
    return (JSON.parse(failed.stderr || failed.stdout) as { error: { code: string; message: string } }).error
  }

  beforeAll(() => {
    project = cli<Project[]>(['project', 'list']).find((row) => row.path === realpathSync(repoPath)) as Project
  })

  it("branches a child from its parent over the socket, and logs only the child's commits", () => {
    parent = settle(cli<Worktree>(['worktree', 'create', '--project', project.id, '--name', 'rework auth']))
    writeFileSync(join(parent.path, 'auth.txt'), 'parent\n')
    git(['add', '.'], parent.path)
    git(['commit', '-m', 'parent work'], parent.path)

    const created = cli<Worktree>(['worktree', 'create', '--parent', parent.id, '--name', 'migration'])
    expect(created).toMatchObject({ parentId: parent.id, branch: 'rework-auth--migration', baseRef: 'rework-auth' })
    child = settle(created)
    expect(child.path).toBe(join(dirname(parent.path), 'rework-auth--migration'))
    writeFileSync(join(child.path, 'migration.sql'), 'create table\n')
    git(['add', '.'], child.path)
    git(['commit', '-m', 'child work'], child.path)

    const log = cli<WorktreeLog>(['worktree', 'log', child.id])
    expect(log.baseRef).toBe('rework-auth')
    expect(log.commits.map((commit) => commit.subject)).toEqual(['child work'])
  }, 60_000)

  it('stops an agent three deep, with here read from the pane', () => {
    const pane = (worktree: Worktree): NodeJS.ProcessEnv => ({
      [PANE_IDENTITY_ENV.worktreeId]: worktree.id,
      [PANE_IDENTITY_ENV.terminalId]: 'term_acceptance'
    })
    const inPane = (worktree: Worktree, name: string): Worktree => {
      const stdout = execFileSync('node', [CLI, 'worktree', 'create', '--parent', 'here', '--name', name, '--json'], {
        encoding: 'utf8',
        env: { ...env, ...pane(worktree) }
      })
      return settle((JSON.parse(stdout) as { data: Worktree }).data)
    }
    const grandchild = inPane(child, 'seed')
    expect(grandchild.parentId).toBe(child.id)
    const third = inPane(grandchild, 'fixtures')
    deeper.push(grandchild, third)

    expect(refusal(['worktree', 'create', '--name', 'too deep'], pane(third))).toMatchObject({
      code: 'child_limit',
      message: '3 deep under rework auth'
    })
  }, 60_000)

  it('lists the tree indented', () => {
    const text = execFileSync('node', [CLI, 'worktree', 'list', '--tree', '--project', project.id], {
      encoding: 'utf8',
      env
    })
    const indent = (worktree: Worktree): number => {
      const line = text.split('\n').find((row) => row.startsWith(worktree.id)) ?? ''
      return /^ */.exec(line.slice(worktree.id.length + 2))?.[0].length ?? -1
    }
    expect([parent, child, ...deeper].map(indent)).toEqual([0, 2, 4, 6])
  })

  it('refuses to remove a parent alone, and with --children takes the whole tree', () => {
    expect(refusal(['worktree', 'remove', parent.id, '--force']).code).toBe('conflict')
    cli(['worktree', 'remove', parent.id, '--force', '--children'])
    const left = cli<Worktree[]>(['worktree', 'list']).map((row) => row.name)
    expect(left).not.toContain('rework auth')
    expect(left).not.toContain('migration')
    expect(left).not.toContain('fixtures')
  }, 60_000)
})

describe('nesting an existing worktree', () => {
  let project: Project
  let parent: Worktree

  const settle = (created: Worktree): Worktree => cli<Worktree>(['worktree', 'wait', created.id])
  const committed = (name: string, file: string, from?: string): Worktree => {
    const worktree = settle(
      cli<Worktree>(['worktree', 'create', '--project', project.id, '--name', name, ...(from ? ['--from', from] : [])])
    )
    writeFileSync(join(worktree.path, file), `${name}\n`)
    git(['add', '.'], worktree.path)
    git(['commit', '-m', name], worktree.path)
    return worktree
  }
  const listed = (worktree: Worktree): Worktree =>
    cli<Worktree[]>(['worktree', 'list']).find((row) => row.id === worktree.id) as Worktree
  const head = (worktree: Worktree): string =>
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree.path, encoding: 'utf8' }).trim()
  const refusal = (args: string[]): { code: string; message: string } => {
    const failed = spawnSync('node', [CLI, ...args, '--json'], { encoding: 'utf8', env })
    expect(failed.status).not.toBe(0)
    return (JSON.parse(failed.stderr || failed.stdout) as { error: { code: string; message: string } }).error
  }

  beforeAll(() => {
    project = cli<Project[]>(['project', 'list']).find((row) => row.path === realpathSync(repoPath)) as Project
    parent = committed('api layer', 'api.txt')
  }, 60_000)

  it("moves a branch holding the parent's tip under it over the socket, and back to the top", () => {
    const client = committed('client', 'client.txt', parent.branch)
    const nested = cli<WorktreeNest>(['worktree', 'nest', client.id, '--under', parent.id])
    expect(nested).toMatchObject({ change: 'nest', worktree: { parentId: parent.id, baseRef: parent.branch } })
    expect(listed(client).parentId).toBe(parent.id)

    const text = execFileSync('node', [CLI, 'worktree', 'nest', client.id, '--top', '--dry-run'], {
      encoding: 'utf8',
      env
    })
    expect(text).toBe('would move client to the top level; 1 commit from api layer will show in the diff\n')
    expect(listed(client).parentId).toBe(parent.id)

    cli(['worktree', 'nest', client.id, '--top'])
    const top = listed(client)
    expect(top.parentId).toBeUndefined()
    expect(top.baseRef).toBeUndefined()
  }, 60_000)

  it('rebases only when asked, and refuses a conflict leaving the branch where it was', () => {
    const clashing = committed('clashing', 'api.txt')
    const before = head(clashing)
    expect(refusal(['worktree', 'nest', clashing.id, '--under', parent.id])).toMatchObject({
      code: 'conflict',
      message: 'Needs a rebase onto api-layer',
      data: { refusal: 'needsRebase' }
    })
    expect(refusal(['worktree', 'nest', clashing.id, '--under', parent.id, '--rebase'])).toMatchObject({
      code: 'conflict',
      message: 'Would conflict in 1 file',
      data: { refusal: 'conflicts', paths: ['api.txt'] }
    })
    expect(head(clashing)).toBe(before)

    const docs = committed('docs', 'docs.txt')
    const rebased = cli<WorktreeNest>(['worktree', 'nest', docs.id, '--under', parent.id, '--rebase'])
    expect(rebased).toMatchObject({ change: 'rebase', worktree: { parentId: parent.id } })
    const log = cli<WorktreeLog>(['worktree', 'log', docs.id])
    expect(log.commits.map((commit) => commit.subject)).toEqual(['docs'])
  }, 60_000)
})

describe('project clone', () => {
  let bare: string

  beforeAll(() => {
    // Local only: nothing in this suite reaches the network.
    bare = join(root, 'shared.git')
    execFileSync('git', ['clone', '--quiet', '--bare', repoPath, bare])
  })

  it('clones a local bare repository and adds the checkout as a project', () => {
    const into = join(root, 'clones', 'shared')
    const project = cli<Project>(['project', 'clone', bare, into])

    expect(project.name).toBe('shared')
    expect(project.path).toBe(realpathSync(into))
    expect(project.baseRef).toBe('origin/main')
    expect(existsSync(join(into, 'README.md'))).toBe(true)
    expect(cli<Project[]>(['project', 'list']).map((row) => row.id)).toContain(project.id)
  }, 60_000)

  it('says in one line why a clone did not happen, and adds nothing', () => {
    const before = cli<Project[]>(['project', 'list']).length
    const failed = spawnSync('node', [CLI, 'project', 'clone', bare, repoPath, '--json'], { encoding: 'utf8', env })

    expect(failed.status).not.toBe(0)
    const document = JSON.parse(failed.stderr || failed.stdout) as { error: { code: string; message: string } }
    expect(document.error.code).toBe('clone_failed')
    expect(document.error.message).toBe('Destination exists')
    expect(cli<Project[]>(['project', 'list'])).toHaveLength(before)
  }, 60_000)
})
