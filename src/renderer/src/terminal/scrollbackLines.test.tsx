/** @vitest-environment jsdom */

import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const call = vi.hoisted(() => vi.fn((..._args: unknown[]): Promise<unknown> => Promise.resolve({})))

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: { call, onConnectionChange: () => () => {} },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { useScrollbackLines } = await import('./scrollbackLines')

const INITIAL = useWorkspaceStore.getState()

afterEach(() => {
  useWorkspaceStore.setState(INITIAL, true)
  call.mockClear()
})

const told = (): unknown[] =>
  call.mock.calls.filter(([method]) => method === 'settings.set').map(([, params]) => params)

describe('useScrollbackLines', () => {
  it('tells main the setting on launch and on each change, and nothing when it did not move', () => {
    useWorkspaceStore.getState().setTerminalOptions({ scrollback: 20_000 })
    const { unmount } = renderHook(() => useScrollbackLines())
    expect(told()).toEqual([{ scrollbackLines: 20_000 }])

    useWorkspaceStore.getState().setTerminalOptions({ cursorBlink: false })
    useWorkspaceStore.getState().setTerminalOptions({ scrollback: 3_000 })
    expect(told()).toEqual([{ scrollbackLines: 20_000 }, { scrollbackLines: 3_000 }])

    unmount()
    useWorkspaceStore.getState().setTerminalOptions({ scrollback: 9_000 })
    expect(told()).toHaveLength(2)
  })
})
