// Whether the window is allowed to say somebody is typing.
//
// The failure this guards against is the quiet one: a pane that goes on saying
// "ana is typing" after ana has walked away, which would teach an owner to stop
// reading the line that exists to tell them when it is true.

import { describe, expect, it } from 'vitest'
import { TYPING_WINDOW_MS, type PaneTypist, type PaneWatchers } from '@shared/entities'
import { hasBeenTyped, NO_ATTENTION, paneAttention, typingNow } from './paneAttention'

const NOW = 1_700_000_000_000

function typist(handle: string, at: number, overrides: Partial<PaneTypist> = {}): PaneTypist {
  return { handle, publicKey: `${handle}-key`, since: at, at, writes: 1, bytes: 4, refused: 0, ...overrides }
}

function answer(projectId: string, panes: PaneWatchers['panes']): PaneWatchers {
  return { projectId, panes, readAt: NOW }
}

describe('finding one pane in every project’s answer', () => {
  it('finds a pane whichever project’s answer it is in', () => {
    const byProject = {
      p_1: answer('p_1', [{ terminalId: 't_1', watchers: [], typists: [typist('ana', NOW)], muted: false }]),
      p_2: answer('p_2', [{ terminalId: 't_2', watchers: [], typists: [], muted: true }])
    }
    expect(paneAttention(byProject, 't_2').muted).toBe(true)
    expect(paneAttention(byProject, 't_1').typists.map((who) => who.handle)).toEqual(['ana'])
  })

  it('says nothing at all about a pane nobody has touched', () => {
    expect(paneAttention({}, 't_1')).toEqual(NO_ATTENTION)
  })
})

describe('whether somebody is typing now', () => {
  it('names a typist whose last keystroke was a moment ago', () => {
    expect(typingNow([typist('ana', NOW - 200)], NOW).map((who) => who.handle)).toEqual(['ana'])
  })

  it('stops naming them once they have stopped, without being told', () => {
    // Nothing arrives to say a burst ended: the last keystroke is simply the
    // last one. So "is typing" has to be a question about the clock, asked
    // again on every tick, and not a flag somebody remembered to clear.
    expect(typingNow([typist('ana', NOW - TYPING_WINDOW_MS - 1)], NOW)).toEqual([])
  })

  it('names both of two people typing at once, and neither more loudly', () => {
    const both = typingNow([typist('ana', NOW - 100), typist('bo', NOW - 300)], NOW)
    expect(both.map((who) => who.handle)).toEqual(['ana', 'bo'])
  })

  it('still says the pane has been typed in long after the typing stopped', () => {
    // The two facts are different and the second one does not expire: a pane a
    // teammate has run commands in does not go back to being only yours.
    const attention = { watchers: [], typists: [typist('ana', NOW - 3_600_000)], muted: false }
    expect(typingNow(attention.typists, NOW)).toEqual([])
    expect(hasBeenTyped(attention)).toBe(true)
  })

  it('counts a refused keystroke as having been typed at, because somebody tried', () => {
    const attention = { watchers: [], typists: [typist('ana', NOW, { writes: 0, refused: 3 })], muted: true }
    expect(hasBeenTyped(attention)).toBe(true)
  })
})
