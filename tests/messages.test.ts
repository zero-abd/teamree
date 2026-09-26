// Agents talking end to end: a real runtime and real panes, each running the scripted
// stand-in agent (never a real one), which asks, answers and reports done through the
// built CLI over the socket.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error -- untyped .mjs, deliberately outside the TypeScript build.
import { childEnv } from '../scripts/child-env.mjs'
import type { Project, Terminal, Worktree } from '../src/shared/entities'
import type { TaskMessage } from '../src/shared/messages'

const CLI = join(process.cwd(), 'out/cli/index.js')
const HOST = join(process.cwd(), 'scripts/acceptance-host.mjs')
const STAND_IN = join(process.cwd(), 'tests/fixtures/agents/stand-in.mjs')

let root: string
let userDataDir: string
let host: ChildProcess
let env: NodeJS.ProcessEnv
let project: Project
let claude: string

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function cli<T>(args: string[]): T {
  const stdout = execFileSync('node', [CLI, ...args, '--json'], { encoding: 'utf8', env, cwd: root })
  return (JSON.parse(stdout) as { data: T }).data
}

async function eventually<T>(read: () => T, done: (value: T) => boolean, ms = 45_000): Promise<T> {
  const deadline = Date.now() + ms
  let value = read()
  while (!done(value) && Date.now() < deadline) {
    await sleep(300)
    value = read()
  }
  return value
}

function script(name: string, lines: string[]): string {
  const path = join(root, `${name}.script`)
  writeFileSync(path, `${lines.join('\n')}\n`)
  return path
}

async function worktree(name: string): Promise<Worktree> {
  const created = cli<Worktree>(['worktree', 'create', '--project', project.id, '--name', name])
  return eventually(
    () => cli<Worktree[]>(['worktree', 'list']).find((row) => row.id === created.id) as Worktree,
    (row) => row.state !== 'creating'
  )
}

/** A stand-in pane in `worktree`, started by absolute path so no login shell can find a real agent. */
function standIn(target: Worktree, scriptPath: string): Terminal {
  return cli<Terminal>([
    'terminal',
    'create',
    '--worktree',
    target.id,
    '--command',
    `TEAMREE_STAND_IN_SCRIPT=${scriptPath} ${claude}`
  ])
}

const screen = (terminalId: string): string => cli<{ data: string }>(['terminal', 'read', terminalId]).data

const children = (parent: Worktree): Worktree[] =>
  cli<Worktree[]>(['worktree', 'list']).filter((row) => row.parentId === parent.id)

beforeAll(async () => {
  if (!existsSync(CLI)) throw new Error('run `npm run build:cli` before the acceptance suite')
  root = mkdtempSync(join(tmpdir(), 'teamree-messages-'))
  userDataDir = join(root, 'userdata')
  mkdirSync(join(root, 'bin'), { recursive: true })
  claude = join(root, 'bin', 'claude')
  chmodSync(STAND_IN, 0o755)
  symlinkSync(STAND_IN, claude)
  env = { ...childEnv(process.env), TEAMREE_USER_DATA_DIR: userDataDir, TEAMREE_STAND_IN_CLI: CLI }

  const repoPath = join(root, 'repo')
  execFileSync('git', ['init', '-b', 'main', repoPath])
  const git = (args: string[]): void => {
    execFileSync('git', ['-c', 'user.email=test@teamree.local', '-c', 'user.name=teamree test', ...args], {
      cwd: repoPath
    })
  }
  writeFileSync(join(repoPath, 'README.md'), 'limits\n')
  git(['add', '.'])
  git(['commit', '-m', 'initial'])

  host = spawn('npx', ['tsx', HOST], { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
  const discovery = join(userDataDir, 'runtime.json')
  for (let attempt = 0; attempt < 160 && !existsSync(discovery); attempt += 1) await sleep(250)
  if (!existsSync(discovery)) throw new Error('runtime never published a discovery file')
  project = cli<Project>(['project', 'add', repoPath])
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

/** The CLI as an agent in `worktree` would run it. */
function cliAs<T>(worktree: Worktree, args: string[]): T {
  const stdout = execFileSync('node', [CLI, ...args, '--json'], {
    encoding: 'utf8',
    env: { ...env, TEAMREE_WORKTREE_ID: worktree.id },
    cwd: root
  })
  return (JSON.parse(stdout) as { data: T }).data
}

describe('agents talking over the socket', () => {
  it('a supervising parent makes two children, answers their asks, and waits for both to be done', async () => {
    const child = script('child', [
      'after 0.5s ask parent "Which store for the limiter?" options redis,postgres',
      'after 0.5s done "Added the limiter. Tests pass. Nothing left."'
    ])
    const lead = await worktree('Rate limits')
    const pane = standIn(
      lead,
      script('lead', [
        'on "[teamree] ask" reply "postgres"',
        `child tests ${child} "Write the limiter tests"`,
        `child docs ${child} "Document the limiter"`,
        'supervise 2'
      ])
    )

    const seen = await eventually(
      () => screen(pane.id),
      (text) => text.includes('all 2 children done')
    )
    expect(seen).toContain('all 2 children done')
    expect(seen.match(/done \(succeeded\): Added the limiter/g)).toHaveLength(2)
    // Pulled by `msg wait`, so never pasted as well.
    expect(seen).not.toContain('> [teamree]')

    const kids = children(lead)
    expect(kids.map((row) => row.name).sort()).toEqual(['docs', 'tests'])
    for (const kid of kids) {
      expect(kid.report).toMatchObject({
        outcome: 'succeeded',
        summary: 'Added the limiter. Tests pass. Nothing left.'
      })
      // Each child's blocking ask came back with the parent's answer.
      const kidPane = cli<Terminal[]>(['terminal', 'list', '--worktree', kid.id])[0] as Terminal
      expect(screen(kidPane.id)).toContain('⎿ postgres')
    }
    expect(cliAs<TaskMessage[]>(lead, ['msg', 'inbox'])).toEqual([])
  }, 120_000)

  it('pastes into an idle parent: the ask, and then the done', async () => {
    const lead = await worktree('Queue work')
    const child = script('worker', [
      'after 0.5s ask parent "SQS or Redis streams?" options sqs,redis',
      'after 0.5s done "Wired the queue. One consumer."'
    ])
    const pane = standIn(
      lead,
      script('idle-lead', ['on "[teamree] ask" reply "sqs"', `child worker ${child} "Wire the queue"`])
    )

    const seen = await eventually(
      () => screen(pane.id),
      (text) => text.includes('done (succeeded): Wired the queue')
    )
    expect(seen).toMatch(/> \[teamree\] ask #\d+ from "worker": SQS or Redis streams\? \(sqs \| redis\)/)
    expect(seen).toMatch(
      /> \[teamree\] "worker" done \(succeeded\): Wired the queue\. One consumer\. Files: \d+\. Merge: teamree worktree land /
    )
    const worker = children(lead)[0] as Worktree
    const workerPane = cli<Terminal[]>(['terminal', 'list', '--worktree', worker.id])[0] as Terminal
    expect(screen(workerPane.id)).toContain('⎿ sqs')
    // Delivered by paste, so nothing is left to pull.
    expect(cliAs<TaskMessage[]>(lead, ['msg', 'inbox'])).toEqual([])
  }, 120_000)

  it('asks you when there is no parent, and takes the first answer only', async () => {
    const top = await worktree('Ship it')
    const pane = standIn(top, script('asker', ['after 0.5s ask parent "Ship it?" options yes,no']))
    const inbox = await eventually(
      () => cli<TaskMessage[]>(['msg', 'inbox']),
      (list) => list.some((message) => message.text === 'Ship it?')
    )
    const ask = inbox.find((message) => message.text === 'Ship it?') as TaskMessage
    expect(ask).toMatchObject({ kind: 'ask', to: { you: true }, options: ['yes', 'no'], from: { worktreeId: top.id } })

    cli(['msg', 'reply', String(ask.id), 'yes'])
    expect(
      await eventually(
        () => screen(pane.id),
        (text) => text.includes('⎿ yes')
      )
    ).toContain('⎿ yes')
    const again = spawnSync('node', [CLI, 'msg', 'reply', String(ask.id), 'no'], { encoding: 'utf8', env, cwd: root })
    expect(again.status).toBe(1)
    expect(again.stderr).toContain('already answered by you')
  }, 120_000)
})
