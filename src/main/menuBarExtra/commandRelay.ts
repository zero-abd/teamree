// A window command asked for from the menu bar, such as New Task…, chosen through the menus the
// window published. A window still opening has not published them, so the last one asked waits.

import type { MenuBarItem } from '../menuBar'

export function createCommandRelay(): {
  /** The window's menus as it last published them, and how to choose one. */
  published: (items: readonly MenuBarItem[], choose: (command: string) => void) => void
  run: (command: string) => void
} {
  let items: readonly MenuBarItem[] = []
  let choose: (command: string) => void = () => {}
  let waiting: string | null = null
  const flush = (): void => {
    if (waiting === null || !items.some((item) => item.command === waiting && item.enabled)) return
    const command = waiting
    waiting = null
    choose(command)
  }
  return {
    published(next, pick) {
      items = next
      choose = pick
      flush()
    },
    run(command) {
      waiting = command
      flush()
    }
  }
}
