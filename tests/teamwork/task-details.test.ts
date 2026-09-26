// Presence v2 between two real runtimes over a real relay: ana's task line and the files she changed
// reach bo, and stop reaching him when she turns Share Task Details off.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TeammatePresence, TeammateWorktree, Worktree } from '../../src/shared/entities'
// @ts-expect-error -- untyped .mjs, deliberately outside the TypeScript build.
import { relayIsBuilt, startTwoPeers } from '../../scripts/teamwork/two-peers.mjs'

const RELAY_BUILT = relayIsBuilt()

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function until(predicate: () => Promise<boolean>, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
    await sleep(100)
  }
}

let peers: Awaited<ReturnType<typeof startTwoPeers>>
let worktree: Worktree

/** Ana's row as bo's sidebar reads it. */
async function anasRow(): Promise<TeammateWorktree | undefined> {
  const presence = (await peers.joiner.call('teamwork.presence', {
    projectId: peers.joiner.projectId
  })) as TeammatePresence
  return presence.state === 'read' ? presence.worktrees.find((row) => row.handle === 'ana') : undefined
}

describe.skipIf(!RELAY_BUILT)('teammates see the task', () => {
  beforeAll(async () => {
    peers = await startTwoPeers({ handles: ['ana', 'bo'] })
    for (const peer of peers.peers) await peer.addSelfToRoster()
    await peers.leader.commit('Add ana to the team', ['.teamree'])
    await peers.leader.gitPush()
    await peers.joiner.gitPull()
    await peers.joiner.commit('Add bo to the team', ['.teamree'])
    await peers.joiner.gitPush()
    await peers.leader.gitPull()

    const projectId = await peers.leader.ensureProject()
    worktree = await peers.leader.call('worktree.create', {
      projectId,
      name: 'rate limits',
      task: 'Add rate limits to the API\nToken bucket, per key.'
    })
    for (let attempt = 0; attempt < 120 && worktree.state === 'creating'; attempt += 1) {
      await sleep(250)
      worktree = await peers.leader.call('worktree.get', { worktreeId: worktree.id })
    }
    expect(worktree.state, worktree.error).toBe('ready')
    await mkdir(join(worktree.path, 'src'), { recursive: true })
    await writeFile(join(worktree.path, 'src', 'limiter.js'), 'export const limit = 10\n')

    await peers.linkPeers()
  }, 180_000)

  afterAll(async () => {
    const leftovers = await peers?.stop()
    if (leftovers && leftovers.length > 0) throw new Error(`harness left something behind:\n${leftovers.join('\n')}`)
  }, 60_000)

  it('shows bo ana’s task line and the paths she changed, never their contents', async () => {
    await until(async () => (await anasRow())?.paths?.includes('src/limiter.js') === true, 'ana’s paths to reach bo')
    const row = await anasRow()
    expect(row?.task).toBe('Add rate limits to the API')
    expect(JSON.stringify(row)).not.toContain('export const limit')
  }, 60_000)

  it('sends bo only v1 once ana turns Share Task Details off', async () => {
    await peers.leader.call('settings.set', { shareTaskDetails: false })
    await until(async () => {
      const row = await anasRow()
      return row !== undefined && row.task === undefined && row.paths === undefined
    }, 'ana’s task details to stop reaching bo')
    expect((await anasRow())?.name).toBe('rate limits')
  }, 60_000)
})
