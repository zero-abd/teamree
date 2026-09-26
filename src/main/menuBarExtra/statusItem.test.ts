import { describe, expect, it } from 'vitest'
import type { MenuBarAction, MenuBarState } from './model'
import { createStatusItem, dotBitmap, menuTemplate, type TrayLike } from './statusItem'

type Log = string[]

function fakeTray(log: Log, image: string): TrayLike & { emit: (event: string) => void } {
  const listeners = new Map<string, () => void>()
  log.push(`create ${image}`)
  return {
    setImage: (next) => log.push(`image ${String(next)}`),
    setTitle: (title) => log.push(`title "${title}"`),
    setToolTip: (tip) => log.push(`tooltip ${tip}`),
    popUpContextMenu: (menu) => log.push(`menu ${JSON.stringify(menu)}`),
    getBounds: () => ({ x: 1, y: 2, width: 3, height: 4 }),
    on: (event, listener) => void listeners.set(event, listener),
    destroy: () => log.push('destroy'),
    emit: (event) => listeners.get(event)?.()
  }
}

const EMPTY: MenuBarState = { worktrees: [{ id: 'w1', name: 'w' }], terminals: [], paneNames: {}, update: null }
const ASKING: MenuBarState = {
  ...EMPTY,
  terminals: [
    {
      id: 't1',
      worktreeId: 'w1',
      title: 'claude',
      cwd: '/',
      shell: 'zsh',
      cols: 80,
      rows: 24,
      running: true,
      busy: false,
      lastOutputAt: 0,
      agent: 'claude',
      titleSays: 'waiting'
    }
  ]
}

function harness(initial: MenuBarState = EMPTY) {
  const log: Log = []
  let current = initial
  const trays: ReturnType<typeof fakeTray>[] = []
  const item = createStatusItem<string, string[]>({
    createTray: (image) => {
      const tray = fakeTray(log, image)
      trays.push(tray)
      return tray
    },
    image: (kind) => kind,
    menu: (entries) => entries.map((entry) => (entry.type === 'item' ? entry.label : '-')),
    state: () => current,
    defer: (apply) => apply()
  })
  return { log, item, trays, set: (next: MenuBarState) => (current = next) }
}

describe('createStatusItem', () => {
  it('creates nothing until shown, one tray however often it is shown, and destroys it when hidden', () => {
    const { log, item } = harness()
    expect(item.shown).toBe(false)
    item.show(true)
    item.show(true)
    expect(item.shown).toBe(true)
    item.show(false)
    item.show(false)
    expect(item.shown).toBe(false)
    expect(log.filter((line) => line.startsWith('create') || line === 'destroy')).toEqual(['create idle', 'destroy'])
  })

  it('shows again after hiding, drawn from the state at that moment', () => {
    const { log, item, set } = harness()
    item.show(true)
    item.show(false)
    set(ASKING)
    item.show(true)
    expect(log.filter((line) => line.startsWith('create'))).toEqual(['create idle', 'create asking'])
  })

  it('redraws the icon only when what it says changed', () => {
    const { log, item, set } = harness()
    item.show(true)
    log.length = 0
    item.refresh()
    expect(log).toEqual([])
    set(ASKING)
    item.refresh()
    item.refresh()
    expect(log).toEqual(['image asking', 'title ""', 'tooltip teamree — 1 asking'])
  })

  it('does nothing on refresh while hidden', () => {
    const { log, item } = harness(ASKING)
    item.refresh()
    expect(log).toEqual([])
  })

  it('builds the menu from the state at the click, not at creation', () => {
    const { log, item, trays, set } = harness()
    item.show(true)
    set(ASKING)
    trays[0]?.emit('click')
    const menu = log.find((line) => line.startsWith('menu')) ?? ''
    expect(menu).toContain('w — claude')
  })

  it('answers the tray bounds only while shown', () => {
    const { item } = harness()
    expect(item.bounds()).toBeNull()
    item.show(true)
    expect(item.bounds()).toEqual({ x: 1, y: 2, width: 3, height: 4 })
  })
})

describe('menuTemplate', () => {
  it('turns entries into menu items whose clicks run their action, with the asking dot as the icon', () => {
    const ran: MenuBarAction[] = []
    const template = menuTemplate(
      [
        {
          type: 'item',
          label: 'w — claude',
          enabled: true,
          asking: true,
          action: { kind: 'reveal', worktreeId: 'w1', terminalId: 't1' }
        },
        { type: 'item', label: 'No Agents Running', enabled: false },
        { type: 'separator' },
        { type: 'item', label: 'Quit teamree', enabled: true, action: { kind: 'quit' } }
      ],
      (action) => ran.push(action),
      'dot'
    )
    expect(template.map(({ label, enabled, type, icon }) => ({ label, enabled, type, icon }))).toEqual([
      { label: 'w — claude', enabled: true, type: undefined, icon: 'dot' },
      { label: 'No Agents Running', enabled: false, type: undefined, icon: undefined },
      { label: undefined, enabled: undefined, type: 'separator', icon: undefined },
      { label: 'Quit teamree', enabled: true, type: undefined, icon: undefined }
    ])
    template[0]?.click?.()
    template[3]?.click?.()
    expect(ran).toEqual([{ kind: 'reveal', worktreeId: 'w1', terminalId: 't1' }, { kind: 'quit' }])
  })
})

describe('dotBitmap', () => {
  it('is a disc of the colour on clear, as premultiplied BGRA', () => {
    const size = 16
    const bitmap = dotBitmap(size, '#d6a24a')
    expect(bitmap.length).toBe(size * size * 4)
    const at = (x: number, y: number) => [...bitmap.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)]
    expect(at(8, 8)).toEqual([0x4a, 0xa2, 0xd6, 0xff])
    expect(at(0, 0)).toEqual([0, 0, 0, 0])
    const [blue, , , alpha] = at(2, 2)
    expect(alpha).toBeGreaterThan(0)
    expect(alpha).toBeLessThan(255)
    expect(blue).toBeLessThanOrEqual(alpha ?? 0)
  })
})
