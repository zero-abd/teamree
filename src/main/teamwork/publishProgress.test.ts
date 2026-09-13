// The four ways a push goes wrong that a panel has to be able to survive.
//
// This file exists because of a report — "the steps get stuck at git push as it
// doesn't show any updates" — and because every one of these cases used to look
// identical from the window: a button that said "Pushing…" and a wait of up to
// ten minutes with nothing behind it. So each of them is pinned here by what
// somebody can *see* while it happens and what they are told afterwards:
//
//   - a push that stalls, which must report git's own progress and the two
//     timestamps a panel counts a wait with;
//   - a push refused for credentials, which must come back naming the remedy
//     rather than "push failed";
//   - a push rejected non-fast-forward, which is the ordinary one — two people
//     joined at once — and must say to pull rather than to force;
//   - and Stop, which must actually end it and must still report the commit
//     that landed before it was stopped.
//
// The git here is scripted rather than real, and deliberately: a genuine stall
// is a test that takes as long as the thing it is testing, and a genuine
// credential refusal needs a remote that refuses credentials. What is being
// checked is this app's behaviour in the face of a git that behaves in each of
// those ways, which is exactly what a script can state.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Project } from '../../shared/entities'
import { GitCommandError } from '../git/errors'
import type { GitOutput, GitRun, GitRunner } from '../git/gitProcess'
import { TeamworkService } from './teamworkService'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** What the scripted git should do when it is asked to push. */
type PushScript = (run: GitRun) => Promise<GitOutput>

/**
 * A push that never finishes on its own, and ends the way a real one does when
 * it is killed.
 *
 * Honouring the signal is not decoration. `spawnGit` rejects with a cancelled
 * `GitCommandError` when the process is aborted, and a fake that merely hung
 * for ever would let a test pass that leaves `publish` waiting on a promise
 * nothing will settle — which is the very bug this file is about, reproduced in
 * the test harness instead of in the app.
 */
const stalls: PushScript = (run) =>
  new Promise<GitOutput>((_resolve, reject) => {
    run.signal?.addEventListener('abort', () => {
      reject(new GitCommandError({ args: run.args, cwd: run.cwd, exitCode: null, stderr: '', cancelled: true }))
    })
  })

type Fake = {
  service: TeamworkService
  project: Project
  /** Feeds a line to whatever `onStderr` the push was given, as git would. */
  say: (chunk: string) => void
  /** Moves the clock the service stamps everything with. */
  advance: (ms: number) => void
  now: () => number
}

/**
 * A git that answers every question `publish` asks and does whatever the script
 * says when it reaches the push.
 *
 * Every read here is the real command with the real arguments, because the
 * point is to exercise `publish` rather than a rewritten version of it: change
 * the order or the flags in `publish.ts` and the answers stop matching.
 */
async function wire(push: PushScript): Promise<Fake> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'teamree-publish-'))
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'teamree-publish-data-'))
  dirs.push(root, dataDir)
  await mkdir(path.join(root, '.teamree', 'members'), { recursive: true })
  await writeFile(path.join(root, '.teamree', 'relay'), 'wss://relay.example/v1/relay\n', 'utf8')

  let clock = Date.parse('2026-09-13T10:00:00Z')
  let onStderr: ((chunk: string) => void) | undefined

  const ok = (stdout = ''): Promise<GitOutput> => Promise.resolve({ exitCode: 0, stdout, stderr: '' })
  const answer = (run: GitRun): Promise<GitOutput> => {
    const args = run.args.join(' ')
    if (args.startsWith('push')) {
      onStderr = run.onStderr
      return push(run)
    }
    if (args === 'symbolic-ref --quiet --short HEAD') return ok('main\n')
    if (args.startsWith('rev-parse --abbrev-ref')) return ok('origin/main\n')
    if (args === 'rev-parse HEAD') return ok('9f1d2c3b4a5968778695a4b3c2d1e0f9a8b7c6d5\n')
    if (args === 'remote get-url origin') return ok('https://example.com/ada/pager.git\n')
    if (args === 'var GIT_AUTHOR_IDENT') return ok('Ada <ada@example.com> 1 +0000\n')
    if (args.startsWith('status --porcelain')) return ok(' M .teamree/relay\n')
    if (args.startsWith('diff --cached --name-only')) return ok('.teamree/relay\n')
    if (args.startsWith('config --get core.sshCommand')) return Promise.resolve({ exitCode: 1, stdout: '', stderr: '' })
    if (args.startsWith('config --get user.email')) return ok('ada@example.com\n')
    if (args.startsWith('add ') || args.startsWith('commit ')) return ok()
    throw new Error(`the scripted git was asked something it has no answer for: git ${args}`)
  }

  const runner: GitRunner = {
    binary: 'git',
    tryRun: answer,
    run: async (run) => {
      const output = await answer(run)
      if (output.exitCode !== 0) {
        throw new GitCommandError({ args: run.args, cwd: run.cwd, exitCode: output.exitCode, stderr: output.stderr })
      }
      return output
    }
  }

  const project: Project = { id: 'proj1', name: 'pager', path: root, baseRef: 'main' }
  return {
    project,
    now: () => clock,
    advance: (ms) => {
      clock += ms
    },
    say: (chunk) => onStderr?.(chunk),
    service: new TeamworkService({
      store: { getProject: (id) => (id === project.id ? project : undefined) },
      dataDir,
      runner,
      now: () => clock,
      env: {}
    })
  }
}

/** Waits for the scripted push to have been reached, without a fixed sleep. */
async function untilPushing(fake: Fake): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const progress = await fake.service.publishProgress({ projectId: fake.project.id })
    if (progress?.phase === 'pushing') return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('the publish never reached the push')
}

describe('a push that is taking a long time', () => {
  // The whole of the original complaint. Every one of these three facts was
  // being produced by git and thrown away between the process and the window.
  it('reports what git is printing, and how long it has been going', async () => {
    const fake = await wire(stalls)
    const running = fake.service.publish({ projectId: fake.project.id })
    await untilPushing(fake)

    fake.say('Enumerating objects: 12, done.\r')
    fake.advance(4_000)
    fake.say('Writing objects:  60% (6/10)\r')

    const progress = await fake.service.publishProgress({ projectId: fake.project.id })
    expect(progress?.phase).toBe('pushing')
    expect(progress?.output).toContain('Enumerating objects: 12, done.')
    expect(progress?.output.at(-1)).toBe('Writing objects:  60% (6/10)')
    // The two numbers a panel counts with: when this started, and when git last
    // said anything. Reading them out is `publishActivity`'s job, and its own
    // test's; what matters here is that they are measured at all.
    expect(progress!.lastOutputAt - progress!.startedAt).toBe(4_000)
    expect(progress!.finishedAt).toBeNull()

    await fake.service.cancelPublish({ projectId: fake.project.id })
    await running.catch(() => undefined)
  })

  // A push that has said nothing at all is still a push somebody is watching,
  // and the record has to exist from the first moment rather than from the
  // first line of output — otherwise the quietest failure is the one with
  // nothing on screen.
  it('has something to report before git has printed a word', async () => {
    const fake = await wire(stalls)
    const running = fake.service.publish({ projectId: fake.project.id })
    await untilPushing(fake)

    const progress = await fake.service.publishProgress({ projectId: fake.project.id })
    expect(progress?.output).toEqual([])
    expect(progress?.startedAt).toBe(progress?.lastOutputAt)
    expect(progress?.cancelling).toBe(false)

    await fake.service.cancelPublish({ projectId: fake.project.id })
    await running.catch(() => undefined)
  })
})

describe('stopping a push', () => {
  it('ends it, and still reports the commit that was made before it was stopped', async () => {
    const fake = await wire(stalls)
    const running = fake.service.publish({ projectId: fake.project.id })
    await untilPushing(fake)

    expect(await fake.service.cancelPublish({ projectId: fake.project.id })).toEqual({ cancelled: true })
    const result = await running

    // The half that worked is still reported. Throwing the commit away to tidy
    // up after a button somebody pressed by mistake would be a far worse
    // surprise than a commit they can push whenever they like.
    expect(result.commit?.shortSha).toBe('9f1d2c3')
    expect(result.push.ok).toBe(false)
    if (!result.push.ok) {
      expect(result.push.kind).toBe('cancelled')
      expect(result.push.advice).toMatch(/You stopped this push/)
      expect(result.push.advice).toMatch(/commit is still here/)
    }
  })

  it('says there was nothing to stop when nothing is running', async () => {
    const fake = await wire(() => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }))

    expect(await fake.service.cancelPublish({ projectId: fake.project.id })).toEqual({ cancelled: false })
  })

  // Two gits fighting over one index, and the second one's progress overwriting
  // the first's — so the window would show one push while the repository had
  // two.
  it('refuses to start a second push while one is running', async () => {
    const fake = await wire(stalls)
    const running = fake.service.publish({ projectId: fake.project.id })
    await untilPushing(fake)

    await expect(fake.service.publish({ projectId: fake.project.id })).rejects.toThrow(/already running/)

    await fake.service.cancelPublish({ projectId: fake.project.id })
    await running.catch(() => undefined)
  })
})

describe('a push the remote would not take', () => {
  // This app runs git with no terminal to prompt on, so a push that would have
  // asked for a password simply refuses. "Check that this machine can write to
  // it" was a diagnosis dressed as a remedy; the remedy is a command.
  it('names the credential remedy rather than reporting that the push failed', async () => {
    const fake = await wire(() =>
      Promise.resolve({
        exitCode: 128,
        stdout: '',
        stderr: "fatal: could not read Username for 'https://example.com': terminal prompts disabled\n"
      })
    )

    const result = await fake.service.publish({ projectId: fake.project.id })

    expect(result.push.ok).toBe(false)
    if (!result.push.ok) {
      expect(result.push.kind).toBe('auth')
      expect(result.push.advice).toMatch(/credential\.helper osxkeychain/)
      // git's own words, whole, because the paraphrase is not what anybody can
      // search for.
      expect(result.push.error).toMatch(/terminal prompts disabled/)
    }
  })

  // ssh is a separate program and GIT_TERMINAL_PROMPT means nothing to it, so
  // this is the refusal a machine with no key in the agent now gets instead of
  // a ten-minute wait on a question nobody can see.
  it('names the key remedy when ssh had nothing the remote would accept', async () => {
    const fake = await wire(() =>
      Promise.resolve({
        exitCode: 128,
        stdout: '',
        stderr: 'git@example.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n'
      })
    )

    const result = await fake.service.publish({ projectId: fake.project.id })

    expect(result.push.ok).toBe(false)
    if (!result.push.ok) {
      expect(result.push.kind).toBe('auth')
      expect(result.push.advice).toMatch(/ssh-add --apple-use-keychain/)
    }
  })

  // The one that everybody hits on the day they set this up: both people commit
  // a key onto the same base and the second push is turned away. It is not a
  // merge conflict and the instinct it provokes — forcing — is the wrong one.
  it('says to pull rather than to force when somebody pushed first', async () => {
    const fake = await wire(() =>
      Promise.resolve({
        exitCode: 1,
        stdout: 'To https://example.com/ada/pager.git\n!\trefs/heads/main:refs/heads/main\t[rejected] (fetch first)\n',
        stderr:
          '! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to ' +
          "'https://example.com/ada/pager.git'\n"
      })
    )

    const result = await fake.service.publish({ projectId: fake.project.id })

    expect(result.push.ok).toBe(false)
    if (!result.push.ok) {
      expect(result.push.kind).toBe('rejected')
      expect(result.push.advice).toMatch(/Pull or rebase onto origin\/main/)
      expect(result.push.advice).not.toMatch(/force/i)
    }
  })

  // A timeout is teamree's verdict rather than the remote's, and a person who
  // waited it out must not be told they were refused.
  it('tells a run that never finished apart from one that was refused', async () => {
    const fake = await wire((run) =>
      Promise.reject(new GitCommandError({ args: run.args, cwd: run.cwd, exitCode: null, stderr: '', timedOut: true }))
    )

    const result = await fake.service.publish({ projectId: fake.project.id })

    expect(result.push.ok).toBe(false)
    if (!result.push.ok) {
      expect(result.push.kind).toBe('timeout')
      expect(result.push.advice).toMatch(/never finished talking to origin/)
    }
  })
})

describe('what the push is run with', () => {
  // Two flags that are the difference between a window that can report progress
  // and one that cannot, and between a refusal and a hang.
  it('asks git for progress, and forbids ssh from asking this machine anything', async () => {
    let seen: GitRun | undefined
    const fake = await wire((run) => {
      seen = run
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
    })

    await fake.service.publish({ projectId: fake.project.id })

    // Without --progress git draws no meter at all, because a pipe is not a
    // terminal: the slowest part of this flow would print one line at the end.
    expect(seen?.args).toContain('--progress')
    // BatchMode is what turns "ssh is waiting on /dev/tty for a passphrase
    // nobody can see" into an immediate refusal with a sentence in it.
    expect(seen?.env?.GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes')
    // Never a force. The value of one is overwriting somebody else's work.
    expect(seen?.args).not.toContain('--force')
  })

  // `GIT_SSH_COMMAND` outranks `core.sshCommand`, so a team that configures one
  // would otherwise find teamree pushing with a different key than every other
  // tool on the machine.
  it('builds on the ssh the user already asked for rather than replacing it', async () => {
    let seen: GitRun | undefined
    const fake = await wire((run) => {
      seen = run
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
    })
    process.env.GIT_SSH_COMMAND = 'ssh -i ~/.ssh/work'
    try {
      await fake.service.publish({ projectId: fake.project.id })
    } finally {
      delete process.env.GIT_SSH_COMMAND
    }

    expect(seen?.env?.GIT_SSH_COMMAND).toBe('ssh -i ~/.ssh/work -o BatchMode=yes')
  })
})
