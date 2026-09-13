// The end-to-end teamwork scenario, as a test.
//
// The story is in docs/teamwork-scenario.md and the step numbers here are its
// step numbers. It is one story: a leader starts an agent, it gets stuck on a
// question, and a teammate answers it — which is the thing `docs/teamwork.md`
// says teamwork is for, so it is the thing a passing end-to-end run has to show.
//
// It is split in two on purpose.
//
// Act I runs today, entirely on the leader's machine. Every move the joiner will
// eventually make remotely is made here locally first, so it is already known to
// work before distance is added: when the transport lands, the transport is the
// only new variable. A scenario whose local half was never proved cannot tell a
// broken relay from a broken pane.
//
// Act II is the half that needs the relay. Those steps are `it.todo`, not
// skipped assertions and not assertions against an invented API — milestones B
// through D own those interfaces, and code written against a guess at them is
// code somebody has to delete. Each one carries the assertion to write, in
// words, above it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTwoPeers } from '../../scripts/teamwork/two-peers.mjs'

/**
 * A stand-in for an agent that has stopped and wants an answer. It is the shape
 * that matters, not the program: something prints, then blocks on input, and the
 * pane goes quiet with a question on the last line. That is exactly the state
 * `docs/teamwork.md` describes a teammate rescuing — "a teammate who can see
 * your agent stuck on a question can answer it".
 */
const STUCK_AGENT = 'printf "Which task should I take? "; read answer; printf "\\ntaking task %s\\n" "$answer"'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Polls a pane's scrollback until it says something, rather than sleeping blind. */
async function readUntil(peer: { call: (m: string, p?: unknown) => Promise<any> }, terminalId: string, want: RegExp) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { data } = await peer.call('terminal.read', { terminalId })
    if (want.test(data)) return data
    await sleep(100)
  }
  const { data } = await peer.call('terminal.read', { terminalId })
  throw new Error(`pane never matched ${want}; it said:\n${data}`)
}

let peers: Awaited<ReturnType<typeof startTwoPeers>>
let worktree: any
let pane: any

beforeAll(async () => {
  peers = await startTwoPeers({ handles: ['ana', 'bo'] })

  // Both members exist in the repository before anything else happens. Under
  // `docs/teamwork.md` this is not setup, it is the trust model: the roster in
  // git is what the Noise IK handshake will authenticate against, so a scenario
  // that skipped it would be testing a pair who are not on a team.
  for (const peer of peers.peers) await peer.addSelfToRoster()
  await peers.leader.commit('Add ana to the team', ['.teamree'])
  await peers.leader.gitPush()
  await peers.joiner.gitPull()
  await peers.joiner.commit('Add bo to the team', ['.teamree'])
  await peers.joiner.gitPush()
  await peers.leader.gitPull()
}, 120_000)

afterAll(async () => {
  const leftovers = await peers.stop()
  if (leftovers.length > 0) throw new Error(`harness left something behind:\n${leftovers.join('\n')}`)
}, 60_000)

describe('act I — on the leader’s machine, today', () => {
  it('0. both people are members, because both keys are in the repository', async () => {
    for (const peer of peers.peers) {
      expect((await peer.roster()).map((member: { handle: string }) => member.handle)).toEqual(['ana', 'bo'])
    }
  })

  it('1. the leader opens a worktree and starts an agent in it', async () => {
    const project = await peers.leader.call('project.add', { path: peers.leader.repoPath })
    const created = await peers.leader.call('worktree.create', { projectId: project.id, name: 'take a task' })

    worktree = created
    for (let attempt = 0; attempt < 120 && worktree.state === 'creating'; attempt += 1) {
      await sleep(250)
      worktree = await peers.leader.call('worktree.get', { worktreeId: created.id })
    }
    expect(worktree.state, worktree.error).toBe('ready')

    pane = await peers.leader.call('terminal.create', { worktreeId: worktree.id, command: STUCK_AGENT })
    expect(pane.id).toBeTruthy()
  }, 90_000)

  it('3a. the pane has output, and it is a question', async () => {
    // The control for step 3: what the joiner will read over the relay is what
    // `terminal.read` returns here. If this were ever to fail, nothing across a
    // relay could be blamed for it.
    expect(await readUntil(peers.leader, pane.id, /Which task should I take\?/)).toMatch(/Which task/)
  }, 30_000)

  it('4a. typing into the pane reaches the program, which answers', async () => {
    // The control for step 4. `terminal.write` is the same method a peer will
    // call across the transport — `docs/teamwork.md` is explicit that a teammate
    // is a third transport onto this catalogue, not a second catalogue.
    await peers.leader.call('terminal.write', { terminalId: pane.id, data: '3\r' })
    expect(await readUntil(peers.leader, pane.id, /taking task 3/)).toMatch(/taking task 3/)
  }, 30_000)

  it('2a. the worktree and its pane are visible in the workspace', async () => {
    // The control for step 2: this is the metadata that has to reach the joiner
    // without anybody subscribing to anything.
    const worktrees = await peers.leader.call('worktree.list')
    expect(worktrees.map((row: { id: string }) => row.id)).toContain(worktree.id)

    const terminals = await peers.leader.call('terminal.list', { worktreeId: worktree.id })
    expect(terminals.map((row: { id: string }) => row.id)).toContain(pane.id)
  })

  it('2b. a change in the workspace is announced rather than polled for', async () => {
    // The control for "the joiner sees it appear": appearing is driven by the
    // invalidation stream the GUI already runs on, and a teammate's worktrees
    // arriving is that same stream with a further source behind it.
    const seen: string[] = []
    const unsubscribe = await peers.leader.subscribe('workspace.subscribe', {}, (event: { type: string }) => {
      seen.push(event.type)
    })
    try {
      await peers.leader.call('terminal.create', { worktreeId: worktree.id, command: 'true' })
      for (let attempt = 0; attempt < 50 && !seen.includes('terminals'); attempt += 1) await sleep(100)
      expect(seen).toContain('terminals')
    } finally {
      await unsubscribe()
    }
  }, 30_000)
})

describe('act II — across the relay', () => {
  // Each of these is one step of docs/teamwork-scenario.md, and each says what
  // it will assert. They stay `todo` until the milestone that owns them lands.

  // Milestone B. The joiner's sidebar gains ana's worktree without the joiner
  // asking for it: metadata flows by default. Assert that the joiner's view of
  // the workspace contains a worktree whose owner is ana, with ana's branch name
  // and its pane's state, and that the joiner never called subscribe to get it.
  it.todo('2. the joiner sees the leader’s worktree appear, unasked')

  // Milestone B. Assert the negative, which is the one that protects the owner:
  // before the joiner opens anything, no terminal bytes have crossed. Metadata
  // is automatic; output is not.
  it.todo('2c. no terminal output has crossed the wire yet')

  // Milestone C. The joiner opens ana's pane. Assert the joiner reads the same
  // question act I proved is there — the scrollback, then the live stream — and
  // that it is letterboxed to ana's dimensions rather than resizing her PTY.
  it.todo('3. the joiner opens the pane and sees the agent’s question')

  // Milestone C. Assert ana's pane says it is being watched, and by bo. This is
  // half of what makes "anyone can type" survivable, so it is not optional and
  // it is not a nicety.
  it.todo('3b. the leader’s pane says it is being watched, and by whom')

  // Milestone D. The joiner answers. Assert the bytes reach ana's PTY and the
  // program acts on them — the same assertion as step 4a, with a relay in the
  // middle.
  it.todo('4. the joiner types the answer, and the agent takes the task')

  // Milestone D. Assert ana sees bo named as the author of that input while it
  // is happening, and that it is recorded in her local audit log afterwards with
  // who and when. Live attribution and the durable record are two different
  // promises and need two assertions.
  it.todo('5. the leader sees bo attributed, live and in the audit log')

  // Milestone D. Assert that after ana mutes the pane, a write from bo does not
  // reach the PTY. Mute is the owner's and is not a negotiation, so the
  // assertion is about ana's PTY, not about bo being told no.
  it.todo('6. the leader mutes the pane, and the joiner’s typing stops arriving')

  // Milestone D. Assert the muted worktree is still in bo's sidebar. Mute stops
  // the bytes; hiding the worktree would make mute a way to work unobserved on a
  // shared project, which docs/teamwork.md rules out deliberately.
  it.todo('6b. the muted pane is still visible, because mute is not hiding')

  // Milestone B, and the one that proves the trust model rather than the
  // plumbing. Assert that a peer whose public key is not in
  // `.teamree/members/` fails the Noise IK handshake and never reaches the
  // method catalogue at all. Without this, every test above passes for a relay
  // that pairs anybody.
  it.todo('7. a peer whose key is not in the roster cannot complete the handshake')

  // Milestone E. Assert that when ana's runtime stops, her worktree stays in
  // bo's sidebar marked stale with the age of what is shown, rather than
  // vanishing — a row disappearing reads as "it was deleted", which for a
  // worktree is the one thing it must never wrongly say.
  it.todo('8. the leader goes offline and her worktrees go stale, not absent')
})
