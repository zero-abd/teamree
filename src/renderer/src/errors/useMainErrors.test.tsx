/** @vitest-environment jsdom */

import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: () => new Promise(() => {}),
    watchPane: () => new Promise(() => {}),
    subscribeTerminal: () => new Promise(() => {}),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { useMainErrors } = await import('./useMainErrors')

const INITIAL = useWorkspaceStore.getState()
let deliver: ((details: string) => void) | null = null

function Harness(): null {
  useMainErrors()
  return null
}

beforeEach(() => {
  useWorkspaceStore.setState({ ...INITIAL, notices: [] }, true)
  ;(window as unknown as { teamree: unknown }).teamree = {
    errors: {
      report: () => {},
      onMainError: (listener: (details: string) => void) => {
        deliver = listener
        return () => {
          deliver = null
        }
      }
    }
  }
})

afterEach(() => Reflect.deleteProperty(window, 'teamree'))

describe('a main-process error the window hears of', () => {
  it('is one line in the corner that copies its details', () => {
    const { unmount } = render(<Harness />)
    act(() => deliver?.('[time] teamree 1.2.3 uncaught exception\nError: boom'))
    const [notice] = useWorkspaceStore.getState().notices
    expect(notice?.text).toBe('Something went wrong')
    expect(notice?.tone).toBe('error')
    expect(notice?.action).toEqual({
      label: 'Copy Details',
      copy: '[time] teamree 1.2.3 uncaught exception\nError: boom'
    })
    unmount()
    expect(deliver).toBeNull()
  })
})
