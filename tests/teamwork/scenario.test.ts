// The end-to-end teamwork scenario of docs/teamwork-scenario.md; step numbers are its step numbers.
// Act I makes every joiner move locally on the leader's machine first, so act II has one new
// variable: the relay. Act II is real relay, real Noise, real pty — the harness fakes only the distance.

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
// Plain ESM so the harness can be run by hand from a checkout; see two-peers.test.ts.
// @ts-expect-error -- untyped .mjs, deliberately outside the TypeScript build.
import { relayIsBuilt, startTwoPeers } from '../../scripts/teamwork/two-peers.mjs'

/**
 * Act II needs the relay's own build (a separate package); missing, it says so and skips.
 * `scripts/require-test-environment.mjs` stats the same file first and refuses to run rather than skip.
 */
const RELAY_BUILT = relayIsBuilt()

if (!RELAY_BUILT) {
  console.warn(
    '[scenario] act II is skipped: the relay is not built.\n' +
      '[scenario] build it with:  cd relay && npm ci && npm run build'
  )
}

/** A stand-in agent: prints, then blocks on input, so the pane goes quiet with a question on the last line. */
const STUCK_AGENT = 'printf "Which task should I take? "; read answer; printf "\\ntaking task %s\\n" "$answer"'

/** What the pane says before anybody opens it, and must never leak by itself. */
const UNWATCHED = 'reading TASKS.md, nobody is watching'

/**
 * The same agent, kept alive after answering so the steps after 4 have a pane to type at.
 * Echo is off: the scrollback holds what the program printed, never what was typed at it.
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
 * The roster out of a presence answer. Every peer is fully up before anything here asks,
 * so unread is the harness ahead of a runtime: a named failure beats `undefined` on the next line.
 */
async function rosterOf(answer: Promise<TeammatePresence>): Promise<TeammatePresenceRead> {
  const presence = await answer
  if (presence.state !== 'read') throw new Error(`teamwork has not read ${presence.projectId}’s roster yet`)
  return presence
}

/** Polls a condition nothing here can be woken for; the timeout is a failure mode, not a delay. */
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

  // Both keys in the repository first: the roster in git is what the Noise IK handshake
  // authenticates against. Each key is the runtime's own (`members.join`); harness-minted
  // keypairs would fail every act II handshake for a reason no assertion would explain.
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
    // Step 0 already tracked the project: adding a key goes through it.
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
    // The control for step 3: what the joiner reads over the relay is what `terminal.read` returns here.
    expect(await readUntil(peers.leader, pane.id, /Which task should I take\?/)).toMatch(/Which task/)
  }, 30_000)

  it('4a. typing into the pane reaches the program, which answers', async () => {
    // The control for step 4: `terminal.write` is the same method a peer calls across the transport.
    await peers.leader.call('terminal.write', { terminalId: pane.id, data: '3\r' })
    expect(await readUntil(peers.leader, pane.id, /taking task 3/)).toMatch(/taking task 3/)
  }, 30_000)

  it('2a. the worktree and its pane are visible in the workspace', async () => {
    // The control for step 2: the metadata that reaches the joiner without any subscription.
    const worktrees = await peers.leader.call('worktree.list')
    expect(worktrees.map((row: { id: string }) => row.id)).toContain(worktree.id)

    const terminals = await peers.leader.call('terminal.list', { worktreeId: worktree.id })
    expect(terminals.map((row: { id: string }) => row.id)).toContain(pane.id)
  })

  it('2b. a change in the workspace is announced rather than polled for', async () => {
    // The control for "the joiner sees it appear": the invalidation stream the GUI already runs on.
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
  // docs/teamwork-scenario.md step for step, between runtimes sharing only a git origin and a relay.

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

  /** Ana answering through the real methods: read from `teamwork.requests`, decided via `teamwork.decide`. */
  const anaAllows = async (decision: ConsentDecision): Promise<void> => {
    await until(async () => (await anasQuestions()).requests.length > 0, 'ana to be asked about bo')
    const [question] = (await anasQuestions()).requests
    if (question === undefined) throw new Error('ana was asked and then was not')
    await peers.leader.call('teamwork.decide', { requestId: question.id, decision })
  }

  beforeAll(async () => {
    // The relay, both outbound sockets, and the Noise IK handshake. Nothing is subscribed to here.
    await peers.linkPeers()

    // A fresh agent, started after the link so what act II watches actually crosses the wire.
    anasPane = await peers.leader.call('terminal.create', { worktreeId: worktree.id, command: ACT_TWO_AGENT })
    await readUntil(peers.leader, anasPane.id, /Which task should I take\?/)
  }, 180_000)

  afterAll(async () => {
    await bosWatch?.close()
  })

  it('2. the joiner sees the leader’s worktree appear, unasked', async () => {
    // Waits for a row nobody asked for, rather than reading one already arranged.
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

    // Her pane's state, not just its name: a running agent must draw differently from an exited one.
    const pane = row?.panes.find((candidate) => candidate.id.endsWith(`:${anasPane.id}`))
    expect(pane?.running).toBe(true)
    expect(pane?.cols).toBe(anasPane.cols)
    expect(pane?.rows).toBe(anasPane.rows)
    expect(pane?.quietForMs).toBeGreaterThanOrEqual(0)
    bosPaneId = pane?.id ?? ''

    // Every method this end has sent is recorded, so "metadata flows by default" is shown, not trusted.
    const subscribing = ['workspace.subscribe', 'terminal.subscribe', 'peer.subscribe', 'teamwork.watch']
    expect(peers.joiner.called.filter((method: string) => subscribing.includes(method))).toEqual([])
  }, 60_000)

  it('2c. no terminal output has crossed the wire yet', async () => {
    // The control: there is something to leak.
    expect(await anasScrollback()).toContain(UNWATCHED)

    // A snapshot carries names, branches, pane states and silences — never bytes.
    expect(JSON.stringify(await bosView())).not.toContain(UNWATCHED)
    // Nor has anything been made a pane of his own.
    expect(await peers.joiner.call('terminal.list')).toEqual([])

    // Ana's side of the same fact: nobody is reading any pane of hers, so nothing is being sent.
    expect((await anasBooks()).panes).toEqual([])
  })

  it('2d. a name ana gives her pane is the name bo sees', async () => {
    const bosPane = async (): Promise<{ label?: string } | undefined> =>
      (await anasRow())?.panes.find((pane) => pane.id === bosPaneId)
    expect((await bosPane())?.label).toBeUndefined()

    await peers.leader.call('terminal.rename', { terminalId: anasPane.id, label: 'task picker' })
    await until(async () => (await bosPane())?.label === 'task picker', 'the name to reach bo', 10_000)

    await peers.leader.call('terminal.rename', { terminalId: anasPane.id, label: null })
    await until(async () => (await bosPane())?.label === undefined, 'the cleared name to reach bo', 10_000)
  }, 30_000)

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
    // Including what it said before anybody opened it — the thing step 2c proved had not moved.
    expect(readThroughRelay()).toContain(UNWATCHED)

    // Letterboxed to ana's pty, not negotiated with bo's window.
    expect(bosWatch?.cols).toBe(size?.cols)
    expect(bosWatch?.rows).toBe(size?.rows)

    // Her pty is the size it was: `terminal.resize` is not on the list a teammate may call.
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
    // Ana's books, not bo's output: the pane has been silent since the watch opened, so
    // waiting for bytes at bo's end waits on nothing, and the keystroke would race the watch.
    await until(async () => (await anasBookFor())?.watchers.length === 1, 'ana to see bo reading before he types')

    // NOTHING RUNS UNTIL ANA SAYS SO: her runtime holds the bytes and asks her; bo's call stays open.
    const answering = boTypes('1\r')
    await until(async () => (await anasQuestions()).requests.length > 0, 'ana to be asked about bo')
    const [question] = (await anasQuestions()).requests
    expect(question).toMatchObject({ handle: 'bo', terminalId: anasPane.id, writes: 1 })
    // The return is drawn rather than obeyed, so bytes chosen by somebody else cannot paint the question.
    expect(question?.preview).toBe('1⏎')
    // And the agent has not moved: nothing has reached the pty.
    expect(await anasScrollback()).not.toMatch(/taking task 1/)

    // She allows it, and only now does anything happen.
    await anaAllows('session')
    expect(await answering).toEqual({ written: true })

    // Through a real pty and back out of the program blocked reading it.
    expect(await readUntil(peers.leader, anasPane.id, /taking task 1/)).toMatch(/taking task 1/)

    // And the live tail: the same bytes came back across the relay to bo.
    await until(() => readThroughRelay().includes('taking task 1'), 'the answer to reach bo’s window')
  }, 60_000)

  it('5. the leader sees bo attributed, live and in the audit log', async () => {
    const sentAt = Date.now()
    // Half a line, deliberately: the program is blocked on a newline, so the attribution
    // below is about somebody at a keyboard, not a write that already finished.
    await boTypes('bo-was-here')
    await until(async () => ((await anasBookFor())?.typists.length ?? 0) > 0, 'ana to see somebody typing')

    // One more keystroke, then the read: "is typing" has to be true now, not at the poll.
    await boTypes('!')
    const books = await anasBooks()
    const typist = books.panes.find((pane) => pane.terminalId === anasPane.id)?.typists[0]
    expect(typist?.handle).toBe('bo')
    expect(typist?.publicKey).toBe((await peers.joiner.whoAmI()).publicKey)
    expect(typist?.at).toBeGreaterThanOrEqual(sentAt)
    expect(books.readAt - (typist?.at ?? 0)).toBeLessThan(TYPING_WINDOW_MS)

    // The line lands when he finishes it.
    await boTypes('\r')
    expect(await readUntil(peers.leader, anasPane.id, /heard bo-was-here!/)).toMatch(/heard bo-was-here!/)

    // A record ana can read afterwards, on her own machine.
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
    // Never the bytes: the audit trail must not store what a teammate's terminal chose not to echo.
    expect(JSON.stringify(log)).not.toContain('bo-was-here')
  }, 60_000)

  it('6. the leader mutes the pane, and the joiner’s typing stops arriving', async () => {
    await peers.leader.call('teamwork.mute', { terminalId: anasPane.id, muted: true })

    await expect(boTypes('after-the-mute\r')).rejects.toMatchObject({ code: ErrorCode.Conflict })
    // Long enough that a keystroke on its way would have arrived.
    await sleep(500)

    // About ana's pty, not about bo being told no: nothing arrived.
    const scrollback = await anasScrollback()
    expect(scrollback).not.toContain('after-the-mute')
    expect(scrollback).not.toContain('heard after-the-mute')

    // Refused is not unrecorded: somebody typing at a muted pane is what ana wants to know.
    const log = await peers.leader.call('teamwork.writeLog', {})
    const refused = log.writes.filter((write: { outcome: string }) => write.outcome === 'muted')
    expect(refused.map((write: { handle: string }) => write.handle)).toContain('bo')
    expect((await anasBookFor())?.typists[0]?.refused).toBeGreaterThan(0)
  }, 60_000)

  it('6b. the muted pane is still visible, because mute is not hiding', async () => {
    // Still muted from step 6; the point is what is visible while it holds.
    expect((await anasBookFor())?.muted).toBe(true)

    const row = await anasRow()
    expect(row?.name).toBe(worktree.name)
    expect(row?.panes.map((pane) => pane.id)).toContain(bosPaneId)
    expect(row?.live).toBe(true)

    // Still streaming: mute is about what arrives, never about what leaves.
    await peers.leader.call('terminal.write', { terminalId: anasPane.id, data: 'still-talking\r' })
    await until(() => readThroughRelay().includes('heard still-talking'), 'a muted pane’s output to reach bo')
  }, 60_000)

  it('7. a peer whose key is not in the roster cannot complete the handshake', async () => {
    const stranger = await peers.addPeer('cass')
    // She has both keys and the relay from the clone; what she lacks is a key in it.
    expect((await stranger.roster()).map((member: { handle: string }) => member.handle)).toEqual(['ana', 'bo'])

    // She dials: her own roster wants both of them, so both links exist and try.
    await until(async () => (await stranger.links()).length === 2, 'cass to start dialling both members')

    // The control, taken while she fails: both members are connected over the relay.
    expect((await peers.leader.links())[0]?.phase).toBe('connected')

    // Long enough that a handshake that was going to complete would have.
    await sleep(3_000)
    const links = await stranger.links()
    expect(links.map((link: { phase: string }) => link.phase)).not.toContain('connected')

    // A rendezvous is derived from the two keys, so there is no door at the address she can compute.
    const view = await rosterOf(stranger.call('teamwork.presence', { projectId: stranger.projectId }))
    expect(view.worktrees).toEqual([])
    expect(view.teammates).toEqual([
      { handle: 'ana', publicKey: (await peers.leader.whoAmI()).publicKey, connected: false, heardAt: null },
      { handle: 'bo', publicKey: (await peers.joiner.whoAmI()).publicKey, connected: false, heardAt: null }
    ])

    // Same runtime, relay and keys: she connects the moment the repository says she is a member.
    await stranger.addSelfToRoster()
    await stranger.commit('Add cass to the team', ['.teamree'])
    await stranger.gitPush()
    for (const member of peers.peers) await member.gitPull()
    await stranger.waitForLink({ timeoutMs: 60_000 })
  }, 180_000)

  it('8. the leader goes offline and her worktrees go stale, not absent', async () => {
    const before = (await bosView()).worktrees.filter((row) => row.handle === 'ana')
    expect(before.length).toBeGreaterThan(0)

    // Her runtime stops, so the socket closes and bo learns at once. A lid shut on a live
    // socket takes the silence deadline in `peerLink.ts` to notice; covered there (five real minutes).
    await peers.leader.stop()

    await until(async () => {
      const view = await bosView()
      return view.teammates.find((who) => who.handle === 'ana')?.connected === false
    }, 'bo to notice ana has gone')

    const away = await bosView()
    const rows = away.worktrees.filter((row) => row.handle === 'ana')
    // Not one row fewer: a vanished row reads as "deleted", the one thing this must never wrongly say.
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
