// The join between a scrollback and a live tail, with the timing under test.
//
// This is the one place where the two calls a watch is made of can be resolved
// by hand, in an order a real link reaches on its own but never on demand. The
// relay test proves the whole thing works end to end; this proves it works when
// the pane is talking *during* the round trip, which is when it would go wrong.

import { describe, expect, it, vi } from 'vitest'
import type { MethodName, ParamsOf, ResultOf } from '../../../shared/methods'
import type { SubscriptionChannel } from '../../runtime/subscriptionHub'
import { watchPane, type WatchTarget } from './paneWatch'
import { parsePeerPaneId } from './peerService'

/** A teammate whose two answers are resolved by the test, one at a time. */
function scriptedPeer(): {
  target: WatchTarget
  /** Pushes a stream event the way the far side's pane would. */
  say: (event: unknown) => void
  answerSubscribe: (subscription: string) => Promise<void>
  answerRead: (data: string) => Promise<void>
  failRead: (reason: string) => Promise<void>
  calls: { method: string; params: unknown }[]
} {
  const calls: { method: string; params: unknown }[] = []
  let routed: ((event: unknown) => void) | undefined
  let settleSubscribe: ((value: unknown) => void) | undefined
  let settleRead: ((value: unknown) => void) | undefined
  let rejectRead: ((error: Error) => void) | undefined

  const target: WatchTarget = {
    call: (<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> => {
      calls.push({ method, params })
      if (method === 'terminal.subscribe') {
        return new Promise((resolve) => {
          settleSubscribe = resolve as (value: unknown) => void
        })
      }
      if (method === 'terminal.read') {
        return new Promise((resolve, reject) => {
          settleRead = resolve as (value: unknown) => void
          rejectRead = reject
        })
      }
      return Promise.resolve({ unsubscribed: true } as ResultOf<M>)
    }) as WatchTarget['call'],
    route: (_subscription, onEvent) => {
      routed = onEvent
      return () => {
        routed = undefined
      }
    }
  }

  const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 16; turn += 1) await Promise.resolve()
  }

  return {
    target,
    calls,
    say: (event) => routed?.(event),
    answerSubscribe: async (subscription) => {
      settleSubscribe?.({ subscription })
      await settle()
    },
    answerRead: async (data) => {
      settleRead?.({ data })
      await settle()
    },
    failRead: async (reason) => {
      rejectRead?.(new Error(reason))
      await settle()
    }
  }
}

function recorder(): { channel: SubscriptionChannel; events: unknown[]; closed: () => number } {
  const events: unknown[] = []
  let closes = 0
  return {
    events,
    closed: () => closes,
    channel: {
      emit: (event) => events.push(event),
      close: () => {
        closes += 1
      }
    }
  }
}

const output = (events: readonly unknown[]): string =>
  events
    .filter((event): event is { type: 'data'; data: string } => (event as { type?: string }).type === 'data')
    .map((event) => event.data)
    .join('')

describe('joining a pane that is already running', () => {
  it('subscribes before it reads, so nothing said in between is lost', async () => {
    const peer = scriptedPeer()
    const sink = recorder()
    watchPane({ target: peer.target, terminalId: 't1', channel: sink.channel })
    await peer.answerSubscribe('sub_1')

    expect(peer.calls.map((call) => call.method)).toEqual(['terminal.subscribe', 'terminal.read'])
  })

  it('shows output printed during the read exactly once, not twice and not never', async () => {
    const peer = scriptedPeer()
    const sink = recorder()
    watchPane({ target: peer.target, terminalId: 't1', channel: sink.channel })
    await peer.answerSubscribe('sub_1')

    // The pane keeps talking while the scrollback is in flight. Every one of
    // these is already in the snapshot by the time the owner answers, because
    // the owner wrote them before it.
    peer.say({ type: 'data', data: 'three\r\n' })
    peer.say({ type: 'data', data: 'four\r\n' })
    await peer.answerRead('one\r\ntwo\r\nthree\r\nfour\r\n')

    // And what it says afterwards is not in the snapshot and must arrive.
    peer.say({ type: 'data', data: 'five\r\n' })

    expect(output(sink.events)).toBe('one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n')
  })

  it('keeps an exit that arrived during the read, because a scrollback cannot hold one', async () => {
    const peer = scriptedPeer()
    const sink = recorder()
    watchPane({ target: peer.target, terminalId: 't1', channel: sink.channel })
    await peer.answerSubscribe('sub_1')

    peer.say({ type: 'data', data: 'done\r\n' })
    peer.say({ type: 'exit', exitCode: 3 })
    await peer.answerRead('building\r\ndone\r\n')

    expect(output(sink.events)).toBe('building\r\ndone\r\n')
    expect(sink.events).toContainEqual({ type: 'exit', exitCode: 3 })
  })

  it('says the watch is over rather than going quiet when the far side refuses', async () => {
    const peer = scriptedPeer()
    const sink = recorder()
    watchPane({ target: peer.target, terminalId: 't1', channel: sink.channel })
    await peer.answerSubscribe('sub_1')
    await peer.failRead('no terminal with id t1')

    expect(sink.events).toContainEqual({ type: 'lost', reason: 'no terminal with id t1' })
    expect(sink.closed()).toBe(1)
  })

  it('releases the teammate’s subscription when the watcher closes the pane', async () => {
    const peer = scriptedPeer()
    const sink = recorder()
    const stop = watchPane({ target: peer.target, terminalId: 't1', channel: sink.channel })
    await peer.answerSubscribe('sub_1')
    await peer.answerRead('')

    stop()

    expect(peer.calls).toContainEqual({ method: 'unsubscribe', params: { subscription: 'sub_1' } })
  })

  it('releases a subscription whose answer arrived after the watcher had already gone', async () => {
    const peer = scriptedPeer()
    const sink = recorder()
    const stop = watchPane({ target: peer.target, terminalId: 't1', channel: sink.channel })
    // Closed while the very first call is still in flight, which is what a
    // double-rendered React effect does on every mount.
    stop()
    await peer.answerSubscribe('sub_1')

    expect(peer.calls).toContainEqual({ method: 'unsubscribe', params: { subscription: 'sub_1' } })
    expect(peer.calls.map((call) => call.method)).not.toContain('terminal.read')
  })

  it('emits nothing at all once the watcher has closed it', async () => {
    const peer = scriptedPeer()
    const sink = recorder()
    const stop = watchPane({ target: peer.target, terminalId: 't1', channel: sink.channel })
    await peer.answerSubscribe('sub_1')
    await peer.answerRead('hello\r\n')
    stop()

    peer.say({ type: 'data', data: 'after\r\n' })

    expect(output(sink.events)).toBe('hello\r\n')
  })

  it('does not emit an empty scrollback, which would read as a pane that said nothing', async () => {
    const peer = scriptedPeer()
    const sink = recorder()
    const onError = vi.fn()
    watchPane({ target: peer.target, terminalId: 't1', channel: sink.channel, onError })
    await peer.answerSubscribe('sub_1')
    await peer.answerRead('')

    expect(sink.events).toEqual([])
    expect(onError).not.toHaveBeenCalled()
  })
})

describe('reading a teammate’s pane id', () => {
  it('splits the namespace from the owner’s own id', () => {
    expect(parsePeerPaneId('peer:Lx9TqvJ2mR0a:term_7')).toEqual({
      keyPrefix: 'Lx9TqvJ2mR0a',
      terminalId: 'term_7'
    })
  })

  it('keeps an owner’s id whole however it is punctuated', () => {
    // Ids are the owner's to choose and a colon in one must not silently
    // become a different pane.
    expect(parsePeerPaneId('peer:Lx9TqvJ2mR0a:a:b:c')?.terminalId).toBe('a:b:c')
  })

  it('refuses anything that is not one, rather than resolving it to something', () => {
    expect(parsePeerPaneId('term_7')).toBeUndefined()
    expect(parsePeerPaneId('peer:tooshort:term_7')).toBeUndefined()
    expect(parsePeerPaneId('peer:Lx9TqvJ2mR0a:')).toBeUndefined()
    expect(parsePeerPaneId('peer::term_7')).toBeUndefined()
    expect(parsePeerPaneId('')).toBeUndefined()
  })
})
