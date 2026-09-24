// Links the OS hands the app: kept until the window can take one, then sent as they come.

import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it } from 'vitest'
import {
  INVITATION_OPEN_CHANNEL,
  INVITATION_TAKE_CHANNEL,
  installInvitationLinks,
  invitationInArgv
} from './invitationLinks'

const LINK = 'teamree://join?v=1&origin=git%40github.com%3Aacme%2Fapi.git&project=api&from=ana'

function fakeIpc(): { ipc: IpcMain; take: (event?: Partial<IpcMainInvokeEvent>) => unknown } {
  let handler: ((event: IpcMainInvokeEvent) => unknown) | undefined
  const ipc = {
    handle: (channel: string, listener: (event: IpcMainInvokeEvent) => unknown) => {
      if (channel === INVITATION_TAKE_CHANNEL) handler = listener
    },
    removeHandler: () => (handler = undefined)
  } as unknown as IpcMain
  return { ipc, take: (event = {}) => handler?.({ ...event } as IpcMainInvokeEvent) }
}

describe('invitation links', () => {
  it('finds a link among the arguments a second launch carries', () => {
    expect(invitationInArgv(['/Applications/teamree.app', '--flag', LINK])).toBe(LINK)
    expect(invitationInArgv(['/Applications/teamree.app', 'https://example.com'])).toBeUndefined()
  })

  it('keeps a link that arrives before the window, and hands it over once asked', () => {
    const sent: string[] = []
    const { ipc, take } = fakeIpc()
    const inbox = installInvitationLinks(ipc, { send: (link) => sent.push(link), fromMainFrame: () => true })

    inbox.receive(LINK)
    expect(sent).toEqual([])
    expect(take()).toBe(LINK)
    expect(take()).toBeNull()

    // Once the window has asked, later links go straight to it.
    inbox.receive(LINK)
    expect(sent).toEqual([LINK])
    expect(INVITATION_OPEN_CHANNEL).toBe('teamree:invitation:open')
  })

  it('drops anything that is not a join link, and answers a subframe with nothing', () => {
    const sent: string[] = []
    const { ipc, take } = fakeIpc()
    const inbox = installInvitationLinks(ipc, { send: (link) => sent.push(link), fromMainFrame: () => false })
    inbox.receive('teamree://settings')
    inbox.receive(`teamree://join?${'x'.repeat(9000)}`)
    inbox.receive(LINK)
    expect(take()).toBeNull()
  })
})
