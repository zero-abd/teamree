import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '../shared/entities'
import {
  askAboutAgents,
  busyAgents,
  busyLine,
  quitQuestion,
  whenIdle,
  type BusyAgents,
  type QuitQuestion
} from './quitAgents'

function pane(id: string, facts: Partial<Terminal> = {}): Terminal {
  return {
    id,
    worktreeId: 'w1',
    title: 'zsh',
    cwd: '/tmp',
    shell: '/bin/zsh',
    cols: 80,
    rows: 24,
    running: true,
    busy: false,
    lastOutputAt: 0,
    ...facts
  }
}

const working = (id: string): Terminal =>
  pane(id, { agent: 'claude', agentEvent: { event: 'UserPromptSubmit', at: 1 } })
const asking = (id: string): Terminal => pane(id, { agent: 'codex', agentEvent: { event: 'Notification', at: 1 } })
const idle = (id: string): Terminal => pane(id, { agent: 'claude', agentEvent: { event: 'Stop', at: 1 } })

const none: BusyAgents = { working: 0, asking: 0, names: [] }
const two: BusyAgents = { working: 2, asking: 0, names: ['login-bug', 'api-refactor'] }

describe('busyAgents', () => {
  it('counts agents mid-turn and agents asking, never a busy shell or an idle agent', () => {
    const busy = busyAgents(
      [
        working('t1'),
        asking('t2'),
        idle('t3'),
        pane('t4', { busy: true }),
        pane('t5', { agent: 'claude', running: false })
      ],
      (terminal) => `pane ${terminal.id}`
    )
    expect(busy).toEqual({ working: 1, asking: 1, names: ['pane t1', 'pane t2'] })
  })
})

describe('busyLine', () => {
  it('says how many are working and asking', () => {
    expect(busyLine({ working: 1, asking: 0, names: [] })).toBe('1 agent is working')
    expect(busyLine(two)).toBe('2 agents are working')
    expect(busyLine({ working: 2, asking: 1, names: [] })).toBe('2 agents are working, 1 asking')
    expect(busyLine({ working: 0, asking: 2, names: [] })).toBe('2 agents are asking')
  })
})

describe('quitQuestion', () => {
  it('asks nothing when no agent is busy', () => {
    expect(quitQuestion('quit', none)).toBeNull()
    expect(quitQuestion('restart', none)).toBeNull()
  })

  it('offers Quit Anyway or Cancel for a quit', () => {
    const question = quitQuestion('quit', two)
    expect(question).toMatchObject({ message: '2 agents are working', buttons: ['Quit Anyway', 'Cancel'], cancelId: 1 })
    expect(question?.detail).toBe('login-bug\napi-refactor')
  })

  it('offers Restart When Idle first for Restart to Update', () => {
    expect(quitQuestion('restart', two)).toMatchObject({
      buttons: ['Restart When Idle', 'Restart Now', 'Cancel'],
      defaultId: 0,
      cancelId: 2
    })
  })

  it('names six panes and counts the rest', () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    expect(quitQuestion('quit', { working: 8, asking: 0, names })?.detail).toBe('a\nb\nc\nd\ne\nf\n+2 more')
  })
})

describe('askAboutAgents', () => {
  const answer = (button: string) => async (question: QuitQuestion) => question.buttons.indexOf(button)

  it('lets a quit through without asking when no agent is busy', async () => {
    const show = vi.fn(answer('Cancel'))
    expect(await askAboutAgents({ intent: null, busy: none, show })).toBe('go')
    expect(show).not.toHaveBeenCalled()
  })

  it('confirms a quit while agents work', async () => {
    expect(await askAboutAgents({ intent: null, busy: two, show: answer('Quit Anyway') })).toBe('go')
    expect(await askAboutAgents({ intent: null, busy: two, show: answer('Cancel') })).toBe('cancel')
  })

  it('offers a restart the three ways', async () => {
    expect(await askAboutAgents({ intent: 'asked', busy: two, show: answer('Restart Now') })).toBe('go')
    expect(await askAboutAgents({ intent: 'asked', busy: two, show: answer('Restart When Idle') })).toBe('when-idle')
    expect(await askAboutAgents({ intent: 'asked', busy: two, show: answer('Cancel') })).toBe('cancel')
  })

  it('asks nothing for Restart Now, or once the wait for idle is over', async () => {
    const show = vi.fn(answer('Cancel'))
    expect(await askAboutAgents({ intent: 'now', busy: two, show })).toBe('go')
    expect(await askAboutAgents({ intent: 'when-idle', busy: none, show })).toBe('go')
    expect(show).not.toHaveBeenCalled()
  })

  it('reads a quit while a restart waits for idle as a plain quit', async () => {
    const show = vi.fn(answer('Quit Anyway'))
    expect(await askAboutAgents({ intent: 'when-idle', busy: two, show })).toBe('quit-only')
    expect(show.mock.calls[0]?.[0].buttons).toEqual(['Quit Anyway', 'Cancel'])
    expect(await askAboutAgents({ intent: 'when-idle', busy: two, show: answer('Cancel') })).toBe('keep-waiting')
  })
})

describe('whenIdle', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires once, after two idle readings in a row', () => {
    vi.useFakeTimers()
    const readings = [two, none, two, none, none, none]
    const then = vi.fn()
    whenIdle({ busy: () => readings.shift() ?? none, onIdle: then, everyMs: 1_000 })

    vi.advanceTimersByTime(4_000)
    expect(then).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_000)
    expect(then).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10_000)
    expect(then).toHaveBeenCalledTimes(1)
  })

  it('stops when told', () => {
    vi.useFakeTimers()
    const then = vi.fn()
    const stop = whenIdle({ busy: () => none, onIdle: then, everyMs: 1_000 })
    stop()
    vi.advanceTimersByTime(10_000)
    expect(then).not.toHaveBeenCalled()
  })
})
