// An agent pane that ended, run again: its conversation comes back, by the id the agent
// named as it left, and nothing but the agent's own output is left in the pane.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Layout } from '../../shared/entities'
import type { TerminalEvent } from '../../shared/methods'
import type { RemotePty } from '../paneHost/client'
import type { PaneHostPort } from '../paneHost/hosting'
import type { ConversationEvidence } from './agent-conversations'
import { waitUntil } from './pty-test-support'
import type { TerminalRecord } from './session-restore'
import type { RecordedScrollback } from './scrollbackRecord'
import {
  TerminalSessionManager,
  type LayoutRepository,
  type ScrollbackRepository,
  type SessionRepository
} from './session-manager'

const TASK = 'Make the pager stream'
const SAID = '5d0c6a0e-9a41-4d1b-8f3e-2b7c1e9d4a60'
const EXIT_LINE = `\r\n\x1b[2mResume this session with:\r\nclaude --resume ${SAID}\x1b[0m\r\n`

/** One spawned child, driven by the test: what it prints, and when it exits. */
class FakeChild {
  // No pid: nothing here may signal a real process.
  readonly pid = 0
  readonly process = 'claude'
  private readonly data = new Set<(chunk: string) => void>()
  private readonly exits = new Set<(event: { exitCode: number; signal?: number }) => void>()

  constructor(readonly args: readonly string[]) {}

  onData = (listener: (chunk: string) => void) => subscribe(this.data, listener)
  onExit = (listener: (event: { exitCode: number; signal?: number }) => void) => subscribe(this.exits, listener)
  write(): void {}
  resize(): void {}
  kill(): void {}

  print(text: string): void {
    for (const listener of [...this.data]) listener(text)
  }

  exit(exitCode = 0): void {
    for (const listener of [...this.exits]) listener({ exitCode })
  }

  /** The line the shell was asked to run. */
  get line(): string {
    return this.args.at(-1) ?? ''
  }
}

function subscribe<T>(set: Set<T>, listener: T): { dispose: () => void } {
  set.add(listener)
  return { dispose: () => set.delete(listener) }
}

/** A pane host that starts nothing: every spawn is recorded and handed back as a child the test drives. */
function spawnSpy(): { host: PaneHostPort; spawned: FakeChild[] } {
  const spawned: FakeChild[] = []
  const host: PaneHostPort = {
    live: () => [],
    accepting: () => true,
    spawn: (_terminal, _file, args) => {
      const child = new FakeChild(args)
      spawned.push(child)
      children.push(child)
      return child as unknown as RemotePty
    },
    attach: () => {
      throw new Error('nothing to attach to')
    },
    kill: () => {},
    keeps: () => false,
    release: async () => {},
    status: async () => null,
    stop: async () => null
  }
  return { host, spawned }
}

function repositories(): LayoutRepository &
  SessionRepository & { records: Map<string, TerminalRecord>; scrollback: ScrollbackRepository } {
  const layouts = new Map<string, Layout>()
  const records = new Map<string, TerminalRecord>()
  const kept = new Map<string, RecordedScrollback>()
  return {
    records,
    scrollback: {
      read: (terminalId) => kept.get(terminalId),
      put: (terminalId, text) => void kept.set(terminalId, { text, recordedAt: 0 }),
      remove: (terminalId) => void kept.delete(terminalId),
      flush: async () => {}
    },
    getLayout: (worktreeId) => layouts.get(worktreeId),
    putLayout: (layout) => {
      layouts.set(layout.worktreeId, layout)
      return layout
    },
    listLayouts: () => [...layouts.values()],
    listTerminals: () => [...records.values()],
    putTerminal: (row) => {
      records.set(row.id, row)
      return row
    },
    removeTerminal: (terminalId) => records.delete(terminalId)
  }
}

const managers: TerminalSessionManager[] = []
const children: FakeChild[] = []
const scratch: string[] = []

afterEach(async () => {
  // Ended first, or each quit waits out its grace for a child that cannot hear it.
  for (const child of children.splice(0)) child.exit(129)
  await Promise.all(managers.splice(0).map((created) => created.shutdown()))
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function setup(evidence: ConversationEvidence = 'unknown', stores = repositories()) {
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'teamree-ended-agent-'))
  scratch.push(checkout)
  return { ...start(checkout, evidence, stores), checkout, stores }
}

function start(checkout: string, evidence: ConversationEvidence, stores: ReturnType<typeof repositories>) {
  const { host, spawned } = spawnSpy()
  const manager = new TerminalSessionManager({
    resolveWorktreeCwd: (worktreeId) => (worktreeId === 'wt_1' ? checkout : undefined),
    resolveWorktreeTask: () => TASK,
    defaultShell: () => '/bin/sh',
    conversationEvidence: () => evidence,
    paneHost: host,
    layouts: stores,
    sessions: stores,
    scrollback: stores.scrollback
  })
  managers.push(manager)
  return { manager, spawned }
}

async function ended(manager: TerminalSessionManager, terminalId: string): Promise<void> {
  await waitUntil(() => manager.list().find((pane) => pane.id === terminalId)?.running === false, 'the pane to end')
}

const BOOKKEEPING = /end of record|\[record —|Resume this session|starts again below|resumes below/

describe('an ended agent pane run again', () => {
  it('resumes the session the agent named as it exited, and shows none of the bookkeeping', async () => {
    const { manager, spawned, stores } = await setup()
    const pane = manager.create({ worktreeId: 'wt_1', command: 'claude', prompt: TASK })
    const pinned = stores.records.get(pane.id)?.agentSessionId
    expect(spawned[0]?.line).toContain(`--session-id ${pinned}`)

    const seen: TerminalEvent[] = []
    manager.attachStream(pane.id, { emit: (event) => seen.push(event), close: () => {} })
    spawned[0]?.print('✻ worked on the pager\r\n')
    spawned[0]?.print(EXIT_LINE)
    spawned[0]?.exit(0)
    await ended(manager, pane.id)
    expect(manager.read(pane.id)).not.toMatch(BOOKKEEPING)

    const again = await manager.relaunch({ terminalId: pane.id })
    expect(again.running).toBe(true)
    expect(spawned).toHaveLength(2)
    expect(spawned[1]?.line).toContain(`--resume ${SAID}`)
    expect(spawned[1]?.line).not.toContain('--session-id')
    // Resumed, never re-told.
    expect(spawned[1]?.line).not.toContain(TASK)
    expect(stores.records.get(pane.id)?.agentSessionId).toBe(SAID)

    spawned[1]?.print('✻ back\r\n')
    const shown = manager.read(pane.id)
    expect(shown).not.toMatch(BOOKKEEPING)
    expect(shown.indexOf('worked on the pager')).toBeLessThan(shown.indexOf('back'))
    const streamed = seen.map((event) => (event.type === 'data' ? event.data : '')).join('')
    expect(streamed).not.toMatch(BOOKKEEPING)
    expect(streamed).toContain('back')
  })

  it('resumes the pinned session when the agent said none and somebody spoke to it', async () => {
    const { manager, spawned, stores } = await setup()
    const pane = manager.create({ worktreeId: 'wt_1', command: 'claude' })
    const pinned = stores.records.get(pane.id)?.agentSessionId
    manager.write(pane.id, 'hello\r')
    spawned[0]?.exit(0)
    await ended(manager, pane.id)

    await manager.relaunch({ terminalId: pane.id })
    expect(spawned[1]?.line).toContain(`--resume ${pinned}`)
  })

  it('starts over when there is no conversation behind it', async () => {
    const { manager, spawned, stores } = await setup('absent')
    const pane = manager.create({ worktreeId: 'wt_1', command: 'claude' })
    manager.write(pane.id, 'hello\r')
    spawned[0]?.exit(0)
    await ended(manager, pane.id)

    await manager.relaunch({ terminalId: pane.id })
    const fresh = stores.records.get(pane.id)?.agentSessionId
    expect(spawned[1]?.line).toContain(`--session-id ${fresh}`)
    expect(spawned[1]?.line).not.toContain('--resume')
    expect(spawned[1]?.line).not.toContain(TASK)
  })

  it('starts a new session when asked, without the task', async () => {
    const { manager, spawned, stores } = await setup('present')
    const pane = manager.create({ worktreeId: 'wt_1', command: 'claude' })
    spawned[0]?.print(EXIT_LINE)
    spawned[0]?.exit(0)
    await ended(manager, pane.id)

    await manager.relaunch({ terminalId: pane.id, fresh: true })
    const fresh = stores.records.get(pane.id)?.agentSessionId
    expect(fresh).not.toBe(SAID)
    expect(spawned[1]?.line).toContain(`--session-id ${fresh}`)
    expect(spawned[1]?.line).not.toContain(TASK)
    expect(stores.records.get(pane.id)?.typed).toBe(false)
  })

  it('comes back after the app relaunched, and resumes again once that run ends', async () => {
    const { manager, spawned, stores, checkout } = await setup('present')
    const pane = manager.create({ worktreeId: 'wt_1', command: 'claude' })
    const pinned = stores.records.get(pane.id)?.agentSessionId
    manager.write(pane.id, 'hello\r')
    // Quit while it runs: the child hears the hang-up.
    const quitting = manager.shutdown()
    spawned[0]?.exit(129)
    await quitting
    managers.splice(managers.indexOf(manager), 1)
    expect(spawned).toHaveLength(1)

    const next = start(checkout, 'present', stores)
    expect(next.manager.restoreSessions()).toEqual({ restored: 1, resumed: 1 })
    expect(next.spawned[0]?.line).toContain(`--resume ${pinned}`)
    expect(next.manager.list()[0]?.restored).toBe('agent')

    next.spawned[0]?.print(EXIT_LINE)
    next.spawned[0]?.exit(0)
    await ended(next.manager, pane.id)
    await next.manager.relaunch({ terminalId: pane.id })
    expect(next.spawned[1]?.line).toContain(`--resume ${SAID}`)
    expect(next.manager.read(pane.id)).not.toMatch(BOOKKEEPING)
    // Picked back up, so the launch after this one resumes it too.
    expect(stores.records.get(pane.id)?.typed).toBe(true)
  })
})
