// The status item itself: one tray while the setting is on, none while it is off. The menu is built
// on each click so it is never older than the click; the icon is redrawn when what it says changes.

import { askingPanes, menuBarMenu, statusIcon, type MenuBarAction, type MenuBarEntry, type MenuBarState } from './model'

type Bounds = { x: number; y: number; width: number; height: number }

/** The parts of Electron's `Tray` used here. */
export type TrayLike = {
  setImage: (image: never) => void
  setTitle: (title: string) => void
  setToolTip: (tip: string) => void
  popUpContextMenu: (menu: never) => void
  getBounds: () => Bounds
  // Method syntax: Tray's per-event overloads only match a bivariant signature.
  on(event: 'click' | 'right-click', listener: () => void): unknown
  destroy: () => void
}

export type StatusItemHost<Image, Menu> = {
  createTray: (image: Image) => TrayLike
  image: (kind: 'idle' | 'asking') => Image
  menu: (entries: MenuBarEntry[]) => Menu
  state: () => MenuBarState
  /** Runs a redraw on a fresh turn: an NSStatusItem changed from inside an AppKit callout can deadlock. */
  defer: (apply: () => void) => void
}

export type StatusItem = {
  readonly shown: boolean
  show: (on: boolean) => void
  refresh: () => void
  /** Where the item sits on screen, for placing a window under it; null while hidden. */
  bounds: () => Bounds | null
}

export function createStatusItem<Image, Menu>(host: StatusItemHost<Image, Menu>): StatusItem {
  let tray: TrayLike | null = null
  let drawn = ''
  let pending = false

  const draw = (target: TrayLike): void => {
    const icon = statusIcon(askingPanes(host.state()).length)
    const said = JSON.stringify(icon)
    if (said === drawn) return
    drawn = said
    target.setImage(host.image(icon.image) as never)
    target.setTitle(icon.title)
    target.setToolTip(icon.tooltip)
  }

  return {
    get shown() {
      return tray !== null
    },
    show(on) {
      if (on === (tray !== null)) return
      if (!on) {
        tray?.destroy()
        tray = null
        return
      }
      const icon = statusIcon(askingPanes(host.state()).length)
      const created = host.createTray(host.image(icon.image))
      drawn = ''
      draw(created)
      const open = (): void => created.popUpContextMenu(host.menu(menuBarMenu(host.state())) as never)
      created.on('click', open)
      created.on('right-click', open)
      tray = created
    },
    refresh() {
      if (tray === null || pending) return
      pending = true
      host.defer(() => {
        pending = false
        if (tray !== null) draw(tray)
      })
    },
    bounds: () => tray?.getBounds() ?? null
  }
}

export type MenuTemplateItem<Icon> = {
  type?: 'separator'
  label?: string
  enabled?: boolean
  icon?: Icon
  click?: () => void
}

/** Entries as `Menu.buildFromTemplate` takes them; an agent asking carries `dot`. */
export function menuTemplate<Icon>(
  entries: readonly MenuBarEntry[],
  run: (action: MenuBarAction) => void,
  dot: Icon
): MenuTemplateItem<Icon>[] {
  return entries.map((entry) => {
    if (entry.type === 'separator') return { type: 'separator' }
    const { action } = entry
    return {
      label: entry.label,
      enabled: entry.enabled,
      ...(entry.asking ? { icon: dot } : {}),
      ...(action === undefined ? {} : { click: () => run(action) })
    }
  })
}

/** A disc `size` pixels across in `color` (`#rrggbb`), as the premultiplied BGRA `createFromBitmap` reads. */
export function dotBitmap(size: number, color: string): Buffer {
  const [red, green, blue] = [1, 3, 5].map((at) => Number.parseInt(color.slice(at, at + 2), 16) || 0)
  const bitmap = Buffer.alloc(size * size * 4)
  const radius = size / 2
  const samples = 4
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inside = 0
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const dx = x + (sx + 0.5) / samples - radius
          const dy = y + (sy + 0.5) / samples - radius
          if (dx * dx + dy * dy <= radius * radius) inside++
        }
      }
      const alpha = inside / (samples * samples)
      const at = (y * size + x) * 4
      bitmap[at] = Math.round((blue ?? 0) * alpha)
      bitmap[at + 1] = Math.round((green ?? 0) * alpha)
      bitmap[at + 2] = Math.round((red ?? 0) * alpha)
      bitmap[at + 3] = Math.round(255 * alpha)
    }
  }
  return bitmap
}
