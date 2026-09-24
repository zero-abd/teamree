// Joining from an invitation link, as the Join sheet does it: clone, add, key,
// push. Two real runtimes and a bare origin in a temp directory; nothing dials a network.

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { formatInvitation, parseInvitation } from '@shared/invitation'
import { joinTeam, type JoinCall } from './joinTeam'
// @ts-expect-error -- untyped .mjs, deliberately outside the TypeScript build.
import { startTwoPeers } from '../../../../scripts/teamwork/two-peers.mjs'

let peers: Awaited<ReturnType<typeof startTwoPeers>>

beforeAll(async () => {
  peers = await startTwoPeers({ handles: ['ana', 'bo'] })
  // The leader's key is on the team already.
  await peers.leader.addSelfToRoster()
  await peers.leader.commit('Add ana to the team', ['.teamree'])
  await peers.leader.gitPush()
  // A fresh clone has no identity of its own; the joiner's account supplies it.
  writeFileSync(join(peers.joiner.home, '.gitconfig'), '[user]\n\tname = bo\n\temail = bo@teamree.invalid\n')
}, 120_000)

afterAll(async () => {
  await peers?.stop()
}, 60_000)

describe('joining from a link', () => {
  it('clones, adds the project, writes the key and pushes it to the origin', async () => {
    const parsed = parseInvitation(formatInvitation({ origin: peers.origin, project: 'ledger', from: 'ana' }))
    if (!parsed.ok) throw new Error(parsed.reason)
    const into = join(peers.joiner.home, 'joined')
    const stages: string[] = []

    const call: JoinCall = (method, params) => peers.joiner.call(method, params)
    const outcome = await joinTeam(call, parsed.invitation, { clone: into }, (stage) => stages.push(stage))

    if (!outcome.ok) throw new Error(`${outcome.stage}: ${outcome.error}`)
    expect(stages).toEqual(['clone', 'read', 'key', 'push'])
    expect(outcome.project.path).toContain('joined')
    const pushed = execFileSync('git', ['--git-dir', peers.origin, 'ls-tree', '-r', '--name-only', 'HEAD'], {
      encoding: 'utf8'
    })
    expect(pushed).toContain('.teamree/members/ana.pub')
    expect(pushed).toContain('.teamree/members/bo.pub')
  })

  it('uses a checkout that is already a project instead of cloning again', async () => {
    const projects = (await peers.joiner.call('project.list')) as Array<{ id: string; path: string }>
    const joined = projects.find((project) => project.path.endsWith('joined'))
    if (joined === undefined) throw new Error('the first test added no project')

    const parsed = parseInvitation(formatInvitation({ origin: peers.origin, project: 'ledger', from: 'ana' }))
    if (!parsed.ok) throw new Error(parsed.reason)
    const call: JoinCall = (method, params) => peers.joiner.call(method, params)
    const outcome = await joinTeam(call, parsed.invitation, { projectId: joined.id })

    expect(outcome.ok && outcome.project.id).toBe(joined.id)
    expect(outcome.ok && outcome.publish.push.ok && outcome.publish.push.alreadyUpToDate).toBe(true)
  })
})
