// Telling somebody an agent stopped, when they are not looking at the window.
//
// The premise of this app is that you start three agents and go and do
// something else. Until this existed nothing ever left the window: a pane going
// quiet moved a dot on a sidebar row, and the only way to see it was to keep
// the window in front of you and glance at it — which is the opposite of going
// and doing something else.
//
// So a pane that is running an agent raises an OS notification when its output
// goes quiet or its process ends. Only an agent pane: a shell going quiet is a
// shell sitting at its prompt, which is every shell, all the time.
//
// Two of the three facts the decision needs are not this process's to know.
// Whether the window has the focus it does know; which pane inside the window
// has the focus it does not, and what the person asked for is in the window's
// own storage beside the terminal font size. Both arrive on one channel from
// the window, the same way the menu bar's items do and for the same reason —
// there is one copy of each fact and it is held where it is decided.
//
// What this file is careful about is the same thing `menuBar.ts` is careful
// about: everything arriving on that channel is rebuilt out of fields that were
// checked, because it comes over IPC and "it can only be ours" stops being true
// the moment anything else can reach the bridge.

import type { IpcMain, IpcMainEvent, WebContents } from 'electron'

/** Keep both in step with `src/preload/index.ts`, which repeats the literals. */
export const NOTICE_PUBLISH_CHANNEL = 'teamree:notices:publish'
export const NOTICE_REVEAL_CHANNEL = 'teamree:notices:reveal'

/**
 * What the person asked for, per machine.
 *
 * Three values rather than a boolean and a second boolean, because "sound
 * without a notification" is not a thing anybody wants and offering it would be
 * a setting that can be put into a state with no meaning.
 */
export type AgentNoticePreference = 'off' | 'notify' | 'sound'

export const AGENT_NOTICE_PREFERENCES: readonly AgentNoticePreference[] = ['off', 'notify', 'sound']

/**
 * What the window last said about itself: what it wants, and which of its panes
 * has the focus. `null` when nothing does, or when a teammate's pane does —
 * neither of those is a pane this process can raise a notification about.
 */
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
 * The settings, rebuilt field by field, or null if the message was not a pair
 * of them.
 *
 * Rebuilt rather than passed through for the reason `readMenuBarItems` is: what
 * a sender put on the object beyond these two fields has no business reaching
 * anything, and a preference that is not one of the three would silently read
 * as "off" in a comparison written the obvious way.
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
 * One agent pane that has stopped, as the runtime hands it over.
 *
 * `worktree` is the task's name and not its id, because it is what goes in the
 * title of the notification and the id means nothing to a reader. `line` is the
 * pane's last line worth quoting, which is often null — a full-screen agent
 * owns the grid and quoting one row of it would be inventing meaning; see
 * `src/shared/outputEvidence.ts`.
 */
export type AgentNotice = {
  terminalId: string
  worktreeId: string
  worktree: string
  reason: AgentNoticeReason
  line: string | null
}

/**
 * Whether this pane stopping is worth interrupting somebody for.
 *
 * The one case that is not is the one where they are already looking at it:
 * the window has the focus *and* this is the pane inside it that does. A
 * notification then would be the app telling somebody something they are
 * reading. Any other combination notifies — a focused window with another pane
 * selected included, because three agents in three worktrees is the whole point
 * and only one of them can be on screen.
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
 * What the notification says under the worktree's name.
 *
 * The evidence line when there is one. When there is not — a full-screen agent,
 * a pane that printed nothing but a prompt — it says which of the two things
 * happened rather than nothing at all, because a notification with an empty
 * body reads on macOS as a notification that failed to say anything.
 */
export function noticeBody(notice: AgentNotice): string {
  if (notice.line !== null) return notice.line
  return notice.reason === 'exit' ? 'Exited.' : 'Went quiet.'
}

/**
 * The panes counted on the dock badge.
 *
 * A set rather than a number, because the number people want is how many agents
 * are waiting for them and not how many times output stopped. An agent that
 * goes quiet, prints one more line and goes quiet again is one agent.
 */
export type QuietPanes = ReadonlySet<string>

export const NO_QUIET_PANES: QuietPanes = new Set()

export type BadgeEvent =
  /** An agent pane stopped. Counted only while the window is away. */
  | { kind: 'settled'; terminalId: string; windowFocused: boolean }
  /**
   * The window came back. Everything counted is now a glance away, so the badge
   * goes — rather than waiting for each pane to be visited, which would leave a
   * number on the dock for panes somebody has already dealt with.
   */
  | { kind: 'window-focused' }

export function quietPanesAfter(panes: QuietPanes, event: BadgeEvent): QuietPanes {
  if (event.kind === 'window-focused') return panes.size === 0 ? panes : NO_QUIET_PANES
  if (event.windowFocused || panes.has(event.terminalId)) return panes
  return new Set([...panes, event.terminalId])
}

export function badgeCount(panes: QuietPanes): number {
  return panes.size
}

/**
 * Everything this module needs from Electron, named so nothing above has to
 * import it.
 */
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
 * Listens for the window's settings, and announces panes that stop.
 *
 * The reveal goes back to the web contents that published, and only while it is
 * still there — the same rule the menu bar's choice follows, because a
 * notification outlives the window it was raised for and a click in that gap
 * must be dropped rather than thrown.
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
