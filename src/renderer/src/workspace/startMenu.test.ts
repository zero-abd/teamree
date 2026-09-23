// What the strip's `+` offers, and in what order.
//
// The rows are built from the runtime's probe rather than from a list of
// names, for the reason the palette's are: a row for an agent nobody has
// installed is a promise that choosing it does something. So the tests here
// hand the model what `agent.list` answered and read the menu off that.

import { describe, expect, it, vi } from 'vitest'
import type { InstalledAgent } from '@shared/entities'
import { resolvePlatformModifier } from '../keyboard/platformModifier'
import { MENU_ROWS, startMenuItems, type StartMenuActions } from './startMenu'

const mac = resolvePlatformModifier('darwin')
const claude: InstalledAgent = { kind: 'claude', command: 'claude', binary: '/usr/local/bin/claude' }
const codex: InstalledAgent = { kind: 'codex', command: 'codex', binary: '/opt/bin/codex' }

const actions = (): StartMenuActions => ({
  newTerminal: vi.fn(),
  newMarkdown: vi.fn(),
  startAgent: vi.fn(),
  openAgentSettings: vi.fn()
})

describe('the rows', () => {
  it('lists a terminal, then every agent the runtime found, then the agent settings', () => {
    const items = startMenuItems([claude, codex], mac, actions())
    expect(items.map((item) => item.label)).toEqual([
      'New terminal',
      'New markdown',
      'claude',
      'codex',
      'Agent settings…'
    ])
  })

  it('keeps the agents in the order the runtime returned them', () => {
    const items = startMenuItems([codex, claude], mac, actions())
    expect(items.map((item) => item.label)).toEqual([
      'New terminal',
      'New markdown',
      'codex',
      'claude',
      'Agent settings…'
    ])
  })

  it('draws a rule before the agents and another before the settings', () => {
    const items = startMenuItems([claude, codex], mac, actions())
    expect(items.map((item) => item.separated === true)).toEqual([false, false, true, false, true])
  })

  it('names the terminal chord on its row, and no other', () => {
    const items = startMenuItems([claude], mac, actions())
    expect(items.map((item) => item.hint ?? '')).toEqual(['⌘T', '⌘⇧M', '', ''])
  })

  it('offers nothing for an agent the runtime did not find', () => {
    const items = startMenuItems([claude], mac, actions())
    expect(items.find((item) => item.label === 'codex')).toBeUndefined()
  })

  it('still offers the terminal and the settings when the probe found nothing', () => {
    const items = startMenuItems([], mac, actions())
    expect(items.map((item) => item.label)).toEqual(['New terminal', 'New markdown', 'Agent settings…'])
    expect(items[2]?.separated).toBe(true)
  })

  // The insertion point another pane kind is added at: a fixed row before the
  // agents, and the agents are the one group that is not a list of rows.
  it('keeps the agents as their own group between the fixed rows', () => {
    expect(MENU_ROWS.indexOf('agents')).toBe(1)
  })
})

describe('choosing a row', () => {
  it('starts the agent the row is for, and nothing else', () => {
    const chosen = actions()
    const items = startMenuItems([claude, codex], mac, chosen)
    items.find((item) => item.label === 'codex')?.onChoose()
    expect(chosen.startAgent).toHaveBeenCalledExactlyOnceWith('codex')
    expect(chosen.newTerminal).not.toHaveBeenCalled()
    expect(chosen.openAgentSettings).not.toHaveBeenCalled()
  })

  it('opens a terminal from the first row', () => {
    const chosen = actions()
    startMenuItems([claude], mac, chosen)[0]?.onChoose()
    expect(chosen.newTerminal).toHaveBeenCalledOnce()
    expect(chosen.startAgent).not.toHaveBeenCalled()
  })

  it('opens the agent settings from the last row', () => {
    const chosen = actions()
    startMenuItems([claude], mac, chosen).at(-1)?.onChoose()
    expect(chosen.openAgentSettings).toHaveBeenCalledOnce()
    expect(chosen.startAgent).not.toHaveBeenCalled()
  })
})
