import { describe, expect, it, vi } from 'vitest'
import { releaseInTurn } from './releaseInTurn'

describe('releasing the runtime’s resources in turn', () => {
  it('runs each release in order, one after the other finishes', async () => {
    const order: string[] = []
    await releaseInTurn(
      [
        {
          name: 'workspace',
          release: async () => {
            await new Promise((resolve) => setTimeout(resolve, 5))
            order.push('workspace')
          }
        },
        { name: 'socket', release: () => void order.push('socket') }
      ],
      { graceMs: 1_000, onProblem: vi.fn() }
    )
    expect(order).toEqual(['workspace', 'socket'])
  })

  // One stuck resource used to hold the quit for good: the socket and discovery file never went.
  it('gives up on a release that outlasts its grace, names it, and carries on', async () => {
    const onProblem = vi.fn()
    const released: string[] = []
    const started = Date.now()

    await releaseInTurn(
      [
        { name: 'relay', release: () => new Promise<void>(() => {}) },
        { name: 'socket', release: () => void released.push('socket') }
      ],
      { graceMs: 30, onProblem }
    )

    expect(Date.now() - started).toBeLessThan(1_000)
    expect(released).toEqual(['socket'])
    expect(onProblem).toHaveBeenCalledTimes(1)
    expect(String(onProblem.mock.calls[0]?.[0])).toMatch(/relay.*30ms/)
  })

  it('reports a release that throws and still runs the rest', async () => {
    const onProblem = vi.fn()
    const released: string[] = []

    await releaseInTurn(
      [
        {
          name: 'ptys',
          release: () => {
            throw new Error('the pty would not die')
          }
        },
        { name: 'socket', release: () => void released.push('socket') }
      ],
      { graceMs: 1_000, onProblem }
    )

    expect(released).toEqual(['socket'])
    expect(String(onProblem.mock.calls[0]?.[0])).toContain('would not die')
  })
})
