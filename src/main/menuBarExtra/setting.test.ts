import { describe, expect, it } from 'vitest'
import type { WorkspaceEvent } from '../../shared/methods'
import { WorkspaceEventBus } from '../runtime/workspaceEvents'
import { followMenuBarSetting } from './setting'
import { createStatusItem, type TrayLike } from './statusItem'

function follow(initially: boolean) {
  const log: string[] = []
  const item = createStatusItem<string, string>({
    createTray: (): TrayLike => {
      log.push('create')
      return {
        setImage: () => {},
        setTitle: () => {},
        setToolTip: () => {},
        popUpContextMenu: () => {},
        getBounds: () => ({ x: 0, y: 0, width: 0, height: 0 }),
        on: () => {},
        destroy: () => log.push('destroy')
      }
    },
    image: (kind) => kind,
    menu: () => '',
    state: () => ({ worktrees: [], terminals: [], paneNames: {}, update: null }),
    defer: (apply) => apply()
  })
  let shown = initially
  const events = new WorkspaceEventBus()
  const stop = followMenuBarSetting({ shown: () => shown, events, statusItem: item })
  const set = (next: boolean, event: WorkspaceEvent = { type: 'settings' }) => {
    shown = next
    events.emit(event)
  }
  return { log, item, set, stop }
}

describe('followMenuBarSetting', () => {
  it('shows the item when the setting is on, as it is by default', () => {
    const { log, item } = follow(true)
    expect(log).toEqual(['create'])
    expect(item.shown).toBe(true)
  })

  it('stays hidden when it was turned off', () => {
    expect(follow(false).log).toEqual([])
  })

  it('destroys the tray when the setting goes off and creates it when it comes back', () => {
    const { log, item, set } = follow(true)
    set(false)
    expect(item.shown).toBe(false)
    set(true)
    expect(log).toEqual(['create', 'destroy', 'create'])
  })

  it('reads the setting on a settings event only, and stops listening when stopped', () => {
    const { log, set, stop } = follow(true)
    set(false, { type: 'terminals' })
    expect(log).toEqual(['create'])
    stop()
    set(false)
    expect(log).toEqual(['create'])
  })
})
