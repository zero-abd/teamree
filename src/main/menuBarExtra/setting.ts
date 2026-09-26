// Settings › General › Show in Menu Bar is `showInMenuBar` in the runtime settings; the status item
// follows it at launch and on every `settings` event, whoever set it.

import type { WorkspaceEvent } from '../../shared/methods'
import type { StatusItem } from './statusItem'

export function followMenuBarSetting(host: {
  shown: () => boolean
  events: { on: (listener: (event: WorkspaceEvent) => void) => () => void }
  statusItem: Pick<StatusItem, 'show'>
}): () => void {
  host.statusItem.show(host.shown())
  return host.events.on((event) => {
    if (event.type === 'settings') host.statusItem.show(host.shown())
  })
}
