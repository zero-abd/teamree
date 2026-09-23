// What "unread" is allowed to mean, and every way it could be a lie.
//
// The mark is the only thing in this window that claims to know something about
// the reader rather than about the work, so each of these is about the claim
// being false rather than about the arithmetic: a pane somebody is watching
// must never carry it, a pane opened on screen must lose it, and a record
// storage could not keep must leave the window saying nothing rather than
// saying everything is new.

import { describe, expect, it, vi } from 'vitest'
import type { Layout, Terminal } from '@shared/entities'

vi.mock('../runtimeClient/currentRuntimeClient', async () => {
  const { createSeededRuntimeClient } = await import('../runtimeClient/seededRuntimeClient')
  return { runtimeClient: createSeededRuntimeClient() }
})

import {
  forgetClosedPanes,
  isPaneUnread,
  markSeen,
  paneInFront,
  panesOnScreen,
  readPaneSeen,
  unreadPaneIds,
  writePaneSeen,
  type FrontOfWindow
} from './paneSeen'
import { useWorkspaceStore } from './workspaceStore'

const KEY = 'teamree.workspace.paneSeen'
const NOW = 1_700_000_000_000

function storageWith(raw?: string): Pick<Storage, 'getItem' | 'setItem'> & { written: Record<string, string> } {
  const written: Record<string, string> = {}
  return {
    written,
    getItem: (key) => (key === KEY && raw !== undefined ? raw : null),
    setItem: (key, value) => {
      written[key] = value
    }
  }
}

/** Storage that throws on both halves, as a private window's can. */
const refusingStorage: Pick<Storage, 'getItem' | 'setItem'> = {
  getItem: () => {
    throw new Error('the user denied access to storage')
  },
  setItem: () => {
    throw new Error('the user denied access to storage')
  }
}

const terminal = (id: string, lastOutputAt: number): Terminal => ({
  id,
  worktreeId: 'w1',
  title: 'zsh',
  cwd: '/repos/teamree',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  running: true,
  busy: false,
  lastOutputAt
})

const layout = (focusedTerminalId: string | null, terminalIds: string[] = ['t1', 't2']): Layout => ({
  worktreeId: 'w1',
  root:
    terminalIds.length === 1
      ? { kind: 'leaf', terminalId: terminalIds[0] as string }
      : {
          kind: 'split',
          direction: 'row',
          sizes: terminalIds.map(() => 1 / terminalIds.length),
          children: terminalIds.map((terminalId) => ({ kind: 'leaf', terminalId }) as const)
        },
  focusedTerminalId
})

const front = (over: Partial<FrontOfWindow> = {}): FrontOfWindow => ({
  activeWorktreeId: 'w1',
  layouts: { w1: layout('t1') },
  expandedTerminalId: null,
  focusedWatchId: null,
  dashboardOpen: false,
  settingsOpen: false,
  helpOpen: false,
  teamworkProjectId: null,
  ...over
})

describe('what makes a pane unread', () => {
  it('is output that arrived after this person last had it in front of them', () => {
    const panes = { t1: terminal('t1', NOW), t2: terminal('t2', NOW - 60_000) }
    const unread = unreadPaneIds(panes, { t1: NOW - 30_000, t2: NOW - 30_000 }, null)

    expect(unread.has('t1')).toBe(true)
    expect(unread.has('t2')).toBe(false)
  })

  it('never marks the pane somebody is looking at, however much it prints', () => {
    // The debounce writes the focused pane down every half minute, so between
    // two of those writes a working agent has always printed since. This is the
    // rule that stops a pip appearing on the pane being watched, and it is a
    // rule rather than a race deliberately.
    const watched = terminal('t1', NOW)
    expect(isPaneUnread(watched, NOW - 30_000, true)).toBe(false)
    expect(isPaneUnread(watched, NOW - 30_000, false)).toBe(true)
    expect(unreadPaneIds({ t1: watched }, { t1: NOW - 30_000 }, 't1').size).toBe(0)
  })

  it('has nothing to say about a pane with no record, other than that nobody has read it', () => {
    expect(isPaneUnread(terminal('t1', NOW), undefined, false)).toBe(true)
  })
})

describe('what is on screen', () => {
  it('is the open worktree’s panes, and none at all while another surface has the area', () => {
    expect(panesOnScreen(front())).toEqual(['t1', 't2'])
    expect(panesOnScreen(front({ dashboardOpen: true }))).toEqual([])
    expect(panesOnScreen(front({ settingsOpen: true }))).toEqual([])
    expect(panesOnScreen(front({ helpOpen: true }))).toEqual([])
    expect(panesOnScreen(front({ teamworkProjectId: 'p1' }))).toEqual([])
    expect(panesOnScreen(front({ activeWorktreeId: null }))).toEqual([])
  })

  it('is one pane while one is maximised', () => {
    expect(panesOnScreen(front({ expandedTerminalId: 't2' }))).toEqual(['t2'])
  })

  it('has nothing in front while a teammate’s pane holds the focus, or while the board does', () => {
    expect(paneInFront(front())).toBe('t1')
    expect(paneInFront(front({ focusedWatchId: 'watch_1' }))).toBeNull()
    expect(paneInFront(front({ dashboardOpen: true }))).toBeNull()
    // Focused in the layout, but not one of the panes actually drawn.
    expect(paneInFront(front({ expandedTerminalId: 't2' }))).toBeNull()
  })
})

describe('the record', () => {
  it('reads back what was written', () => {
    const storage = storageWith()
    writePaneSeen(storage, { t1: NOW, t2: NOW - 1000 })

    expect(readPaneSeen(storageWith(storage.written[KEY]))).toEqual({ t1: NOW, t2: NOW - 1000 })
  })

  it('has nothing to say when nothing was written, or when storage refuses', () => {
    expect(readPaneSeen(storageWith())).toEqual({})
    expect(readPaneSeen(undefined)).toEqual({})
    expect(readPaneSeen(refusingStorage)).toEqual({})
    expect(() => writePaneSeen(refusingStorage, { t1: NOW })).not.toThrow()
  })

  it('ignores a record that is not what it wrote', () => {
    expect(readPaneSeen(storageWith('not json at all'))).toEqual({})
    expect(readPaneSeen(storageWith('null'))).toEqual({})
    expect(readPaneSeen(storageWith('["t1"]'))).toEqual({})
    expect(readPaneSeen(storageWith('{"t1":"yesterday","t2":' + NOW + '}'))).toEqual({ t2: NOW })
  })

  it('keeps only the panes the runtime still lists, and only as many as a window could hold', () => {
    expect(forgetClosedPanes({ t1: NOW, gone: NOW }, { t1: terminal('t1', NOW) })).toEqual({ t1: NOW })

    const storage = storageWith()
    const many = Object.fromEntries(Array.from({ length: 400 }, (_, index) => [`t${index}`, NOW - index]))
    writePaneSeen(storage, many)
    expect(Object.keys(readPaneSeen(storageWith(storage.written[KEY])))).toHaveLength(256)
  })

  it('is the same object when there is nothing new to write down', () => {
    const seen = { t1: NOW }
    expect(markSeen(seen, ['t1'], NOW)).toBe(seen)
    expect(markSeen(seen, [], NOW + 1)).toBe(seen)
    expect(markSeen(seen, ['t1'], NOW + 1)).toEqual({ t1: NOW + 1 })
  })
})

describe('the window', () => {
  it('clears a pane the moment the focus lands on it', () => {
    const panes = { t1: terminal('t1', NOW), t2: terminal('t2', NOW) }
    useWorkspaceStore.setState({
      terminals: panes,
      layouts: { w1: layout('t1') },
      activeWorktreeId: 'w1',
      focusedWatchId: null,
      paneSeenAt: { t1: NOW - 60_000, t2: NOW - 60_000 }
    })

    expect(unreadPaneIds(panes, useWorkspaceStore.getState().paneSeenAt, 't1').has('t2')).toBe(true)

    useWorkspaceStore.getState().focusPane('t2')

    const seen = useWorkspaceStore.getState().paneSeenAt
    expect(seen.t2).toBeGreaterThan(NOW - 60_000)
    expect(unreadPaneIds(panes, seen, 't2').size).toBe(0)
    // And the pane it was taken off is written down too: what was on screen up
    // to this moment has been seen up to this moment.
    expect(seen.t1).toBeGreaterThan(NOW - 60_000)
  })
})
