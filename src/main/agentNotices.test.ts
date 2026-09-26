import type { IpcMain, IpcMainEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import {
  badgeCount,
  installAgentNotices,
  noticeBody,
  noticeIsSilent,
  quietPanesAfter,
  readNoticeSettings,
  shouldNotify,
  NO_QUIET_PANES,
  NOTICE_PUBLISH_CHANNEL,
  NOTICE_REVEAL_CHANNEL,
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
    // Three agents in three worktrees, and only one can be the pane on screen.
    expect(
      shouldNotify({
        settings: settings({ focusedPaneId: 'term_2' }),
        windowFocused: true,
        terminalId: 'term_1'
      })
    ).toBe(true)
  })

  it('announces the focused pane of a window that is not focused', () => {
    // Selected and then left alone: nobody is reading it.
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

  it('takes what each pane is called, and only names', () => {
    const read = readNoticeSettings({
      preference: 'notify',
      focusedPaneId: null,
      names: { term_1: 'Claude Code 2', term_2: 7 }
    })
    expect(read?.names).toEqual({ term_1: 'Claude Code 2' })
    expect(readNoticeSettings({ preference: 'notify', focusedPaneId: null, names: 'zsh' })).toEqual({
      preference: 'notify',
      focusedPaneId: null
    })
  })

  it('takes the worktree in front, when it is one', () => {
    expect(readNoticeSettings({ preference: 'notify', focusedPaneId: null, activeWorktreeId: 'wt_1' })).toEqual({
      preference: 'notify',
      focusedPaneId: null,
      activeWorktreeId: 'wt_1'
    })
    expect(readNoticeSettings({ preference: 'notify', focusedPaneId: null, activeWorktreeId: 7 })).toEqual({
      preference: 'notify',
      focusedPaneId: null
    })
  })

  it('drops anything that is not an object', () => {
    expect(readNoticeSettings('notify')).toBeNull()
    expect(readNoticeSettings(null)).toBeNull()
  })
})

// The incident: the active worktree changed under somebody typing, and the
// keystrokes ran in another worktree's agent. The only road from "an agent
// stopped" to "open that pane" has one gate, the click on the notification.
describe('what a stopped agent is allowed to do to the window', () => {
  type Shown = {
    title: string
    subtitle?: string
    body: string
    silent: boolean
    onActivate: () => void
    actions?: { label: string; run: () => void }[]
  }

  function install(windowFocused = true) {
    const listeners = new Map<string, (event: IpcMainEvent, payload: unknown) => void>()
    const ipc = {
      on: (channel: string, listener: (event: IpcMainEvent, payload: unknown) => void) =>
        listeners.set(channel, listener),
      removeAllListeners: (channel: string) => listeners.delete(channel)
    } as unknown as IpcMain
    const sent: unknown[][] = []
    const sender = { isDestroyed: () => false, send: (...args: unknown[]) => sent.push(args), mainFrame: {} }
    const shown: Shown[] = []
    const host = {
      windowFocused: () => windowFocused,
      show: (spec: Shown) => shown.push(spec),
      setBadge: vi.fn(),
      focusWindow: vi.fn(),
      fromMainFrame: () => true
    }
    const channel = installAgentNotices(ipc, host)
    const publish = (settings: NoticeSettings): void => {
      const listener = listeners.get(NOTICE_PUBLISH_CHANNEL)
      if (!listener) throw new Error('nothing is listening for the window’s settings')
      listener({ sender, senderFrame: sender.mainFrame } as unknown as IpcMainEvent, settings)
    }
    return { channel, publish, sent, shown, host }
  }

  const stopped: AgentNotice = {
    terminalId: 'term_theirs',
    worktreeId: 'wt_theirs',
    worktree: 'Plan the spend summary',
    reason: 'quiet',
    line: 'Login successful. Press Enter to continue'
  }

  it('raises the notification and tells the window nothing', () => {
    const { channel, publish, sent, shown, host } = install()
    // Typing into a pane of their own; the stopped agent is in another worktree.
    publish({ preference: 'notify', focusedPaneId: 'term_mine' })

    channel.deliver(stopped)

    expect(shown).toHaveLength(1)
    expect(shown[0]?.title).toBe('Plan the spend summary')
    expect(sent).toEqual([])
    expect(host.focusWindow).not.toHaveBeenCalled()
  })

  // Two agents in one worktree: the title says where, the subtitle which, as the sidebar calls it.
  it('names the pane under the worktree, as the window calls it', () => {
    const { channel, publish, shown } = install()
    publish({ preference: 'notify', focusedPaneId: null, names: { term_theirs: 'Claude Code 2' } })
    channel.deliver(stopped)
    channel.deliver({ ...stopped, terminalId: 'term_unnamed' })

    expect(shown.map((spec) => [spec.title, spec.subtitle])).toEqual([
      ['Plan the spend summary', 'Claude Code 2'],
      ['Plan the spend summary', undefined]
    ])
  })

  it('tells the window nothing when the window is not even in front', () => {
    const { channel, publish, sent, host } = install(false)
    publish({ preference: 'notify', focusedPaneId: 'term_mine' })

    channel.deliver(stopped)

    expect(sent).toEqual([])
    expect(host.focusWindow).not.toHaveBeenCalled()
  })

  it('reveals the pane from the click on the notification, and from nothing else', () => {
    const { channel, publish, sent, shown, host } = install()
    publish({ preference: 'notify', focusedPaneId: 'term_mine' })
    channel.deliver(stopped)
    // Nothing, however long it sits in the notification centre.
    expect(sent).toEqual([])

    shown[0]?.onActivate()

    expect(host.focusWindow).toHaveBeenCalledOnce()
    expect(sent).toEqual([[NOTICE_REVEAL_CHANNEL, { worktreeId: 'wt_theirs', terminalId: 'term_theirs' }]])
  })

  // Answering from the notification is a click on an answer, re-checked against the screen by `choose`.
  it('offers the first two answers as actions, and reveals the pane when one no longer applies', async () => {
    const { channel, publish, sent, shown, host } = install(false)
    publish({ preference: 'notify', focusedPaneId: null })
    const chosen: string[] = []
    const choose = (label: string) => async (): Promise<void> => {
      chosen.push(label)
      if (label === 'Exit') throw new Error('no longer asks that')
    }
    channel.deliver({
      ...stopped,
      answers: [
        { label: 'Trust', choose: choose('Trust') },
        { label: 'Exit', choose: choose('Exit') },
        { label: 'Later', choose: choose('Later') }
      ]
    })
    channel.deliver(stopped)

    expect(shown[0]?.actions?.map((action) => action.label)).toEqual(['Trust', 'Exit'])
    expect(shown[1]?.actions).toBeUndefined()

    shown[0]?.actions?.[0]?.run()
    await vi.waitFor(() => expect(chosen).toEqual(['Trust']))
    expect(sent).toEqual([])
    expect(host.focusWindow).not.toHaveBeenCalled()

    shown[0]?.actions?.[1]?.run()
    await vi.waitFor(() =>
      expect(sent).toEqual([[NOTICE_REVEAL_CHANNEL, { worktreeId: 'wt_theirs', terminalId: 'term_theirs' }]])
    )
    expect(host.focusWindow).toHaveBeenCalledOnce()
  })

  it('raises a teammate’s shared note only while the window is away, and focuses nothing until clicked', () => {
    const away = install(false)
    away.publish({ preference: 'notify', focusedPaneId: null })
    away.channel.announce({ title: 'ana shared a note', body: 'Plan' })
    expect(away.shown.map((spec) => [spec.title, spec.body, spec.silent])).toEqual([
      ['ana shared a note', 'Plan', true]
    ])
    expect(away.host.focusWindow).not.toHaveBeenCalled()
    away.shown[0]?.onActivate()
    expect(away.host.focusWindow).toHaveBeenCalledOnce()

    const looking = install(true)
    looking.publish({ preference: 'notify', focusedPaneId: null })
    looking.channel.announce({ title: 'ana shared a note', body: 'Plan' })
    expect(looking.shown).toEqual([])

    const off = install(false)
    off.publish({ preference: 'off', focusedPaneId: null })
    off.channel.announce({ title: 'ana shared a note', body: 'Plan' })
    expect(off.shown).toEqual([])
  })

  it('drops the click once the window that published is gone', () => {
    const listeners = new Map<string, (event: IpcMainEvent, payload: unknown) => void>()
    const ipc = {
      on: (channel: string, listener: (event: IpcMainEvent, payload: unknown) => void) =>
        listeners.set(channel, listener),
      removeAllListeners: () => {}
    } as unknown as IpcMain
    const sent: unknown[][] = []
    let closed = false
    const sender = { isDestroyed: () => closed, send: (...args: unknown[]) => sent.push(args), mainFrame: {} }
    const shown: Shown[] = []
    const channel = installAgentNotices(ipc, {
      windowFocused: () => false,
      show: (spec: Shown) => shown.push(spec),
      setBadge: () => {},
      focusWindow: () => {},
      fromMainFrame: () => true
    })
    listeners.get(NOTICE_PUBLISH_CHANNEL)?.({ sender, senderFrame: sender.mainFrame } as unknown as IpcMainEvent, {
      preference: 'notify',
      focusedPaneId: null
    })
    channel.deliver(stopped)
    closed = true

    shown[0]?.onActivate()

    expect(sent).toEqual([])
  })
})

// The menu bar extra reads the window's names and opens a pane in it, whether or not a window is open.
describe('what the menu bar extra asks of the window', () => {
  function install() {
    const listeners = new Map<string, (event: IpcMainEvent, payload: unknown) => void>()
    const ipc = {
      on: (channel: string, listener: (event: IpcMainEvent, payload: unknown) => void) =>
        listeners.set(channel, listener),
      removeAllListeners: () => {}
    } as unknown as IpcMain
    const channel = installAgentNotices(ipc, {
      windowFocused: () => false,
      show: () => {},
      setBadge: () => {},
      focusWindow: () => {},
      fromMainFrame: () => true
    })
    const window = () => {
      const sent: unknown[][] = []
      let closed = false
      const sender = { isDestroyed: () => closed, send: (...args: unknown[]) => sent.push(args), mainFrame: {} }
      return {
        sent,
        close: () => (closed = true),
        publish: (payload: NoticeSettings) =>
          listeners.get(NOTICE_PUBLISH_CHANNEL)?.(
            { sender, senderFrame: sender.mainFrame } as unknown as IpcMainEvent,
            payload
          )
      }
    }
    return { channel, window }
  }
  const pane = { worktreeId: 'wt_1', terminalId: 'term_1' }

  it('knows no window until one publishes, and none once it is gone', () => {
    const { channel, window } = install()
    expect(channel.window()).toBeNull()
    const open = window()
    open.publish({ preference: 'notify', focusedPaneId: null, names: { term_1: 'Codex' }, activeWorktreeId: 'wt_1' })
    expect(channel.window()).toEqual({ names: { term_1: 'Codex' }, activeWorktreeId: 'wt_1' })
    open.close()
    expect(channel.window()).toBeNull()
  })

  it('reveals a pane in the open window at once', () => {
    const { channel, window } = install()
    const open = window()
    open.publish({ preference: 'notify', focusedPaneId: null })
    channel.revealPane(pane)
    expect(open.sent).toEqual([[NOTICE_REVEAL_CHANNEL, pane]])
  })

  it('holds a reveal for a window still opening until it has the pane', () => {
    const { channel, window } = install()
    channel.revealPane(pane)
    const opening = window()
    opening.publish({ preference: 'notify', focusedPaneId: null })
    expect(opening.sent).toEqual([])
    opening.publish({ preference: 'notify', focusedPaneId: null, names: { term_1: 'Codex' } })
    opening.publish({ preference: 'notify', focusedPaneId: null, names: { term_1: 'Codex' } })
    expect(opening.sent).toEqual([[NOTICE_REVEAL_CHANNEL, pane]])
  })
})
