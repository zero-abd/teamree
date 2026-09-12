import { describe, expect, it, vi } from 'vitest'
import type { StreamEvent } from '../../shared/protocol'
import { SubscriptionHub } from './subscriptionHub'

function collector(): { frames: StreamEvent[]; sink: (frame: StreamEvent) => void } {
  const frames: StreamEvent[] = []
  return { frames, sink: (frame) => frames.push(frame) }
}

describe('subscription hub', () => {
  it('routes events to the subscribing connection under its own id', () => {
    const hub = new SubscriptionHub()
    const { frames, sink } = collector()
    hub.openConnection('c1', sink)

    const id = hub.subscribe('c1', (channel) => {
      channel.emit('first')
      return () => {}
    })

    expect(frames).toEqual([{ stream: id, event: 'first' }])
  })

  it('tears down and stops delivering on unsubscribe', () => {
    const hub = new SubscriptionHub()
    const { frames, sink } = collector()
    hub.openConnection('c1', sink)
    const teardown = vi.fn()
    let emit: (event: unknown) => void = () => {}

    const id = hub.subscribe('c1', (channel) => {
      emit = channel.emit
      return teardown
    })

    emit('before')
    expect(hub.unsubscribe('c1', id)).toBe(true)
    emit('after')

    expect(teardown).toHaveBeenCalledTimes(1)
    expect(frames).toEqual([{ stream: id, event: 'before' }])
    expect(hub.unsubscribe('c1', id)).toBe(false)
    expect(hub.size).toBe(0)
  })

  it('lets a producer end its own subscription', () => {
    const hub = new SubscriptionHub()
    const { sink } = collector()
    hub.openConnection('c1', sink)
    const teardown = vi.fn()

    hub.subscribe('c1', (channel) => {
      channel.close()
      return teardown
    })

    expect(teardown).toHaveBeenCalledTimes(1)
    expect(hub.size).toBe(0)
  })

  it('drops every subscription when the connection goes away', () => {
    const hub = new SubscriptionHub()
    const { sink } = collector()
    hub.openConnection('c1', sink)
    const teardowns = [vi.fn(), vi.fn()]
    for (const teardown of teardowns) hub.subscribe('c1', () => teardown)

    expect(hub.countFor('c1')).toBe(2)
    hub.closeConnection('c1')

    for (const teardown of teardowns) expect(teardown).toHaveBeenCalledTimes(1)
    expect(hub.size).toBe(0)
    expect(hub.hasConnection('c1')).toBe(false)
  })

  it('keeps connections isolated from each other', () => {
    const hub = new SubscriptionHub()
    const one = collector()
    const two = collector()
    hub.openConnection('c1', one.sink)
    hub.openConnection('c2', two.sink)

    let emitOne: (event: unknown) => void = () => {}
    const idOne = hub.subscribe('c1', (channel) => {
      emitOne = channel.emit
      return () => {}
    })
    hub.subscribe('c2', () => () => {})

    // One connection cannot cancel another's stream.
    expect(hub.unsubscribe('c2', idOne)).toBe(false)
    emitOne('ping')

    expect(one.frames).toEqual([{ stream: idOne, event: 'ping' }])
    expect(two.frames).toEqual([])

    hub.closeConnection('c1')
    expect(hub.countFor('c2')).toBe(1)
  })

  it('refuses to subscribe on a connection that is gone', () => {
    const hub = new SubscriptionHub()
    expect(() => hub.subscribe('missing', () => () => {})).toThrow(/unknown connection/)
  })

  it('does not leave a subscription behind when the source throws', () => {
    const hub = new SubscriptionHub()
    const { sink } = collector()
    hub.openConnection('c1', sink)

    expect(() =>
      hub.subscribe('c1', () => {
        throw new Error('pty gone')
      })
    ).toThrow(/pty gone/)
    expect(hub.size).toBe(0)
  })
})
