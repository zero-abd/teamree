/** @vitest-environment jsdom */

import { act, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const call = vi.fn((_method: string, _params: unknown) => new Promise(() => {}))
vi.mock('../../runtimeClient/currentRuntimeClient', () => ({ runtimeClient: { call }, RUNTIME_IS_SEEDED: false }))

const { useUsageStore } = await import('../../state/usageStore')
const { TokensLine } = await import('./TokensLine')

describe('TokensLine', () => {
  it('reads the open worktree, draws nothing until then, and its own tokens after', () => {
    const { container } = render(<TokensLine worktreeId="w1" />)
    expect(call).toHaveBeenCalledWith('worktree.usage', { worktreeId: 'w1' })
    expect(container.textContent).toBe('')

    const counted = { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, sessions: 1, unknownPanes: 0, readAt: 1 }
    act(() =>
      useUsageStore.setState({
        usage: { w1: { ...counted, worktreeId: 'w1', costUsd: 1, subtree: { ...counted, output: 2_000, costUsd: 2 } } },
        showCost: true
      })
    )
    const line = container.querySelector('.changes__tokens')
    expect(line?.textContent).toBe('100 tok · ≈$1.00')
    expect(line?.getAttribute('title')).toBe(
      'in 10 · out 20 · cache read 30 · cache write 40\n2.1k tok · ≈$2.00 with children'
    )
  })
})
