// The end-to-end teamwork scenario, as a test.
//
// The story is in docs/teamwork-scenario.md and the step numbers here are its
// step numbers. It is one story: a leader starts an agent, it gets stuck on a
// question, and a teammate answers it — which is the thing `docs/teamwork.md`
// says teamwork is for, so it is the thing a passing end-to-end run has to show.
//
// It is split in two on purpose.
//
// Act I runs entirely on the leader's machine. Every move the joiner makes
// remotely in act II is made here locally first, so when act II fails there is
// only ever one new variable in it: a scenario whose local half was never
// proved cannot tell a broken relay from a broken pane.
//
// Act II is the same story with two thousand miles in the middle, and nothing
// in it is a stand-in. The relay is the relay's own build, running as a child
// process on a real port. The crypto is real Noise between two identities the
// two runtimes generated for themselves, authenticated against the keys their
// two clones of one repository carry. The pane is a real pty with a real
// program in it. The only thing the harness fakes is the distance.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {
  ConsentDecision,
  PaneConsent,
  PaneWatchers,
  TeammatePresence,
  TeammatePresenceRead,
  Terminal,
  WatchedPane
} from '../../src/shared/entities'
import { TYPING_WINDOW_MS } from '../../src/shared/entities'
import type { WatchedPaneEvent } from '../../src/shared/methods'
import { ErrorCode } from '../../src/shared/protocol'
import { relayIsBuilt, startTwoPeers } from '../../scripts/teamwork/two-peers.mjs'

/**
 * Act II needs the relay's own build, which is a separate package with its own
 * `dist/`. Missing, it says so and skips: another package's absent build is not
 * a broken peer transport. `scripts/require-test-environment.mjs` stats the
 * same file before the suite starts and refuses to run at all rather than let
 * it skip, because a skip nobody sees is a test that does not exist — and with
 * no CI anywhere, this local run is the only place anybody would see it.
 */
const RELAY_BUILT = relayIsBuilt()

if (!RELAY_BUILT) {
  console.warn(
    '[scenario] act II is skipped: the relay is not built.\n' +
      '[scenario] build it with:  cd relay && npm ci && npm run build'
  )
}

/**
 * A stand-in for an agent that has stopped and wants an answer. It is the shape
 * that matters, not the program: something prints, then blocks on input, and the
 * pane goes quiet with a question on the last line. That is exactly the state
 * `docs/teamwork.md` describes a teammate rescuing — "a teammate who can see
 * your agent stuck on a question can answer it".
 */
const STUCK_AGENT = 'printf "Which task should I take? "; read answer; printf "\\ntaking task %s\\n" "$answer"'

/** What the pane says before anybody opens it, and must never leak by itself. */
const UNWATCHED = 'reading TASKS.md, nobody is watching'

/**
 * The same agent, left running after it has answered.
 *
 * Act II needs a pane that is still there after the question is answered: the
 * joiner types, the owner mutes, the joiner types again, and a program that
 * exited on the first newline would make every step after step 4 a test about
 * a pane that is not there. The echo is off, so what the scrollback holds is
 * what the program printed and never what was typed at it — which is what lets
 * step 6 assert that nothing arrived rather than that nothing was displayed.
 */
const ACT_TWO_AGENT = [
  'stty -echo 2>/dev/null',
  `printf '%s\\n' '${UNWATCHED}'`,
  'printf "Which task should I take? "',
  'read answer',
  'printf "\\ntaking task %s\\n" "$answer"',
  'while IFS= read -r line; do printf "heard %s\\n" "$line"; done'
].join('; ')

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The roster out of a presence answer, or a failure that says it was never read.
 *
 * `teamwork.presence` answers a union: a project the runtime has but has not
 * reconciled yet has no roster, and says so rather than handing back an empty
 * one. Every peer below is fully up before anything here asks, so unread is not
 * a state to wait out — it is the harness having got ahead of a runtime, and a
 * named failure beats `worktrees` being `undefined` on the next line.
 */
async function rosterOf(answer: Promise<TeammatePresence>): Promise<TeammatePresenceRead> {
  const presence = await answer
  if (presence.state !== 'read') throw new Error(`teamwork has not read ${presence.projectId}’s roster yet`)
  return presence
}

/**
 * Polls a condition nothing here can be woken for.
 *
 * Two runtimes in two processes wake each other and not this test, so a
 * teammate's snapshot arriving is learned by asking. The timeout is a failure
 * mode rather than a delay: nothing waits for it when what it waits on happens.
 */
async function until(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
    await sleep(50)
  }
}

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
  // git is what the Noise IK handshake authenticates against, so a scenario
  // that skipped it would be testing a pair who are not on a team.
  //
  // Each key is the runtime's own, asked of the runtime and written by it —
  // `members.join` is the Add my key button in the Start teamwork panel. A
  // harness that minted its own keypairs would fill the roster with keys neither
  // app has ever heard of, and every handshake in act II would fail for a reason
  // no assertion here would explain.
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
    // The project is already tracked: adding a key to a repository is done
    // through the project, so step 0 is what put it in the sidebar.
    const projectId = await peers.leader.ensureProject()
    const created = await peers.leader.call('worktree.create', { projectId, name: 'take a task' })

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
    const stream = await peers.leader.subscribe('workspace.subscribe', {}, (event: { type: string }) => {
      seen.push(event.type)
    })
    try {
      await peers.leader.call('terminal.create', { worktreeId: worktree.id, command: 'true' })
      for (let attempt = 0; attempt < 50 && !seen.includes('terminals'); attempt += 1) await sleep(100)
      expect(seen).toContain('terminals')
    } finally {
      await stream.close()
    }
  }, 30_000)
})

describe.skipIf(!RELAY_BUILT)('act II — across the relay', () => {
  // Everything here is the story in docs/teamwork-scenario.md, step for step,
  // between two runtimes that share nothing but a git origin and a relay.

  /** The pane act II is about: a fresh agent, stopped on a question. */
  let anasPane: Terminal
  /** The same pane as bo can name it: `peer:<key prefix>:<ana's own id>`. */
  let bosPaneId: string
  /** Bo's open watch, and everything it has pushed him. */
  let bosWatch: { cols: number; rows: number; handle: string; close: () => Promise<void> } | undefined
  const pushed: WatchedPaneEvent[] = []

  /** Everything bo's watch has carried, as the pane's own bytes. */
  const readThroughRelay = (): string =>
    pushed
      .filter((event): event is { type: 'data'; data: string } => event.type === 'data')
      .map((event) => event.data)
      .join('')

  const bosView = (): Promise<TeammatePresenceRead> =>
    rosterOf(peers.joiner.call('teamwork.presence', { projectId: peers.joiner.projectId }))

  /** Ana's row in bo's sidebar, with her panes under it. */
  const anasRow = async (): Promise<TeammatePresenceRead['worktrees'][number] | undefined> =>
    (await bosView()).worktrees.find((row) => row.handle === 'ana')

  /** Ana's own books: who is reading her panes and who has typed into them. */
  const anasBooks = (): Promise<PaneWatchers> =>
    peers.leader.call('teamwork.watchers', { projectId: peers.leader.projectId })

  const anasBookFor = async (): Promise<WatchedPane | undefined> =>
    (await anasBooks()).panes.find((pane) => pane.terminalId === anasPane.id)

  /** What ana's pty itself holds, which is the only thing a write really proves. */
  const anasScrollback = async (): Promise<string> =>
    (await peers.leader.call('terminal.read', { terminalId: anasPane.id })).data

  const boTypes = (data: string): Promise<{ written: true }> =>
    peers.joiner.call('teamwork.type', { projectId: peers.joiner.projectId, paneId: bosPaneId, data })

  /** What ana's machine is holding for her to answer, on her own machine. */
  const anasQuestions = (): Promise<PaneConsent> =>
    peers.leader.call('teamwork.requests', { projectId: peers.leader.projectId })

  /**
   * Ana, answering the question her machine puts up the first time bo types.
   *
   * Through the real methods rather than around them: the question is read out
   * of `teamwork.requests` and answered through `teamwork.decide`, which is
   * what the button in her window does.
   */
  const anaAllows = async (decision: ConsentDecision): Promise<void> => {
    await until(async () => (await anasQuestions()).requests.length > 0, 'ana to be asked about bo')
    const [question] = (await anasQuestions()).requests
    if (question === undefined) throw new Error('ana was asked and then was not')
    await peers.leader.call('teamwork.decide', { requestId: question.id, decision })
  }

  beforeAll(async () => {
    // The relay, the two outbound sockets, and the Noise IK handshake against
    // the keys the two clones carry. Nothing is subscribed to here.
    await peers.linkPeers()

    // A fresh agent, because act I's has already been answered and has gone.
    // Started after the link, so that what act II watches cross the wire
    // actually crosses it rather than having been there all along.
    anasPane = await peers.leader.call('terminal.create', { worktreeId: worktree.id, command: ACT_TWO_AGENT })
    await readUntil(peers.leader, anasPane.id, /Which task should I take\?/)
  }, 180_000)

  afterAll(async () => {
    await bosWatch?.close()
  })

  it('2. the joiner sees the leader’s worktree appear, unasked', async () => {
    // Appearing, rather than being there: bo's sidebar fills itself, so this
    // waits for a row nobody asked for instead of reading one that was already
    // arranged.
    await until(
      async () => (await anasRow())?.panes.some((pane) => pane.id.endsWith(`:${anasPane.id}`)) === true,
      'ana’s worktree to reach bo'
    )

    const row = await anasRow()
    expect(row?.name).toBe(worktree.name)
    expect(row?.branch).toBe(worktree.branch)
    expect(row?.state).toBe('ready')
    expect(row?.live).toBe(true)
    expect(row?.publicKey).toBe((await peers.leader.whoAmI()).publicKey)

    // Her pane's state, not just its name: the sidebar has to be able to draw
    // a running agent differently from one that exited.
    const pane = row?.panes.find((candidate) => candidate.id.endsWith(`:${anasPane.id}`))
    expect(pane?.running).toBe(true)
    expect(pane?.cols).toBe(anasPane.cols)
    expect(pane?.rows).toBe(anasPane.rows)
    expect(pane?.quietForMs).toBeGreaterThanOrEqual(0)
    bosPaneId = pane?.id ?? ''

    // And bo asked for none of it. Every method this end has sent is recorded,
    // so "metadata flows by default" is a thing the test can show rather than
    // a thing it has to be trusted about.
    const subscribing = ['workspace.subscribe', 'terminal.subscribe', 'peer.subscribe', 'teamwork.watch']
    expect(peers.joiner.called.filter((method: string) => subscribing.includes(method))).toEqual([])
  }, 60_000)

  it('2c. no terminal output has crossed the wire yet', async () => {
    // The control: there is something to leak. Ana's pane really did say this,
    // on ana's machine, while nobody was reading it.
    expect(await anasScrollback()).toContain(UNWATCHED)

    // And none of it is anywhere bo can see. His whole view of ana is the
    // snapshot above, and a snapshot carries names, branches, pane states and
    // silences — never bytes.
    expect(JSON.stringify(await bosView())).not.toContain(UNWATCHED)
    // Nor has anything been made a pane of his own.
    expect(await peers.joiner.call('terminal.list')).toEqual([])

    // Ana's side of the same fact, which is the half that protects her: nobody
    // is reading any pane of hers, so nothing is being sent.
    expect((await anasBooks()).panes).toEqual([])
  })

  it('3. the joiner opens the pane and sees the agent’s question', async () => {
    const before = await peers.leader.call('terminal.list', { worktreeId: worktree.id })
    const size = before.find((pane: Terminal) => pane.id === anasPane.id)

    bosWatch = await peers.joiner.subscribe(
      'teamwork.watch',
      { projectId: peers.joiner.projectId, paneId: bosPaneId },
      (event: WatchedPaneEvent) => pushed.push(event)
    )

    // Whose pane it is, said in the answer, so the view is never ambiguous.
    expect(bosWatch?.handle).toBe('ana')

    // The scrollback: what act I proved is there, read from the other machine.
    await until(() => readThroughRelay().includes('Which task should I take?'), 'the question to reach bo')
    // Including what it said before anybody opened it — which is the point of
    // reading a scrollback at all, and the thing step 2c proved had not moved.
    expect(readThroughRelay()).toContain(UNWATCHED)

    // Letterboxed to ana's pty, not negotiated with bo's window.
    expect(bosWatch?.cols).toBe(size?.cols)
    expect(bosWatch?.rows).toBe(size?.rows)

    // And her pty is the size it was. There is no method through which a
    // reader could have changed it: `terminal.resize` is not on the list a
    // teammate may call.
    const after = await peers.leader.call('terminal.list', { worktreeId: worktree.id })
    const now = after.find((pane: Terminal) => pane.id === anasPane.id)
    expect(now?.cols).toBe(size?.cols)
    expect(now?.rows).toBe(size?.rows)
  }, 60_000)

  it('3b. the leader’s pane says it is being watched, and by whom', async () => {
    await until(async () => (await anasBookFor()) !== undefined, 'ana to see a reader on her pane')

    const book = await anasBookFor()
    expect(book?.watchers.map((watcher) => watcher.handle)).toEqual(['bo'])
    // By the key the handshake authenticated, not by a name anybody claimed.
    expect(book?.watchers[0]?.publicKey).toBe((await peers.joiner.whoAmI()).publicKey)
    expect(book?.watchers[0]?.since).toBeGreaterThan(0)
  }, 60_000)

  it('4. the joiner types the answer, and the agent takes the task', async () => {
    // Ana's books, and not bo's output: the pane has said nothing since the
    // watch opened, so waiting for bytes at bo's end would be waiting on a
    // condition that is already true and therefore on nothing at all — and the
    // keystroke below would then race the watch it is meant to be seen
    // through.
    await until(async () => (await anasBookFor())?.watchers.length === 1, 'ana to see bo reading before he types')

    // NOTHING RUNS UNTIL ANA SAYS SO. The keystroke crosses the relay, reaches
    // her machine, and stops there: her runtime holds the bytes and asks her,
    // and bo's own call stays open across the wait rather than being answered
    // with a guess.
    const answering = boTypes('1\r')
    await until(async () => (await anasQuestions()).requests.length > 0, 'ana to be asked about bo')
    const [question] = (await anasQuestions()).requests
    expect(question).toMatchObject({ handle: 'bo', terminalId: anasPane.id, writes: 1 })
    // What she is shown is what he sent, with the return that would submit it
    // drawn rather than obeyed — the preview is rendered so that bytes chosen
    // by somebody else cannot paint the question being asked about them.
    expect(question?.preview).toBe('1⏎')
    // And the agent has not moved: it is still asking, because nothing has
    // reached the pty.
    expect(await anasScrollback()).not.toMatch(/taking task 1/)

    // She allows it — for this pane and this teammate, until her runtime or
    // the link ends — and only now does anything happen.
    await anaAllows('session')
    expect(await answering).toEqual({ written: true })

    // Through a real pty on ana's machine and back out of the program that was
    // blocked reading it. A promise that resolved would prove nothing; this is
    // the agent acting on the answer.
    expect(await readUntil(peers.leader, anasPane.id, /taking task 1/)).toMatch(/taking task 1/)

    // And the live tail, which is the half of the watch step 3's scrollback
    // could not show: the same bytes came back across the relay to bo.
    await until(() => readThroughRelay().includes('taking task 1'), 'the answer to reach bo’s window')
  }, 60_000)

  it('5. the leader sees bo attributed, live and in the audit log', async () => {
    const sentAt = Date.now()
    // Half a line, deliberately. The program is blocked on a newline, so
    // nothing has happened yet — which is what makes the attribution below a
    // live answer about somebody at a keyboard rather than a record of a write
    // that already finished.
    await boTypes('bo-was-here')
    await until(async () => ((await anasBookFor())?.typists.length ?? 0) > 0, 'ana to see somebody typing')

    // One more keystroke, and then the read: "is typing" has to be true now,
    // not whenever the poll above happened to succeed.
    await boTypes('!')
    const books = await anasBooks()
    const typist = books.panes.find((pane) => pane.terminalId === anasPane.id)?.typists[0]
    expect(typist?.handle).toBe('bo')
    expect(typist?.publicKey).toBe((await peers.joiner.whoAmI()).publicKey)
    expect(typist?.at).toBeGreaterThanOrEqual(sentAt)
    expect(books.readAt - (typist?.at ?? 0)).toBeLessThan(TYPING_WINDOW_MS)

    // The line lands when he finishes it, which is what says the half-typed
    // attribution above was of a write still in progress.
    await boTypes('\r')
    expect(await readUntil(peers.leader, anasPane.id, /heard bo-was-here!/)).toMatch(/heard bo-was-here!/)

    // The other promise, and a different one: a record ana can read afterwards,
    // on her own machine, without asking anybody.
    const log = await peers.leader.call('teamwork.writeLog', {})
    const mine = log.writes.filter((write: { handle: string }) => write.handle === 'bo')
    expect(mine.length).toBeGreaterThan(0)
    expect(mine[mine.length - 1]).toMatchObject({
      handle: 'bo',
      terminalId: anasPane.id,
      projectId: peers.leader.projectId,
      outcome: 'written'
    })
    expect(mine.every((write: { at: number }) => write.at >= sentAt - 60_000 && write.at <= Date.now())).toBe(true)
    // What it must never hold. The bytes are on ana's screen; keeping them here
    // would make her audit trail a store of whatever a teammate's terminal
    // chose not to echo.
    expect(JSON.stringify(log)).not.toContain('bo-was-here')
  }, 60_000)

  it('6. the leader mutes the pane, and the joiner’s typing stops arriving', async () => {
    await peers.leader.call('teamwork.mute', { terminalId: anasPane.id, muted: true })

    await expect(boTypes('after-the-mute\r')).rejects.toMatchObject({ code: ErrorCode.Conflict })
    // Long enough that a keystroke on its way would have arrived.
    await sleep(500)

    // The assertion is about ana's pty, not about bo being told no: what
    // matters is that nothing arrived, whatever bo's end believes.
    const scrollback = await anasScrollback()
    expect(scrollback).not.toContain('after-the-mute')
    expect(scrollback).not.toContain('heard after-the-mute')

    // Refused is not the same as unrecorded. Somebody still typing at a pane
    // she has muted is exactly what ana wants to know.
    const log = await peers.leader.call('teamwork.writeLog', {})
    const refused = log.writes.filter((write: { outcome: string }) => write.outcome === 'muted')
    expect(refused.map((write: { handle: string }) => write.handle)).toContain('bo')
    expect((await anasBookFor())?.typists[0]?.refused).toBeGreaterThan(0)
  }, 60_000)

  it('6b. the muted pane is still visible, because mute is not hiding', async () => {
    // Still muted: this is the state step 6 left, and the point is what is
    // visible while it holds.
    expect((await anasBookFor())?.muted).toBe(true)

    const row = await anasRow()
    expect(row?.name).toBe(worktree.name)
    expect(row?.panes.map((pane) => pane.id)).toContain(bosPaneId)
    expect(row?.live).toBe(true)

    // And it is still streaming. Mute is about what arrives, never about what
    // leaves — so ana's own hand on her own pane still reaches bo's window.
    await peers.leader.call('terminal.write', { terminalId: anasPane.id, data: 'still-talking\r' })
    await until(() => readThroughRelay().includes('heard still-talking'), 'a muted pane’s output to reach bo')
  }, 60_000)

  it('7. a peer whose key is not in the roster cannot complete the handshake', async () => {
    const stranger = await peers.addPeer('cass')
    // She has both of their keys and the team's relay, because she cloned the
    // same repository. What she does not have is a key in it.
    expect((await stranger.roster()).map((member: { handle: string }) => member.handle)).toEqual(['ana', 'bo'])

    // She dials: her own roster wants both of them, so both links exist and try.
    await until(async () => (await stranger.links()).length === 2, 'cass to start dialling both members')

    // The control, taken while she is failing: the relay is up and the two
    // members on it are connected over it. Whatever stops her is not the relay.
    expect((await peers.leader.links())[0]?.phase).toBe('connected')

    // Long enough that a handshake that was going to complete would have.
    await sleep(3_000)
    const links = await stranger.links()
    expect(links.map((link: { phase: string }) => link.phase)).not.toContain('connected')

    // And she never reached the catalogue at all: no worktrees, and nothing
    // ever heard from anybody. A rendezvous is derived from the two keys, so a
    // peer who is not on the roster is not merely turned away at the door —
    // there is no door at the address she can compute.
    const view = await rosterOf(stranger.call('teamwork.presence', { projectId: stranger.projectId }))
    expect(view.worktrees).toEqual([])
    expect(view.teammates).toEqual([
      { handle: 'ana', publicKey: (await peers.leader.whoAmI()).publicKey, connected: false, heardAt: null },
      { handle: 'bo', publicKey: (await peers.joiner.whoAmI()).publicKey, connected: false, heardAt: null }
    ])

    // The same runtime, the same relay, the same keys — and it connects the
    // moment the repository says she is a member. Without this, everything
    // above would pass equally for a harness that never plugged her in.
    await stranger.addSelfToRoster()
    await stranger.commit('Add cass to the team', ['.teamree'])
    await stranger.gitPush()
    for (const member of peers.peers) await member.gitPull()
    await stranger.waitForLink({ timeoutMs: 60_000 })
  }, 180_000)

  it('8. the leader goes offline and her worktrees go stale, not absent', async () => {
    const before = (await bosView()).worktrees.filter((row) => row.handle === 'ana')
    expect(before.length).toBeGreaterThan(0)

    // Her runtime stops, so the socket closes and bo's end learns of it at once.
    // The other ending — a lid shut on a live socket — takes bo's own silence
    // deadline in `peerLink.ts` to notice, and is covered there rather than here,
    // because five minutes of real time is not a thing to put in this file.
    await peers.leader.stop()

    await until(async () => {
      const view = await bosView()
      return view.teammates.find((who) => who.handle === 'ana')?.connected === false
    }, 'bo to notice ana has gone')

    const away = await bosView()
    const rows = away.worktrees.filter((row) => row.handle === 'ana')
    // Not one row fewer. A row vanishing reads as "it was deleted", which for a
    // worktree is the one thing this display must never wrongly say.
    expect(rows.map((row) => row.name)).toEqual(before.map((row) => row.name))
    expect(rows.map((row) => row.branch)).toEqual(before.map((row) => row.branch))
    expect(rows.every((row) => row.live)).toBe(false)

    // Stale, and dated: the age of what is being shown, by bo's own clock.
    for (const row of rows) {
      expect(row.heardAt).toBeGreaterThan(0)
      expect(away.readAt - row.heardAt).toBeGreaterThanOrEqual(0)
    }

    // Heard, and heard a while ago — never the shape of a teammate never seen.
    const ana = away.teammates.find((who) => who.handle === 'ana')
    expect(ana?.connected).toBe(false)
    expect(ana?.heardAt).not.toBeNull()

    // And bo is not left on a pane that looks live and has stopped moving.
    await until(() => pushed.some((event) => event.type === 'lost'), 'bo to be told the pane he was reading has gone')
  }, 120_000)
})
