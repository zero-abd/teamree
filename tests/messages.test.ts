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

/** Every wait below is on an event the runtime reports; this only bounds a hang. */
const WAIT_MS = 90_000

function cli<T>(args: string[]): T {
  const stdout = execFileSync('node', [CLI, ...args, '--json'], { encoding: 'utf8', env, cwd: root })
  return (JSON.parse(stdout) as { data: T }).data
}

async function eventually<T>(read: () => T, done: (value: T) => boolean, ms = WAIT_MS): Promise<T> {
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

function worktree(name: string): Worktree {
  const created = cli<Worktree>(['worktree', 'create', '--project', project.id, '--name', name])
  return cli<Worktree>(['worktree', 'wait', created.id, '--timeout-ms', String(WAIT_MS)])
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

/** Blocks until the stand-in in `pane` has left, which its script does only once its work is done. */
function exited(pane: Terminal, ...alsoShow: Terminal[]): void {
  try {
    cli(['terminal', 'wait', pane.id, '--for', 'exit', '--timeout-ms', String(WAIT_MS)])
  } catch (error) {
    const screens = [pane, ...alsoShow].map((shown) => `--- ${shown.id}\n${screen(shown.id)}`).join('\n')
    throw new Error(`${pane.id} never exited\n${screens}`, { cause: error })
  }
}

const paneOf = (target: Worktree): Terminal =>
  cli<Terminal[]>(['terminal', 'list', '--worktree', target.id])[0] as Terminal

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
  it('a supervising parent makes two children, answers their asks, and waits for both to be done', () => {
    const child = script('child', [
      'ask parent "Which store for the limiter?" options redis,postgres',
      'done "Added the limiter. Tests pass. Nothing left."',
      'exit'
    ])
    const lead = worktree('Rate limits')
    const pane = standIn(
      lead,
      script('lead', [
        'on "[teamree] ask" reply "postgres"',
        `child tests ${child} "Write the limiter tests"`,
        `child docs ${child} "Document the limiter"`,
        'supervise 2',
        'exit'
      ])
    )

    exited(pane)
    const seen = screen(pane.id)
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
      const kidPane = paneOf(kid)
      exited(kidPane)
      expect(screen(kidPane.id)).toContain('⎿ postgres')
    }
    expect(cliAs<TaskMessage[]>(lead, ['msg', 'inbox'])).toEqual([])
  }, 240_000)

  it('pastes into an idle parent: the ask, and then the done', () => {
    const lead = worktree('Queue work')
    const child = script('worker', [
      'ask parent "SQS or Redis streams?" options sqs,redis',
      'done "Wired the queue. One consumer."',
      'exit'
    ])
    const pane = standIn(
      lead,
      script('idle-lead', [
        'on "[teamree] ask" reply "sqs"',
        'on "done (succeeded)" exit',
        `child worker ${child} "Wire the queue"`
      ])
    )

    exited(pane)
    const seen = screen(pane.id)
    expect(seen).toMatch(/> \[teamree\] ask #\d+ from "worker": SQS or Redis streams\? \(sqs \| redis\)/)
    expect(seen).toMatch(
      /> \[teamree\] "worker" done \(succeeded\): Wired the queue\. One consumer\. Files: \d+\. Merge: teamree worktree land /
    )
    const workerPane = paneOf(children(lead)[0] as Worktree)
    exited(workerPane)
    expect(screen(workerPane.id)).toContain('⎿ sqs')
    // Delivered by paste, so nothing is left to pull.
    expect(cliAs<TaskMessage[]>(lead, ['msg', 'inbox'])).toEqual([])
  }, 240_000)

  it('asks you when there is no parent, and takes the first answer only', async () => {
    const top = worktree('Ship it')
    const pane = standIn(top, script('asker', ['ask parent "Ship it?" options yes,no', 'exit']))
    const inbox = await eventually(
      () => cli<TaskMessage[]>(['msg', 'inbox']),
      (list) => list.some((message) => message.text === 'Ship it?')
    )
    const ask = inbox.find((message) => message.text === 'Ship it?') as TaskMessage
    expect(ask).toMatchObject({ kind: 'ask', to: { you: true }, options: ['yes', 'no'], from: { worktreeId: top.id } })

    cli(['msg', 'reply', String(ask.id), 'yes'])
    exited(pane)
    expect(screen(pane.id)).toContain('⎿ yes')
    const again = spawnSync('node', [CLI, 'msg', 'reply', String(ask.id), 'no'], { encoding: 'utf8', env, cwd: root })
    expect(again.status).toBe(1)
    expect(again.stderr).toContain('already answered by you')
  }, 240_000)
})
