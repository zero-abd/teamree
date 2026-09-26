import { describe, expect, it } from 'vitest'
import type { Terminal, UpdateState } from '../../shared/entities'
import { askingPanes, menuAsText, menuBarMenu, statusIcon, type MenuBarState } from './model'

function pane(id: string, worktreeId: string, facts: Partial<Terminal> = {}): Terminal {
  return {
    id,
    worktreeId,
    title: 'zsh',
    cwd: '/tmp',
    shell: '/bin/zsh',
    cols: 80,
    rows: 24,
    running: true,
    busy: false,
    lastOutputAt: 0,
    ...facts
  }
}

const asking = (id: string, worktreeId: string, facts: Partial<Terminal> = {}): Terminal =>
  pane(id, worktreeId, { agent: 'claude', agentEvent: { event: 'Notification', at: 1 }, ...facts })
const working = (id: string, worktreeId: string): Terminal => pane(id, worktreeId, { agent: 'codex', busy: true })

const update = (facts: Partial<UpdateState> = {}): UpdateState => ({
  current: '0.3.1',
  checkable: true,
  automatic: true,
  available: null,
  checking: false,
  checkedAt: null,
  problem: null,
  ...facts
})

function state(facts: Partial<MenuBarState> = {}): MenuBarState {
  return {
    worktrees: [
      { id: 'w1', name: 'login-bug' },
      { id: 'w2', name: 'api-refactor' }
    ],
    terminals: [],
    paneNames: {},
    update: update(),
    ...facts
  }
}

describe('askingPanes', () => {
  it('lists only agents asking, in worktree order, named as the window names them', () => {
    const found = askingPanes(
      state({
        terminals: [asking('t3', 'w2'), working('t2', 'w1'), asking('t1', 'w1'), pane('t4', 'w1', { busy: false })],
        paneNames: { t1: 'Claude Code 2', t3: 'Claude Code' }
      })
    )
    expect(found).toEqual([
      { terminalId: 't1', worktreeId: 'w1', label: 'login-bug — Claude Code 2' },
      { terminalId: 't3', worktreeId: 'w2', label: 'api-refactor — Claude Code' }
    ])
  })

  it('skips a pane whose worktree is gone, and names an unnamed pane by its label or title', () => {
    const found = askingPanes(
      state({ terminals: [asking('t1', 'gone'), asking('t2', 'w1', { label: 'fix auth' }), asking('t3', 'w2')] })
    )
    expect(found.map((item) => item.label)).toEqual(['login-bug — fix auth', 'api-refactor — zsh'])
  })

  it('says the worktree once when the pane is named after it', () => {
    const found = askingPanes(state({ terminals: [asking('t1', 'w1')], paneNames: { t1: 'login-bug' } }))
    expect(found[0]?.label).toBe('login-bug')
  })
})

describe('statusIcon', () => {
  it('is the plain mark with nobody asking', () => {
    expect(statusIcon(0)).toEqual({ image: 'idle', title: '', tooltip: 'teamree' })
  })

  it('carries a dot for one asking, and the count from two', () => {
    expect(statusIcon(1)).toEqual({ image: 'asking', title: '', tooltip: 'teamree — 1 asking' })
    expect(statusIcon(3)).toEqual({ image: 'asking', title: '3', tooltip: 'teamree — 3 asking' })
  })
})

describe('menuBarMenu', () => {
  it('reads as the status menu with nothing running', () => {
    expect(menuAsText(menuBarMenu(state()))).toBe(
      [
        '  No Agents Running (disabled)',
        '---',
        '  New Task…',
        '  Quick Note…',
        '---',
        '  Open teamree',
        '  Check for Updates…',
        '  Settings…',
        '---',
        '  Quit teamree'
      ].join('\n')
    )
  })

  it('puts the agents asking first, each opening its pane, then the running count', () => {
    const menu = menuBarMenu(
      state({ terminals: [asking('t1', 'w1'), working('t2', 'w1'), working('t3', 'w2')], paneNames: { t1: 'Claude' } })
    )
    expect(menuAsText(menu).split('\n').slice(0, 3)).toEqual([
      '● login-bug — Claude',
      '  2 Agents Running (disabled)',
      '---'
    ])
    expect(menu[0]).toMatchObject({ action: { kind: 'reveal', worktreeId: 'w1', terminalId: 't1' }, enabled: true })
  })

  it('counts one agent in the singular and leaves shells out', () => {
    const menu = menuBarMenu(state({ terminals: [working('t1', 'w1'), pane('t2', 'w1', { busy: true })] }))
    expect(menuAsText(menu).split('\n')[0]).toBe('  1 Agent Running (disabled)')
  })

  it('lists eight asking and folds the rest into one item that opens the window', () => {
    const terminals = Array.from({ length: 11 }, (_, index) => asking(`t${index}`, 'w1'))
    const menu = menuBarMenu(state({ terminals }))
    const lines = menuAsText(menu).split('\n')
    expect(lines.filter((line) => line.startsWith('●'))).toHaveLength(8)
    expect(lines[8]).toBe('  3 More…')
    expect(menu[8]).toMatchObject({ action: { kind: 'open' } })
  })

  it.each([
    ['nothing found', update(), 'Check for Updates…', true, 'check-updates'],
    ['a check in flight', update({ checking: true }), 'Checking for Updates…', false, undefined],
    [
      'an update downloading',
      update({ install: { state: 'downloading', version: '0.4.0', received: 1, total: 2 } }),
      'Downloading Update…',
      false,
      undefined
    ],
    [
      'an update ready',
      update({ install: { state: 'ready', version: '0.4.0' } }),
      'Restart to Update',
      true,
      'restart'
    ],
    [
      'an update this copy cannot install',
      update({ install: { state: 'ready', version: '0.4.0', blocked: { problem: 'read-only', settings: false } } }),
      'Check for Updates…',
      true,
      'check-updates'
    ],
    ['a window not yet told', null, 'Check for Updates…', true, 'check-updates']
  ] as const)('offers the update item for %s', (_case, facts, label, enabled, action) => {
    const item = menuBarMenu(state({ update: facts })).find(
      (entry) => entry.type === 'item' && entry.label.includes('Update')
    )
    expect(item).toMatchObject({ label, enabled })
    expect(item?.type === 'item' ? item.action?.kind : undefined).toBe(action)
  })

  it('maps every command to its action', () => {
    const actions = Object.fromEntries(
      menuBarMenu(state()).flatMap((entry) =>
        entry.type === 'item' && entry.action ? [[entry.label, entry.action.kind]] : []
      )
    )
    expect(actions).toEqual({
      'New Task…': 'new-task',
      'Quick Note…': 'quick-note',
      'Open teamree': 'open',
      'Check for Updates…': 'check-updates',
      'Settings…': 'settings',
      'Quit teamree': 'quit'
    })
  })
})
