import { describe, expect, it } from 'vitest'
import {
  badgeCount,
  noticeBody,
  noticeIsSilent,
  quietPanesAfter,
  readNoticeSettings,
  shouldNotify,
  NO_QUIET_PANES,
  type AgentNotice,
  type NoticeSettings
} from './agentNotices'

const settings = (over: Partial<NoticeSettings> = {}): NoticeSettings => ({
  preference: 'notify',
  focusedPaneId: null,
  ...over
})

describe('shouldNotify', () => {
  it('says nothing at all when the preference is off', () => {
    expect(
      shouldNotify({ settings: settings({ preference: 'off' }), windowFocused: false, terminalId: 'term_1' })
    ).toBe(false)
  })

  it('announces a pane nobody is looking at', () => {
    expect(shouldNotify({ settings: settings(), windowFocused: false, terminalId: 'term_1' })).toBe(true)
  })

  it('stays quiet about the pane on screen with the focus', () => {
    expect(
      shouldNotify({
        settings: settings({ focusedPaneId: 'term_1' }),
        windowFocused: true,
        terminalId: 'term_1'
      })
    ).toBe(false)
  })

  it('announces another pane of a window that is focused', () => {
    // The case the whole feature is for: three agents in three worktrees, and
    // only one of them can be the pane on screen.
    expect(
      shouldNotify({
        settings: settings({ focusedPaneId: 'term_2' }),
        windowFocused: true,
        terminalId: 'term_1'
      })
    ).toBe(true)
  })

  it('announces the focused pane of a window that is not focused', () => {
    // The window was left with this pane selected and then left alone. Nobody
    // is reading it, so nothing here has been seen.
    expect(
      shouldNotify({
        settings: settings({ focusedPaneId: 'term_1' }),
        windowFocused: false,
        terminalId: 'term_1'
      })
    ).toBe(true)
  })

  it('makes a sound only where one was asked for', () => {
    expect(noticeIsSilent('sound')).toBe(false)
    expect(noticeIsSilent('notify')).toBe(true)
  })
})

describe('the badge', () => {
  const settled = (terminalId: string, windowFocused: boolean) =>
    ({ kind: 'settled', terminalId, windowFocused }) as const

  it('counts nothing until an agent stops', () => {
    expect(badgeCount(NO_QUIET_PANES)).toBe(0)
  })

  it('counts a pane that stopped while the window was away', () => {
    expect(badgeCount(quietPanesAfter(NO_QUIET_PANES, settled('term_1', false)))).toBe(1)
  })

  it('counts nothing for a pane that stopped while the window was in front', () => {
    expect(badgeCount(quietPanesAfter(NO_QUIET_PANES, settled('term_1', true)))).toBe(0)
  })

  it('counts one agent once, however often it stops', () => {
    let panes = quietPanesAfter(NO_QUIET_PANES, settled('term_1', false))
    panes = quietPanesAfter(panes, settled('term_1', false))
    expect(badgeCount(panes)).toBe(1)
  })

  it('counts each agent that stopped', () => {
    let panes = quietPanesAfter(NO_QUIET_PANES, settled('term_1', false))
    panes = quietPanesAfter(panes, settled('term_2', false))
    panes = quietPanesAfter(panes, settled('term_3', false))
    expect(badgeCount(panes)).toBe(3)
  })

  it('clears when the window comes back', () => {
    let panes = quietPanesAfter(NO_QUIET_PANES, settled('term_1', false))
    panes = quietPanesAfter(panes, settled('term_2', false))
    panes = quietPanesAfter(panes, { kind: 'window-focused' })
    expect(badgeCount(panes)).toBe(0)
  })

  it('counts again after the window goes away a second time', () => {
    let panes = quietPanesAfter(NO_QUIET_PANES, settled('term_1', false))
    panes = quietPanesAfter(panes, { kind: 'window-focused' })
    panes = quietPanesAfter(panes, settled('term_1', false))
    expect(badgeCount(panes)).toBe(1)
  })
})

describe('what the notification says', () => {
  const notice = (over: Partial<AgentNotice> = {}): AgentNotice => ({
    terminalId: 'term_1',
    worktreeId: 'wt_1',
    worktree: 'fix the parser',
    reason: 'quiet',
    line: 'All 41 tests passed',
    ...over
  })

  it('quotes the pane', () => {
    expect(noticeBody(notice())).toBe('All 41 tests passed')
  })

  it('says which thing happened when there is nothing to quote', () => {
    expect(noticeBody(notice({ line: null }))).toBe('Went quiet.')
    expect(noticeBody(notice({ line: null, reason: 'exit' }))).toBe('Exited.')
  })
})

describe('what the window publishes', () => {
  it('takes a pair of settings', () => {
    expect(readNoticeSettings({ preference: 'sound', focusedPaneId: 'term_1' })).toEqual({
      preference: 'sound',
      focusedPaneId: 'term_1'
    })
  })

  it('drops a preference that is not one of the three', () => {
    expect(readNoticeSettings({ preference: 'loud', focusedPaneId: null })).toBeNull()
  })

  it('drops a focused pane that is not a pane', () => {
    expect(readNoticeSettings({ preference: 'notify', focusedPaneId: 7 })).toBeNull()
  })

  it('keeps nothing a sender put on the side', () => {
    const read = readNoticeSettings({ preference: 'notify', focusedPaneId: null, onActivate: 'rm -rf /' })
    expect(read).toEqual({ preference: 'notify', focusedPaneId: null })
    expect(Object.keys(read ?? {})).toEqual(['preference', 'focusedPaneId'])
  })

  it('drops anything that is not an object', () => {
    expect(readNoticeSettings('notify')).toBeNull()
    expect(readNoticeSettings(null)).toBeNull()
  })
})
