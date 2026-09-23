// The join between a scrollback and a live tail, with the two calls a watch is
// made of resolved by hand. A socket read routes many frames in one synchronous
// loop, so the peer here counts frames the way the transport does.

import { describe, expect, it, vi } from 'vitest'
import type { MethodName, ParamsOf, ResultOf } from '../../../shared/methods'
import type { Answered } from '../../runtime/peerTransport'
import type { SubscriptionChannel } from '../../runtime/subscriptionHub'
import { watchPane, type WatchTarget } from './paneWatch'
import { parsePeerPaneId } from './peerService'

/**
 * A teammate whose two answers are resolved by the test. It counts frames the
 * way the transport does, so an event can be put on either side of an answer.
 */
function scriptedPeer(): {
  target: WatchTarget
  /** Pushes a stream event the way the far side's pane would. */
  say: (event: unknown) => void
  answerSubscribe: (subscription: string) => Promise<void>
  answerRead: (data: string) => Promise<void>
  /**
   * One socket read: the answer, then frames decoded behind it, all routed
   * before the answer's continuation runs. They are behind the answer on the
   * wire, so no scrollback holds them.
   */
  answerReadThenSay: (data: string, ...behind: readonly unknown[]) => Promise<void>
  failRead: (reason: string) => Promise<void>
  calls: { method: string; params: unknown }[]
} {
  const calls: { method: string; params: unknown }[] = []
  let routed: ((event: unknown, sequence: number) => void) | undefined
  let settleSubscribe: ((answer: unknown) => void) | undefined
  let settleRead: ((answer: unknown) => void) | undefined
  let rejectRead: ((error: Error) => void) | undefined
  /** Frames read off the session, exactly as the transport counts them. */
  let received = 0

  const ask = (<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<Answered<M>> => {
    calls.push({ method, params })
    if (method === 'terminal.subscribe') {
      return new Promise((resolve) => {
        settleSubscribe = resolve as (answer: unknown) => void
      })
    }
    if (method === 'terminal.read') {
      return new Promise((resolve, reject) => {
        settleRead = resolve as (answer: unknown) => void
        rejectRead = reject
      })
    }
    received += 1
    return Promise.resolve({ result: { unsubscribed: true } as ResultOf<M>, sequence: received })
  }) as WatchTarget['callInOrder']

  const target: WatchTarget = {
    call: (<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> =>
      ask(method, params).then((answer) => answer.result)) as WatchTarget['call'],
    callInOrder: ask,
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

  const say = (event: unknown): void => {
    received += 1
    routed?.(event, received)
  }

  const answer = (data: string): void => {
    received += 1
    settleRead?.({ result: { data }, sequence: received })
  }

  return {
    target,
    calls,
    say,
    answerSubscribe: async (subscription) => {
      received += 1
      settleSubscribe?.({ result: { subscription }, sequence: received })
      await settle()
    },
    answerRead: async (data) => {
      answer(data)
      await settle()
    },
    answerReadThenSay: async (data, ...behind) => {
      answer(data)
      for (const event of behind) say(event)
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

    // The pane keeps talking while the scrollback is in flight; every one of
    // these is already in the snapshot.
    peer.say({ type: 'data', data: 'three\r\n' })
    peer.say({ type: 'data', data: 'four\r\n' })
    await peer.answerRead('one\r\ntwo\r\nthree\r\nfour\r\n')

    // And what it says afterwards is not in the snapshot and must arrive.
    peer.say({ type: 'data', data: 'five\r\n' })

    expect(output(sink.events)).toBe('one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n')
  })

  it('keeps output decoded behind the answer in the same batch of frames', async () => {
    const peer = scriptedPeer()
    const sink = recorder()
    watchPane({ target: peer.target, terminalId: 't1', channel: sink.channel })
    await peer.answerSubscribe('sub_1')

    peer.say({ type: 'data', data: 'during\r\n' })
    // One socket read carrying the answer and then two more frames, written
    // after the scrollback was taken and reaching this side before the answer's
    // continuation runs: "everything held when the promise settled" is the wrong rule.
    await peer.answerReadThenSay(
      'before\r\nduring\r\n',
      { type: 'data', data: 'behind-the-answer\r\n' },
      { type: 'data', data: 'and-after-that\r\n' }
    )

    expect(output(sink.events)).toBe('before\r\nduring\r\nbehind-the-answer\r\nand-after-that\r\n')
  })

  it('drops output decoded ahead of the answer in that same batch, which the snapshot has', async () => {
    const peer = scriptedPeer()
    const sink = recorder()
    watchPane({ target: peer.target, terminalId: 't1', channel: sink.channel })
    await peer.answerSubscribe('sub_1')

    // The other edge: written *before* the answer, so the scrollback carries it
    // and the stream's copy is the duplicate.
    peer.say({ type: 'data', data: 'during\r\n' })
    await peer.answerReadThenSay('before\r\nduring\r\n')

    expect(output(sink.events)).toBe('before\r\nduring\r\n')
  })

  it('does not warn about bytes the scrollback it is about to show already holds', async () => {
    const peer = scriptedPeer()
    const sink = recorder()
    watchPane({ target: peer.target, terminalId: 't1', channel: sink.channel })
    await peer.answerSubscribe('sub_1')

    // Something overran while the read was in flight. The bytes went missing
    // from the stream, not from the pane: the scrollback reaches back past them.
    peer.say({ type: 'data', data: 'during\r\n' })
    peer.say({ type: 'elided', bytes: 7 })
    peer.say({ type: 'data', data: 'after\r\n' })
    await peer.answerRead('before\r\nduring\r\nlost!\r\nafter\r\n')

    expect(sink.events.filter((event) => (event as { type?: string }).type === 'elided')).toEqual([])
    expect(output(sink.events)).toBe('before\r\nduring\r\nlost!\r\nafter\r\n')
  })

  it('says what the snapshot could not reach back to, in front of the snapshot', async () => {
    const peer = scriptedPeer()
    const sink = recorder()
    watchPane({ target: peer.target, terminalId: 't1', channel: sink.channel })
    await peer.answerSubscribe('sub_1')

    // The only shape in which a pre-answer `elided` is true: a burst that outran
    // the owner's scrollback (`SCROLLBACK_CAP_BYTES`) as well as the wire.
    peer.say({ type: 'elided', bytes: 1_000 })
    peer.say({ type: 'data', data: 'aaaa' })
    peer.say({ type: 'data', data: 'tail\r\n' })
    await peer.answerRead('tail\r\n')

    // 1004, not 1000: the four bytes that did arrive are just as gone. And
    // before the snapshot, because that is where the hole is.
    expect(sink.events).toEqual([
      { type: 'elided', bytes: 1_004 },
      { type: 'data', data: 'tail\r\n' }
    ])
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
