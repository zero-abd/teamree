// `teamree://join?…` links the OS hands the app (`open-url` on macOS, argv
// elsewhere). One is kept until the window first asks, then each is sent as it
// arrives. Only the link crosses: the window parses it and asks before acting.

import type { IpcMain, IpcMainInvokeEvent } from 'electron'

/** Keep both in step with `src/preload/index.ts`, which repeats the literals. */
export const INVITATION_TAKE_CHANNEL = 'teamree:invitation:take'
export const INVITATION_OPEN_CHANNEL = 'teamree:invitation:open'

const JOIN_LINK = /^teamree:\/\/join\?/i

/** Longer than any real link, short enough that a flood of junk costs nothing. */
const MOST_CHARS = 8192

export function invitationInArgv(argv: readonly string[]): string | undefined {
  return argv.find((argument) => JOIN_LINK.test(argument))
}

export type InvitationHost = {
  /** Sends a link to the open window; false when there is none to send to. */
  send: (link: string) => unknown
  fromMainFrame: (event: IpcMainInvokeEvent) => boolean
}

export function installInvitationLinks(ipc: IpcMain, host: InvitationHost): { receive: (link: string) => void } {
  let pending: string | null = null
  let windowAsked = false
  ipc.handle(INVITATION_TAKE_CHANNEL, (event) => {
    if (!host.fromMainFrame(event)) return null
    windowAsked = true
    const link = pending
    pending = null
    return link
  })
  return {
    receive(link) {
      if (!JOIN_LINK.test(link) || link.length > MOST_CHARS) return
      if (windowAsked && host.send(link) !== false) return
      pending = link
    }
  }
}
