// The three decisions a watched pane makes about somebody else's stream, taken
// out of the component so they can be stated rather than looked at.
//
// None of them is a matter of markup: what size the emulator is, whether a
// frame off the wire is a frame at all, and what happens to bytes that arrive
// before there is anything to draw them on. The rest of this view — the
// letterbox transform, the refusal line, the header — is only visible on a
// machine with a window, and is not what is checked here.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PeerPane, TeammatePresence, TeammateWorktree } from '@shared/entities'
import type { StreamEvent } from '@shared/protocol'
import { openStream } from '../runtime'
import { heldWrites, readWatchedPaneEvent, resizeWatchedPane, watchedPaneSize } from './WatchedPaneView'

const pane = (partial: Partial<PeerPane> = {}): PeerPane => ({
  id: 'ada:t1',
  title: 'agent',
  shell: '/bin/zsh',
  running: true,
  busy: false,
  quietForMs: 0,
  ...partial
})

const presence = (panes: PeerPane[], heardAt = 1_000): TeammatePresence => ({
  state: 'read',
  projectId: 'p1',
  worktrees: [
    {
      id: 'ada:wt1',
      name: 'the work',
      branch: 'feature',
      state: 'ready',
      panes,
      handle: 'ada',
      publicKey: 'k',
      heardAt,
      live: true
    } satisfies TeammateWorktree
  ],
  teammates: [],
  readAt: heardAt
})

describe('watchedPaneSize', () => {
  it('finds the owner’s dimensions for one pane, with when they were heard', () => {
    const found = watchedPaneSize(presence([pane({ id: 'ada:t0' }), pane({ cols: 200, rows: 50 })], 4_000), 'ada:t1')

    expect(found).toEqual({ cols: 200, rows: 50, heardAt: 4_000 })
  })

  // A peer that has not been rebuilt sends no dimensions at all, and a watcher
  // that filled in a guess would draw a frame the output does not fit.
  it('has no size for a pane whose owner sends none', () => {
    expect(watchedPaneSize(presence([pane()]), 'ada:t1')).toBeNull()
    expect(watchedPaneSize(presence([pane({ cols: 80 })]), 'ada:t1')).toBeNull()
  })

  it('has no size for a pane that is not in this presence, or for no presence at all', () => {
    expect(watchedPaneSize(presence([pane({ cols: 80, rows: 24 })]), 'bob:t9')).toBeNull()
    expect(watchedPaneSize(undefined, 'ada:t1')).toBeNull()
  })
})

describe('resizeWatchedPane', () => {
  const showing = { cols: 80, rows: 24 }

  // The defect this exists for: the owner drags a split, their pty reflows, and
  // every byte after it is addressed to a width this window is not. Nothing
  // else on this side ever hears about it, because a resize is not one of the
  // stream's events and `terminal.resize` is not a method a teammate may call.
  it('moves to the size the owner’s presence now reports', () => {
    expect(resizeWatchedPane({ cols: 200, rows: 50, heardAt: 9_000 }, 5_000, showing)).toEqual({ cols: 200, rows: 50 })
  })

  it('stays put when presence reports the size already on screen', () => {
    expect(resizeWatchedPane({ cols: 80, rows: 24, heardAt: 9_000 }, 5_000, showing)).toBeNull()
  })

  // The stream's own answer is a read of the owner's pty taken when the watch
  // was asked for. Presence older than that is the same fact read earlier, and
  // adopting it would walk a freshly opened pane backwards onto a stale number.
  it('ignores presence heard before the watch was asked for', () => {
    expect(resizeWatchedPane({ cols: 200, rows: 50, heardAt: 4_999 }, 5_000, showing)).toBeNull()
  })

  it('leaves the pane alone when there is no size to be had', () => {
    expect(resizeWatchedPane(null, 5_000, showing)).toBeNull()
  })
})

describe('readWatchedPaneEvent', () => {
  it('passes the five events a teammate’s pane is allowed to send', () => {
    expect(readWatchedPaneEvent({ type: 'data', data: 'ls\r\n' })).toEqual({ type: 'data', data: 'ls\r\n' })
    expect(readWatchedPaneEvent({ type: 'exit', exitCode: 0 })).toEqual({ type: 'exit', exitCode: 0 })
    expect(readWatchedPaneEvent({ type: 'title', title: 'agent' })).toEqual({ type: 'title', title: 'agent' })
    expect(readWatchedPaneEvent({ type: 'elided', bytes: 4_096 })).toEqual({ type: 'elided', bytes: 4_096 })
    expect(readWatchedPaneEvent({ type: 'lost', reason: 'their link went' })).toEqual({
      type: 'lost',
      reason: 'their link went'
    })
  })

  // The whole reason this function exists: a peer's frames reach this window
  // without ever being parsed, so `term.write(42)` is one hostile — or merely
  // broken — teammate away.
  it('refuses a payload whose fields are not what the type says', () => {
    expect(readWatchedPaneEvent({ type: 'data', data: 42 })).toBeNull()
    expect(readWatchedPaneEvent({ type: 'data' })).toBeNull()
    expect(readWatchedPaneEvent({ type: 'exit', exitCode: '0' })).toBeNull()
    expect(readWatchedPaneEvent({ type: 'elided', bytes: 1.5 })).toBeNull()
    expect(readWatchedPaneEvent({ type: 'lost', reason: null })).toBeNull()
  })

  it('refuses anything that is not one of the five, and anything that is not an object', () => {
    expect(readWatchedPaneEvent({ type: 'resize', cols: 200, rows: 50 })).toBeNull()
    expect(readWatchedPaneEvent({})).toBeNull()
    expect(readWatchedPaneEvent(null)).toBeNull()
    expect(readWatchedPaneEvent('data')).toBeNull()
  })

  // Nothing rides along: what reaches the emulator is rebuilt from the fields
  // that were checked, not the object that happened to carry them.
  it('keeps only the fields it checked', () => {
    expect(readWatchedPaneEvent({ type: 'data', data: 'hi', extra: { toString: null } })).toEqual({
      type: 'data',
      data: 'hi'
    })
  })
})

describe('heldWrites', () => {
  // The stream is registered, and its buffered arrivals replayed, one
  // continuation before the emulator is built. Every write in between used to
  // land on a null terminal and be discarded with nothing said.
  it('replays, in order, what was written before there was anywhere to write it', () => {
    const written: string[] = []
    const held = heldWrites()

    held.write('first')
    held.write('second')
    expect(written).toEqual([])

    held.attach((text) => written.push(text))

    expect(written).toEqual(['first', 'second'])
  })

  it('writes straight through once attached, and replays nothing twice', () => {
    const written: string[] = []
    const held = heldWrites()

    held.write('before')
    held.attach((text) => written.push(text))
    held.write('after')

    expect(written).toEqual(['before', 'after'])
  })
})

// The ordering `heldWrites` exists for, reproduced on the transport rather than
// argued from the code: the stream's listener is registered, and whatever
// arrived ahead of the response is replayed, inside `openStream`'s own
// continuation — which is strictly before the caller's `.then` has built
// anything to draw on.
describe('a stream that emits before its own answer lands', () => {
  let emit: (frame: StreamEvent) => void = () => {}

  beforeEach(() => {
    let answer: (response: unknown) => void = () => {}
    const runtime = {
      call: () =>
        new Promise((resolve) => {
          answer = resolve
          // One turn late, so a frame can be pushed while the call is in flight.
          queueMicrotask(() => {
            emit({ stream: 's1', event: { type: 'data', data: 'the first bytes' } })
            answer({ ok: true, result: { subscription: 's1', cols: 80, rows: 24, handle: 'ada' } })
          })
        }),
      onStream: (listener: (frame: StreamEvent) => void) => {
        emit = listener
      },
      release: () => {}
    }
    Object.assign(globalThis, {
      window: { teamree: { runtime }, addEventListener: () => {} }
    })
  })

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window')
  })

  it('hands the caller its first bytes before it hands it the stream', async () => {
    const seen: string[] = []

    const opened = openStream('teamwork.watch', { projectId: 'p1', paneId: 'ada:t1' }, () => seen.push('event'))
    void opened.then(() => seen.push('opened'))
    await opened

    // The emulator is built where 'opened' is. Everything before it used to be
    // written to a terminal that did not exist yet.
    expect(seen).toEqual(['event', 'opened'])
  })
})
