// Routing and delivery against fake panes: who a message reaches, when it is pasted,
// and when it waits.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Terminal, Worktree } from '../../shared/entities'
import type { WorktreeReport } from '../../shared/tasks'
import { DELIVERY_GAP_MS, PASTE_SETTLE_MS, TYPING_WINDOW_MS } from './delivery'
import { MessageService } from './messageService'

const worktree = (id: string, name: string, parentId?: string): Worktree => ({
  id,
  projectId: 'p1',
  name,
  branch: id,
  path: `/wt/${id}`,
  startedFrom: 'main',
  state: 'ready',
  createdAt: 1,
  ...(parentId === undefined ? {} : { parentId })
})

const pane = (id: string, worktreeId: string, extra: Partial<Terminal> = {}): Terminal => ({
  id,
  worktreeId,
  title: 'claude',
  cwd: '/',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  running: true,
  busy: false,
  lastOutputAt: 0,
  agent: 'claude',
  ...extra
})

let dir: string
let now: number
let timers: { at: number; run: () => void }[]
let panes: Terminal[]
let written: { terminalId: string; data: string }[]
let reports: Record<string, WorktreeReport>
let worktrees: Worktree[]
let changes: number
let asked: number[]
let asking: ReadonlyMap<string, number>
let service: MessageService

/** Runs every timer due by `now`, as the clock moves. */
function advance(ms: number): void {
  now += ms
  for (;;) {
    const due = timers.filter((timer) => timer.at <= now).sort((a, b) => a.at - b.at)[0]
    if (due === undefined) return
    timers.splice(timers.indexOf(due), 1)
    due.run()
  }
}

const pastes = (terminalId?: string): string[] =>
  written
    .filter((entry) => terminalId === undefined || entry.terminalId === terminalId)
    .map((entry) => entry.data)
    .filter((data) => data !== '\r')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'teamree-delivery-'))
  now = 1_000_000
  timers = []
  written = []
  reports = {}
  changes = 0
  asked = []
  asking = new Map()
  worktrees = [
    worktree('lead', 'Rate limits'),
    worktree('tests', 'Write tests', 'lead'),
    worktree('docs', 'Docs', 'lead')
  ]
  panes = [pane('t_lead', 'lead'), pane('t_tests', 'tests'), pane('t_docs', 'docs')]
  service = startService()
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function startService(): MessageService {
  return new MessageService({
    dir,
    worktrees: {
      list: () => worktrees,
      setReport: (worktreeId, report) => (reports[worktreeId] = report)
    },
    panes: {
      all: () => panes,
      list: (worktreeId) => panes.filter((entry) => entry.worktreeId === worktreeId),
      write: (terminalId, data) => {
        const target = panes.find((entry) => entry.id === terminalId)
        if (target === undefined || !target.running) throw new Error('exited')
        written.push({ terminalId, data })
      },
      asking: (byPane) => (asking = byPane)
    },
    changedPaths: async () => ['src/limiter.ts', 'src/limiter.test.ts'],
    onChange: () => (changes += 1),
    onAsk: (message) => asked.push(message.id),
    now: () => now,
    later: (run, ms) => {
      const timer = { at: now + ms, run }
      timers.push(timer)
      return { cancel: () => timers.splice(timers.indexOf(timer), 1) }
    }
  })
}

const fromTests = { worktreeId: 'tests', terminalId: 't_tests' }

describe('routing', () => {
  it('sends an ask to the parent, and to you from a top-level task or a parent with no agent', async () => {
    const [toParent] = await service.send({ from: fromTests, to: { relation: 'parent' }, kind: 'ask', text: 'Which?' })
    expect(toParent?.to).toEqual({ worktreeId: 'lead' })
    const [fromTop] = await service.send({
      from: { terminalId: 't_lead' },
      to: { relation: 'parent' },
      kind: 'ask',
      text: 'Ship it?'
    })
    expect(fromTop).toMatchObject({ from: { worktreeId: 'lead', terminalId: 't_lead' }, to: { you: true } })
    expect(asked).toEqual([fromTop?.id])

    panes = panes.filter((entry) => entry.id !== 't_lead')
    const [orphaned] = await service.send({ from: fromTests, to: { relation: 'parent' }, kind: 'ask', text: 'Q' })
    expect(orphaned?.to).toEqual({ you: true })
  })

  it('fans out to children and siblings, one message each', async () => {
    const toChildren = await service.send({
      from: { worktreeId: 'lead' },
      to: { relation: 'children' },
      kind: 'note',
      text: 'hi'
    })
    expect(toChildren.map((message) => message.to.worktreeId)).toEqual(['tests', 'docs'])
    const toSiblings = await service.send({ from: fromTests, to: { relation: 'siblings' }, kind: 'note', text: 'hi' })
    expect(toSiblings.map((message) => message.to.worktreeId)).toEqual(['docs'])
    await expect(
      service.send({ from: { worktreeId: 'docs' }, to: { relation: 'children' }, kind: 'note', text: 'x' })
    ).rejects.toThrow(/has no children/)
  })

  it('refuses a shell pane as an address', async () => {
    panes.push(pane('t_shell', 'lead', { agent: undefined, title: 'zsh' }))
    await expect(
      service.send({ from: fromTests, to: { terminalId: 't_shell' }, kind: 'note', text: 'x' })
    ).rejects.toThrow(/runs no agent/)
  })

  it('answers an ask once; a second answer names who won', async () => {
    const [ask] = await service.send({ from: fromTests, to: { relation: 'parent' }, kind: 'ask', text: 'Which?' })
    const [reply] = await service.send({
      from: { you: true },
      to: { you: true },
      kind: 'reply',
      replyTo: ask?.id as number,
      text: 'postgres'
    })
    // A reply goes to whoever asked, whatever it was addressed to.
    expect(reply?.to).toEqual(fromTests)
    expect(service.store.get(ask?.id as number)).toMatchObject({ state: 'answered', answeredBy: { you: true } })
    await expect(
      service.send({
        from: { terminalId: 't_lead' },
        to: fromTests,
        kind: 'reply',
        replyTo: ask?.id as number,
        text: 'redis'
      })
    ).rejects.toThrow('already answered by you')
  })

  it('records done as the report, with paths from git, and replaces an undelivered earlier one', async () => {
    panes[0] = { ...panes[0], busy: true } as Terminal
    const [first] = await service.send({
      from: fromTests,
      to: { relation: 'parent' },
      kind: 'done',
      text: 'Half. More.'
    })
    const [second] = await service.send({
      from: fromTests,
      to: { relation: 'parent' },
      kind: 'done',
      text: 'Added limiter. Tests pass.',
      outcome: 'failed'
    })
    expect(second).toMatchObject({ outcome: 'failed', paths: ['src/limiter.ts', 'src/limiter.test.ts'] })
    expect(reports['tests']).toMatchObject({ outcome: 'failed', summary: 'Added limiter. Tests pass.' })
    expect(service.store.get(first?.id as number)?.state).toBe('read')
  })
})

describe('delivery', () => {
  it('pastes into an idle agent pane, then presses Return', async () => {
    const [ask] = await service.send({
      from: fromTests,
      to: { relation: 'parent' },
      kind: 'ask',
      text: 'Which store?',
      options: ['redis', 'postgres']
    })
    expect(pastes('t_lead')).toEqual([
      `\x1b[200~[teamree] ask #${ask?.id} from "Write tests": Which store? (redis | postgres)\n` +
        `Answer: teamree msg reply ${ask?.id} "<answer>"\x1b[201~`
    ])
    expect(written.map((entry) => entry.data)).not.toContain('\r')
    advance(PASTE_SETTLE_MS)
    expect(written.at(-1)).toEqual({ terminalId: 't_lead', data: '\r' })
    expect(service.store.get(ask?.id as number)?.state).toBe('delivered')
  })

  it('queues for a working pane and pastes at its Stop', async () => {
    panes[0] = { ...panes[0], busy: true, agentEvent: { event: 'UserPromptSubmit', at: now } } as Terminal
    const [done] = await service.send({
      from: fromTests,
      to: { relation: 'parent' },
      kind: 'done',
      text: 'Added limiter.'
    })
    expect(pastes()).toEqual([])
    expect(done?.state).toBe('queued')

    panes[0] = { ...panes[0], busy: false, agentEvent: { event: 'Stop', at: now } } as Terminal
    service.delivery.pump()
    expect(pastes('t_lead')).toEqual([
      '\x1b[200~[teamree] "Write tests" done (succeeded): Added limiter. Files: 2. Merge: teamree worktree land tests\x1b[201~'
    ])
  })

  it('never pastes into a shell, an asking pane, or an exited one', async () => {
    panes = [
      pane('t_shell', 'lead', { agent: undefined }),
      pane('t_menu', 'lead', { screenSays: 'waiting' }),
      pane('t_gone', 'lead', { running: false, exitCode: 0 }),
      ...panes.slice(1)
    ]
    await service.send({ from: fromTests, to: { worktreeId: 'lead' }, kind: 'note', text: 'fyi' })
    advance(10_000)
    expect(pastes()).toEqual([])
  })

  it('holds a paste while a person types, and delivers once they stop', async () => {
    service.delivery.noteTyped('t_lead')
    await service.send({ from: fromTests, to: { relation: 'parent' }, kind: 'note', text: 'fyi' })
    expect(pastes()).toEqual([])
    advance(TYPING_WINDOW_MS - 1)
    expect(pastes()).toEqual([])
    advance(1)
    expect(pastes('t_lead')).toHaveLength(1)
  })

  it('gives a pane one message at a time: the next at its Stop or after the gap', async () => {
    await service.send({ from: fromTests, to: { relation: 'parent' }, kind: 'note', text: 'one' })
    await service.send({ from: { worktreeId: 'docs' }, to: { relation: 'parent' }, kind: 'note', text: 'two' })
    await service.send({ from: fromTests, to: { relation: 'parent' }, kind: 'note', text: 'three' })
    expect(pastes('t_lead')).toHaveLength(1)

    panes[0] = { ...panes[0], agentEvent: { event: 'Stop', at: now + 1 } } as Terminal
    now += 1
    service.delivery.pump()
    expect(pastes('t_lead')).toHaveLength(2)
    advance(DELIVERY_GAP_MS)
    expect(pastes('t_lead').map((text) => text.includes('three'))).toEqual([false, false, true])
  })

  it('does not paste a message already pulled', async () => {
    panes[0] = { ...panes[0], busy: true } as Terminal
    const [note] = await service.send({ from: fromTests, to: { relation: 'parent' }, kind: 'note', text: 'fyi' })
    expect(service.read([note?.id as number])).toEqual({ read: 1 })
    panes[0] = { ...panes[0], busy: false } as Terminal
    service.delivery.pump()
    expect(pastes()).toEqual([])
  })

  it('never pastes a message meant for you', async () => {
    await service.send({ from: { terminalId: 't_lead' }, to: { relation: 'parent' }, kind: 'ask', text: 'Ship it?' })
    advance(10_000)
    expect(pastes()).toEqual([])
  })

  it('keeps a paste within the message budget', async () => {
    const [note] = await service.send({
      from: fromTests,
      to: { relation: 'parent' },
      kind: 'note',
      text: 'é'.repeat(4096)
    })
    const pasted = pastes('t_lead')[0] ?? ''
    expect(new TextEncoder().encode(pasted.slice(6, -6)).length).toBeLessThanOrEqual(8192)
    expect(pasted.endsWith('…\x1b[201~')).toBe(true)
    expect(note?.text).toHaveLength(4096)
  })
})

describe('an ask for you', () => {
  const askYou = async (): Promise<number> => {
    const [ask] = await service.send({ from: fromTests, to: { you: true }, kind: 'ask', text: 'Sandbox or live?' })
    return ask?.id as number
  }
  const reply = (id: number): Promise<unknown> =>
    service.send({ from: { you: true }, to: fromTests, kind: 'reply', replyTo: id, text: 'Sandbox' })

  it('marks the asking pane until it is answered', async () => {
    const id = await askYou()
    expect([...asking]).toEqual([['t_tests', id]])
    await reply(id)
    expect([...asking]).toEqual([])
  })

  it('once the asker stops waiting, refuses a reply and takes a note answering it', async () => {
    const id = await askYou()
    now += 5
    expect(service.waiting([id], false)).toEqual({ changed: 1 })
    expect(service.store.get(id)?.expiredAt).toBe(now)
    expect([...asking]).toEqual([])
    await expect(reply(id)).rejects.toThrow('stopped waiting')

    // To whoever asked, as a reply goes, whatever it was addressed to.
    await service.send({ from: { you: true }, to: { you: true }, kind: 'note', replyTo: id, text: 'Sandbox' })
    expect(service.store.get(id)).toMatchObject({ state: 'answered', answeredBy: { you: true } })
    expect(pastes('t_tests')).toEqual(['\x1b[200~[teamree] note from "you", answering #1: Sandbox\x1b[201~'])
  })

  it('refuses a note answering an ask still waited on, or dismissing it', async () => {
    const id = await askYou()
    expect(service.read([id])).toEqual({ read: 0 })
    await expect(
      service.send({ from: { you: true }, to: fromTests, kind: 'note', replyTo: id, text: 'Sandbox' })
    ).rejects.toThrow('still waiting')
  })

  it('waits again on resume', async () => {
    const id = await askYou()
    service.waiting([id], false)
    expect(service.waiting([id], true)).toEqual({ changed: 1 })
    expect(service.store.get(id)?.expiredAt).toBeUndefined()
    expect([...asking]).toEqual([['t_tests', id]])
    await reply(id)
    expect(service.store.get(id)?.state).toBe('answered')
  })

  it('stops waiting when its pane exits, and when the app restarts', async () => {
    const first = await askYou()
    service.paneExited('t_tests')
    expect(service.store.get(first)?.expiredAt).toBe(now)
    expect(service.read([first])).toEqual({ read: 1 })
    const second = await askYou()
    service = startService()
    expect(service.store.get(second)?.expiredAt).toBe(now)
  })
})
