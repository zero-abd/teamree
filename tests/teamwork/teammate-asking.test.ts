// A teammate's asking agent between two real runtimes over a real relay: bo sees ana's pane asking,
// with its answers, and his answer runs only once ana allows it, and only while the question is on screen.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { PaneConsent, PeerPane, TeammatePresence, Terminal, Worktree } from '../../src/shared/entities'
// @ts-expect-error -- untyped .mjs, deliberately outside the TypeScript build.
import { relayIsBuilt, startTwoPeers } from '../../scripts/teamwork/two-peers.mjs'

const RELAY_BUILT = relayIsBuilt()
const PERMISSION = resolve('src/main/terminals/fixtures/claude-permission.txt')

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

async function until(predicate: () => Promise<boolean>, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
    await sleep(100)
  }
}

let peers: Awaited<ReturnType<typeof startTwoPeers>>
let bin: string
let anasPane: Terminal

/** Ana's asking pane, as bo's sidebar reads it. */
async function bosView(): Promise<PeerPane | undefined> {
  const presence = (await peers.joiner.call('teamwork.presence', {
    projectId: peers.joiner.projectId
  })) as TeammatePresence
  if (presence.state !== 'read') return undefined
  return presence.worktrees.flatMap((row) => row.panes).find((pane) => pane.id.endsWith(`:${anasPane.id}`))
}

const anasQuestions = async (): Promise<PaneConsent> =>
  peers.leader.call('teamwork.requests', { projectId: peers.leader.projectId })

async function anaAllowsOnce(): Promise<string> {
  await until(async () => (await anasQuestions()).requests.length > 0, 'ana to be asked about bo’s answer')
  const [question] = (await anasQuestions()).requests
  await peers.leader.call('teamwork.decide', { requestId: question!.id, decision: 'once' })
  return question!.preview
}

describe.skipIf(!RELAY_BUILT)('a teammate’s asking pane', () => {
  beforeAll(async () => {
    // A stand-in named claude, run by absolute path: it draws a recorded permission prompt and waits.
    bin = await mkdtemp(join(tmpdir(), 'tr-asking-'))
    const claude = join(bin, 'claude')
    await writeFile(
      claude,
      [
        '#!/bin/sh',
        `cat '${PERMISSION}'`,
        'read -r answer',
        `printf '\\033[2J\\033[Hanswered\\n'`,
        'while read -r line; do :; done'
      ].join('\n')
    )
    await chmod(claude, 0o755)

    peers = await startTwoPeers({ handles: ['ana', 'bo'] })
    for (const peer of peers.peers) await peer.addSelfToRoster()
    await peers.leader.commit('Add ana to the team', ['.teamree'])
    await peers.leader.gitPush()
    await peers.joiner.gitPull()
    await peers.joiner.commit('Add bo to the team', ['.teamree'])
    await peers.joiner.gitPush()
    await peers.leader.gitPull()

    const projectId = await peers.leader.ensureProject()
    let worktree: Worktree = await peers.leader.call('worktree.create', { projectId, name: 'billing' })
    for (let attempt = 0; attempt < 120 && worktree.state === 'creating'; attempt += 1) {
      await sleep(250)
      worktree = await peers.leader.call('worktree.get', { worktreeId: worktree.id })
    }
    expect(worktree.state, worktree.error).toBe('ready')

    await peers.linkPeers()
    // The size the prompt was recorded at, so the screen reads as it did.
    anasPane = await peers.leader.call('terminal.create', {
      worktreeId: worktree.id,
      command: claude,
      cols: 100,
      rows: 30
    })
  }, 180_000)

  afterAll(async () => {
    const leftovers = await peers?.stop()
    if (bin) await rm(bin, { recursive: true, force: true })
    if (leftovers && leftovers.length > 0) throw new Error(`harness left something behind:\n${leftovers.join('\n')}`)
  }, 60_000)

  it('reaches bo as asking, with its answers and never its question', async () => {
    await until(async () => (await bosView())?.asking === true, 'ana’s pane to reach bo as asking')
    const pane = await bosView()
    expect(pane?.agent).toBe('claude')
    expect(pane?.menu?.choices.map((choice) => choice.label)).toContain('Yes')
    expect(JSON.stringify(pane)).not.toContain('mkdir')
  }, 60_000)

  it('runs bo’s answer only once ana allows it, then stops asking', async () => {
    const pane = await bosView()
    const yes = pane?.menu?.choices.find((choice) => choice.label === 'Yes')
    expect(yes?.keys).not.toBeNull()

    const answered = peers.joiner.call('teamwork.type', {
      projectId: peers.joiner.projectId,
      paneId: pane!.id,
      data: yes!.keys!.join(''),
      answering: pane!.menu!.prompt
    })
    // Held on ana's machine: the pane has not seen it.
    await until(async () => (await anasQuestions()).requests.length > 0, 'ana to be asked')
    expect((await peers.leader.call('terminal.read', { terminalId: anasPane.id })).data).not.toContain('answered')

    await anaAllowsOnce()
    await expect(answered).resolves.toEqual({ written: true })
    await until(
      async () => (await peers.leader.call('terminal.read', { terminalId: anasPane.id })).data.includes('answered'),
      'the answer to reach ana’s agent'
    )
    await until(async () => (await bosView())?.asking !== true, 'bo to see it stop asking')
    expect((await bosView())?.menu).toBeUndefined()
  }, 60_000)

  it('refuses an answer to a question no longer on screen, even once allowed', async () => {
    const stale = peers.joiner.call('teamwork.type', {
      projectId: peers.joiner.projectId,
      paneId: (await bosView())!.id,
      data: '\r',
      answering: 'deadbeef'
    })
    const outcome = stale.then(
      () => 'written',
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    )
    await anaAllowsOnce()
    expect(await outcome).toMatch(/no longer asks/)
  }, 60_000)
})
