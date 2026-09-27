// Hand Off between two real runtimes over a real relay: ana hands bo a worktree with work not yet
// committed and her agent running; bo takes it and his checkout carries that work, his stand-in agent is
// told the note and what was done, ana's agent is stopped, and each side shows the task once.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { teammatesHeard, type TeammatePresence, type Terminal, type Worktree } from '../../src/shared/entities'
import type { TeamworkHandoffs, WorktreeOverlaps } from '../../src/shared/tasks'
// @ts-expect-error -- untyped .mjs, deliberately outside the TypeScript build.
import { relayIsBuilt, startTwoPeers } from '../../scripts/teamwork/two-peers.mjs'

const run = promisify(execFile)
const RELAY_BUILT = relayIsBuilt()
const NOTE = 'Finish the refresh path; the tests for expiry are still red.'
const WIP = 'WIP: Rework auth session'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function until<T>(read: () => Promise<T | undefined>, what: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
    await sleep(100)
  }
}

let peers: Awaited<ReturnType<typeof startTwoPeers>>

async function ready(peer: typeof peers.leader, created: Worktree): Promise<Worktree> {
  return until(async () => {
    const worktree = (await peer.call('worktree.get', { worktreeId: created.id })) as Worktree
    return worktree.state === 'creating' ? undefined : worktree
  }, `${created.name} to be created`)
}

/**
 * Every clone's `origin` is a made-up ssh URL, because the project key needs a host. An ssh command
 * that runs git's half locally against the harness's bare repository makes it a real remote.
 */
async function realOrigin(): Promise<void> {
  const ssh = join(peers.root, 'local-ssh')
  await writeFile(
    ssh,
    `#!/bin/sh\nfor last; do :; done\nexec sh -c "$(printf '%s' "$last" | sed "s|'teamree/ledger.git'|'${peers.origin}'|")"\n`
  )
  await chmod(ssh, 0o755)
  for (const peer of peers.peers) {
    await run('git', ['-C', peer.repoPath, 'config', 'core.sshCommand', ssh])
    await run('git', ['-C', peer.repoPath, 'config', 'ssh.variant', 'simple'])
  }
}

describe.skipIf(!RELAY_BUILT)('handing a worktree to a teammate', () => {
  let worktree: Worktree
  let head: string

  beforeAll(async () => {
    peers = await startTwoPeers({ handles: ['ana', 'bo'] })
    for (const peer of peers.peers) await peer.addSelfToRoster()
    await peers.leader.commit('Add ana to the team', ['.teamree'])
    await peers.leader.gitPush()
    await peers.joiner.gitPull()
    await peers.joiner.commit('Add bo to the team', ['.teamree'])
    await peers.joiner.gitPush()
    await peers.leader.gitPull()
    await realOrigin()

    const projectId = await peers.leader.ensureProject()
    worktree = await ready(
      peers.leader,
      await peers.leader.call('worktree.create', { projectId, name: 'Rework auth session' })
    )
    expect(worktree.state, worktree.error).toBe('ready')
    // The branch carries its own stand-in named claude, so bo's pane runs it and never an agent on PATH.
    await mkdir(join(worktree.path, 'bin'), { recursive: true })
    // `--stay` keeps ana's own agent running, so Hand Off has one to stop.
    await writeFile(
      join(worktree.path, 'bin', 'claude'),
      '#!/bin/sh\necho "AGENT ARGS: $@"\ncase " $* " in *" --stay "*) exec sleep 600 ;; esac\n'
    )
    await chmod(join(worktree.path, 'bin', 'claude'), 0o755)
    await run('git', ['-C', worktree.path, 'add', 'bin/claude'])
    await run('git', ['-C', worktree.path, 'commit', '--quiet', '-m', 'Start the auth rework'])
    head = (await run('git', ['-C', worktree.path, 'rev-parse', 'HEAD'])).stdout.trim()
    await writeFile(join(worktree.path, 'expiry.md'), 'Refresh tokens expire after 30 days.\n')

    await peers.linkPeers()
  }, 180_000)

  afterAll(async () => {
    const leftovers = await peers?.stop()
    if (leftovers && leftovers.length > 0) throw new Error(`harness left something behind:\n${leftovers.join('\n')}`)
  }, 60_000)

  it('refuses a handle that is not on the roster', async () => {
    await expect(
      peers.leader.call('teamwork.handOff', { worktreeId: worktree.id, to: 'mallory', note: NOTE })
    ).rejects.toThrow(/mallory is not on this project’s roster/)
  })

  it('carries ana’s uncommitted work and stops her agent; bo’s agent continues from the note and a brief', async () => {
    const mine = (await peers.leader.call('terminal.create', {
      worktreeId: worktree.id,
      command: './bin/claude',
      agentArgs: '--stay'
    })) as Terminal
    await until(async () => {
      const { data } = (await peers.leader.call('terminal.read', { terminalId: mine.id })) as { data: string }
      return data.includes('AGENT ARGS:') ? true : undefined
    }, 'ana’s agent to start')

    const offered = await peers.leader.call('teamwork.handOff', {
      worktreeId: worktree.id,
      to: 'bo',
      note: NOTE,
      commit: WIP,
      stopAgents: true
    })
    expect(offered).toMatchObject({ to: 'bo', from: 'ana', branch: worktree.branch })
    expect(offered.brief).toContain('expiry.md')
    const stopped = (await peers.leader.call('terminal.list', { worktreeId: worktree.id })) as Terminal[]
    expect(stopped.find((pane) => pane.id === mine.id)?.running).toBe(false)
    expect((await run('git', ['-C', worktree.path, 'status', '--porcelain'])).stdout).toBe('')

    const bosProject = await peers.joiner.ensureProject()
    const [incoming] = await until(async () => {
      const read = (await peers.joiner.call('teamwork.handoffs', { projectId: bosProject })) as TeamworkHandoffs
      return read.incoming.length > 0 ? read.incoming : undefined
    }, 'the handoff to reach bo')
    expect(incoming).toMatchObject({ id: offered.id, from: 'ana', worktreeName: 'Rework auth session', note: NOTE })
    const anasCopy = async (): Promise<boolean> =>
      (
        teammatesHeard((await peers.joiner.call('teamwork.presence', { projectId: bosProject })) as TeammatePresence)
          ?.worktrees ?? []
      ).some((theirs) => theirs.branch === worktree.branch)
    expect(await anasCopy()).toBe(true)

    const taken = await ready(
      peers.joiner,
      await peers.joiner.call('teamwork.take', { projectId: bosProject, id: offered.id, agent: './bin/claude' })
    )
    expect(taken.state, taken.error).toBe('ready')
    expect(taken.branch).toBe(worktree.branch)
    expect((await run('git', ['-C', taken.path, 'log', '-1', '--format=%s'])).stdout.trim()).toBe(WIP)
    expect((await run('git', ['-C', taken.path, 'rev-parse', 'HEAD~1'])).stdout.trim()).toBe(head)
    expect((await run('git', ['-C', taken.path, 'show', 'HEAD:expiry.md'])).stdout).toContain('30 days')

    const pane = await until(async () => {
      const [terminal] = (await peers.joiner.call('terminal.list', { worktreeId: taken.id })) as Terminal[]
      return terminal
    }, 'bo’s agent pane')
    const printed = await until(async () => {
      const { data } = (await peers.joiner.call('terminal.read', { terminalId: pane.id })) as { data: string }
      return data.includes('AGENT ARGS:') && data.includes('expiry.md') ? data : undefined
    }, 'the stand-in to print its arguments')
    const flat = printed.replace(/\r?\n/g, '')
    expect(flat).toContain('ana handed this task over.')
    expect(flat).toContain(NOTE)
    expect(flat).toMatch(new RegExp(`Commits since [^:]+:- ${WIP}`))

    const [outgoing] = await until(async () => {
      const read = (await peers.leader.call('teamwork.handoffs', {
        projectId: peers.leader.projectId
      })) as TeamworkHandoffs
      return read.outgoing[0]?.takenAt === undefined ? undefined : read.outgoing
    }, 'ana to see it taken')
    expect(outgoing).toMatchObject({ id: offered.id, to: 'bo', worktreeId: worktree.id })
    expect(
      ((await peers.joiner.call('teamwork.handoffs', { projectId: bosProject })) as TeamworkHandoffs).incoming
    ).toEqual([])

    // One row each: bo stops seeing ana's copy, and ana's copy is out of her overlaps with his.
    await until(async () => ((await anasCopy()) ? undefined : true), 'ana’s copy to leave bo’s sidebar')
    await until(async () => {
      const heard = teammatesHeard(
        (await peers.leader.call('teamwork.presence', { projectId: peers.leader.projectId })) as TeammatePresence
      )
      return heard?.worktrees.some((theirs) => theirs.branch === worktree.branch) ? true : undefined
    }, 'ana to hear bo’s copy')
    const overlaps = (await peers.leader.call('worktree.overlaps', {
      projectId: peers.leader.projectId
    })) as WorktreeOverlaps
    expect(overlaps.overlaps.filter((overlap) => overlap.worktreeId === worktree.id)).toEqual([])
  }, 120_000)
})
