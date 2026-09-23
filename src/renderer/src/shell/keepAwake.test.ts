// What the window tells the main process about sleep: the mode somebody chose,
// and whether any agent pane is on something right now.

import { describe, expect, it } from 'vitest'
import type { Terminal } from '@shared/entities'
import { anyAgentBusy, keepAwakeLabel } from './keepAwake'

function terminal(over: Partial<Terminal>): Terminal {
  return {
    id: 't',
    worktreeId: 'w',
    title: 'claude',
    cwd: '/w',
    shell: '/bin/zsh',
    cols: 80,
    rows: 24,
    running: true,
    busy: false,
    lastOutputAt: 0,
    ...over
  }
}

describe('anyAgentBusy', () => {
  it('is true while an agent pane is working', () => {
    expect(anyAgentBusy({ a: terminal({ agent: 'claude', busy: true }) })).toBe(true)
  })

  it('is true while an agent pane is waiting on you', () => {
    expect(anyAgentBusy({ a: terminal({ agent: 'claude', lastBellAt: 5 }) })).toBe(true)
    expect(anyAgentBusy({ a: terminal({ agent: 'claude', agentEvent: { event: 'Notification', at: 1 } }) })).toBe(true)
  })

  it('is false for a quiet agent, a finished one, and a plain shell however busy', () => {
    expect(anyAgentBusy({ a: terminal({ agent: 'claude' }) })).toBe(false)
    expect(anyAgentBusy({ a: terminal({ agent: 'claude', running: false, exitCode: 0 }) })).toBe(false)
    expect(anyAgentBusy({ a: terminal({ busy: true }) })).toBe(false)
    expect(anyAgentBusy({})).toBe(false)
  })
})

describe('keepAwakeLabel', () => {
  it('names the mode in one or two words', () => {
    expect(keepAwakeLabel('on')).toBe('Awake')
    expect(keepAwakeLabel('agent')).toBe('Awake · agent')
    expect(keepAwakeLabel('off')).toBe('Sleep ok')
  })
})
