// Telling somebody an agent pane stopped, when they are not looking at the
// window. The focused pane and the preference come from the window over IPC,
// and are rebuilt from checked fields as `menuBar.ts` does.

import type { IpcMain, IpcMainEvent, WebContents } from 'electron'

/** Keep both in step with `src/preload/index.ts`, which repeats the literals. */
export const NOTICE_PUBLISH_CHANNEL = 'teamree:notices:publish'
export const NOTICE_REVEAL_CHANNEL = 'teamree:notices:reveal'

/** What the person asked for, per machine. Three values: "sound without a notification" is not a state. */
export type AgentNoticePreference = 'off' | 'notify' | 'sound'

export const AGENT_NOTICE_PREFERENCES: readonly AgentNoticePreference[] = ['off', 'notify', 'sound']

/** What the window last said: what it wants, and which pane has the focus (`null` for none or a teammate's). */
export type NoticeSettings = {
  preference: AgentNoticePreference
  focusedPaneId: string | null
}

/** Until the window says otherwise, which it does on its first render. */
export const DEFAULT_NOTICE_SETTINGS: NoticeSettings = { preference: 'notify', focusedPaneId: null }

function isPreference(value: unknown): value is AgentNoticePreference {
  return typeof value === 'string' && (AGENT_NOTICE_PREFERENCES as readonly string[]).includes(value)
}

/**
 * The settings, rebuilt field by field, or null. Rebuilt for the reason
 * `readMenuBarItems` is; an unknown preference would silently read as "off".
 */
export function readNoticeSettings(value: unknown): NoticeSettings | null {
  if (typeof value !== 'object' || value === null) return null
  const settings = value as Record<string, unknown>
  if (!isPreference(settings.preference)) return null
  const focused = settings.focusedPaneId
  if (focused !== null && typeof focused !== 'string') return null
  return { preference: settings.preference, focusedPaneId: focused }
}

/** Why a pane is being reported: it stopped printing, or it ended. */
export type AgentNoticeReason = 'quiet' | 'exit'

/**
 * One agent pane that has stopped. `worktree` is the name, for the title; `line`
 * is the last line worth quoting, often null (see `src/shared/outputEvidence.ts`).
 */
export type AgentNotice = {
  terminalId: string
  worktreeId: string
  worktree: string
  reason: AgentNoticeReason
  line: string | null
}

/**
 * Whether this pane stopping is worth interrupting somebody for. Not when they
 * are already looking at it: the window focused *and* this pane focused in it.
 */
export function shouldNotify(input: { settings: NoticeSettings; windowFocused: boolean; terminalId: string }): boolean {
  if (input.settings.preference === 'off') return false
  return !(input.windowFocused && input.settings.focusedPaneId === input.terminalId)
}

/** Whether the OS should raise this one without a sound. */
export function noticeIsSilent(preference: AgentNoticePreference): boolean {
  return preference !== 'sound'
}

/**
 * What the notification says under the worktree's name. Never empty: an empty
 * body reads on macOS as a notification that failed to say anything.
 */
export function noticeBody(notice: AgentNotice): string {
  if (notice.line !== null) return notice.line
  return notice.reason === 'exit' ? 'Exited.' : 'Went quiet.'
}

/** The panes counted on the dock badge. A set: an agent that goes quiet twice is one agent. */
export type QuietPanes = ReadonlySet<string>

export const NO_QUIET_PANES: QuietPanes = new Set()

export type BadgeEvent =
  /** An agent pane stopped. Counted only while the window is away. */
  | { kind: 'settled'; terminalId: string; windowFocused: boolean }
  /** The window came back: everything counted is a glance away, so the badge goes. */
  | { kind: 'window-focused' }

export function quietPanesAfter(panes: QuietPanes, event: BadgeEvent): QuietPanes {
  if (event.kind === 'window-focused') return panes.size === 0 ? panes : NO_QUIET_PANES
  if (event.windowFocused || panes.has(event.terminalId)) return panes
  return new Set([...panes, event.terminalId])
}

export function badgeCount(panes: QuietPanes): number {
  return panes.size
}

/** Everything this module needs from Electron, named so nothing above has to import it. */
export type AgentNoticeHost = {
  /** True when the window is the one the person is looking at. */
  windowFocused: () => boolean
  /** Raises one OS notification. `onActivate` runs if it is clicked. */
  show: (spec: { title: string; body: string; silent: boolean; onActivate: () => void }) => void
  /** The dock badge. macOS only; on the other platforms this does nothing. */
  setBadge: (count: number) => void
  /** Brings the window forward, which is half of what clicking one asks for. */
  focusWindow: () => void
  /** The window's main frame is the only thing allowed to speak for the window. */
  fromMainFrame: (event: IpcMainEvent) => boolean
}

export type AgentNoticeChannel = {
  /** One agent pane has stopped. */
  deliver: (notice: AgentNotice) => void
  /** The window has the focus again. */
  noteWindowFocus: () => void
  stop: () => void
}

/**
 * Listens for the window's settings, and announces panes that stop. A
 * notification outlives its window, so a click after it is gone is dropped.
 */
export function installAgentNotices(ipc: IpcMain, host: AgentNoticeHost): AgentNoticeChannel {
  let settings = DEFAULT_NOTICE_SETTINGS
  let published: WebContents | null = null
  let quiet = NO_QUIET_PANES

  const onPublish = (event: IpcMainEvent, payload: unknown): void => {
    if (!host.fromMainFrame(event)) return
    const next = readNoticeSettings(payload)
    if (!next) return
    settings = next
    published = event.sender
  }

  const badge = (event: BadgeEvent): void => {
    const next = quietPanesAfter(quiet, event)
    if (next === quiet) return
    quiet = next
    host.setBadge(badgeCount(quiet))
  }

  ipc.on(NOTICE_PUBLISH_CHANNEL, onPublish)

  return {
    deliver(notice) {
      const windowFocused = host.windowFocused()
      badge({ kind: 'settled', terminalId: notice.terminalId, windowFocused })
      if (!shouldNotify({ settings, windowFocused, terminalId: notice.terminalId })) return
      host.show({
        title: notice.worktree,
        body: noticeBody(notice),
        silent: noticeIsSilent(settings.preference),
        onActivate: () => {
          host.focusWindow()
          const sender = published
          if (!sender || sender.isDestroyed()) return
          sender.send(NOTICE_REVEAL_CHANNEL, { worktreeId: notice.worktreeId, terminalId: notice.terminalId })
        }
      })
    },
    noteWindowFocus() {
      badge({ kind: 'window-focused' })
    },
    stop() {
      ipc.removeAllListeners(NOTICE_PUBLISH_CHANNEL)
    }
  }
}
