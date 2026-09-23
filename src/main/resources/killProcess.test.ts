import { describe, expect, it } from 'vitest'
import { terminate } from './killProcess'

type Sent = { target: number; signal: NodeJS.Signals }

function host(refuse: (target: number) => string | null = () => null): {
  sent: Sent[]
  kill: (t: number, s: NodeJS.Signals) => void
} {
  const sent: Sent[] = []
  return {
    sent,
    kill: (target, signal) => {
      const code = refuse(target)
      if (code !== null) throw Object.assign(new Error(code), { code })
      sent.push({ target, signal })
    }
  }
}

describe('terminate', () => {
  it('signals a group by its negated pid, with SIGTERM and nothing stronger', () => {
    const fake = host()
    terminate({ kind: 'group', pid: 600, terminalId: 'term_a' }, fake.kill)
    expect(fake.sent).toEqual([{ target: -600, signal: 'SIGTERM' }])
  })

  it('falls back to the child itself when it leads no group', () => {
    const fake = host((target) => (target < 0 ? 'ESRCH' : null))
    terminate({ kind: 'group', pid: 600, terminalId: 'term_a' }, fake.kill)
    expect(fake.sent).toEqual([{ target: 600, signal: 'SIGTERM' }])
  })

  it('signals one process by its own pid', () => {
    const fake = host()
    terminate({ kind: 'process', pid: 602, terminalId: 'term_a' }, fake.kill)
    expect(fake.sent).toEqual([{ target: 602, signal: 'SIGTERM' }])
  })

  it('treats a process that is already gone as done', () => {
    const fake = host(() => 'ESRCH')
    expect(() => terminate({ kind: 'process', pid: 602, terminalId: 'term_a' }, fake.kill)).not.toThrow()
  })
})
