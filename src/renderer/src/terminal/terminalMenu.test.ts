/** @vitest-environment jsdom */

// The menu a right-click on a pane's terminal opens: its rows for each thing under the pointer, the
// reduced one on a teammate's pane, when the right-click is the program's, and what each row does.

import { describe, expect, it, vi } from 'vitest'
import { Terminal as XTerm } from '@xterm/xterm'
import { resolvePlatformModifier } from '../keyboard/platformModifier'
import {
  holdRightClickFromProgram,
  reportsMouse,
  rightClickOpensMenu,
  runTerminalMenuAction,
  terminalMenuEntries,
  type TerminalMenuContext,
  type TerminalMenuHost
} from './terminalMenu'

const MAC = resolvePlatformModifier('darwin')
const PC = resolvePlatformModifier('linux')

const plain: TerminalMenuContext = { readOnly: false, hasSelection: false, pointed: null }

const rows = (context: TerminalMenuContext, modifier = MAC): string[] =>
  terminalMenuEntries(context, modifier).map(
    (entry) =>
      `${entry.separated === true ? '— ' : ''}${entry.label}${entry.hint === undefined ? '' : ` ${entry.hint}`}${
        entry.disabled === true ? ' (off)' : ''
      }`
  )

describe('the rows', () => {
  it('offers the clipboard, clearing, finding and splitting, each with its chord', () => {
    expect(rows(plain)).toEqual([
      'Copy ⌘C (off)',
      'Paste ⌘V',
      'Select All ⌘A',
      'Clear ⌘⌥K',
      'Find… ⌘F',
      '— Split Right ⌘D',
      'Split Down ⌘⇧D'
    ])
  })

  it('turns Copy on over a selection', () => {
    expect(rows({ ...plain, hasSelection: true })[0]).toBe('Copy ⌘C')
  })

  it('leads with the link under the pointer', () => {
    const context: TerminalMenuContext = { ...plain, pointed: { kind: 'link', uri: 'https://example.com' } }
    expect(rows(context).slice(0, 3)).toEqual(['Open Link', 'Copy Link', '— Copy ⌘C (off)'])
  })

  it('leads with Reveal in Finder over a path the worktree lists', () => {
    const context: TerminalMenuContext = {
      ...plain,
      pointed: { kind: 'path', path: 'src/a.ts', absolute: '/repo/src/a.ts' }
    }
    expect(rows(context).slice(0, 2)).toEqual(['Reveal in Finder', '— Copy ⌘C (off)'])
  })

  it('gives a teammate’s pane only Copy and Select All, whatever is under the pointer', () => {
    const context: TerminalMenuContext = {
      readOnly: true,
      hasSelection: true,
      pointed: { kind: 'link', uri: 'https://example.com' }
    }
    expect(rows(context)).toEqual(['Copy ⌘C', 'Select All ⌘A'])
  })

  it('shows no clipboard chords where Ctrl+C is the interrupt', () => {
    expect(rows(plain, PC)).toEqual([
      'Copy (off)',
      'Paste',
      'Select All',
      'Clear Ctrl+Alt+K',
      'Find… Ctrl+F',
      '— Split Right Ctrl+D',
      'Split Down Ctrl+Shift+D'
    ])
  })
})

describe('whose right-click it is', () => {
  const click = { altKey: false, shiftKey: false }

  it('is the menu’s while the program has not asked for the mouse', () => {
    expect(rightClickOpensMenu(click, false, MAC)).toBe(true)
    expect(rightClickOpensMenu(click, false, PC)).toBe(true)
  })

  it('is the program’s once it has, unless ⌥ is held on a Mac', () => {
    expect(rightClickOpensMenu(click, true, MAC)).toBe(false)
    expect(rightClickOpensMenu({ ...click, altKey: true }, true, MAC)).toBe(true)
    expect(rightClickOpensMenu({ ...click, shiftKey: true }, true, MAC)).toBe(false)
  })

  it('is the program’s once it has, unless Shift is held elsewhere', () => {
    expect(rightClickOpensMenu(click, true, PC)).toBe(false)
    expect(rightClickOpensMenu({ ...click, shiftKey: true }, true, PC)).toBe(true)
    expect(rightClickOpensMenu({ ...click, altKey: true }, true, PC)).toBe(false)
  })

  it('reads the program’s mouse mode off the emulator', async () => {
    const term = new XTerm({ allowProposedApi: true })
    term.open(document.body.appendChild(document.createElement('div')))
    expect(reportsMouse(term)).toBe(false)
    await new Promise<void>((resolve) => term.write('\x1b[?1000h\x1b[?1006h', resolve))
    expect(reportsMouse(term)).toBe(true)
    term.dispose()
  })

  it('keeps a bypassing right-click from the program, and leaves the program its own', () => {
    const host = document.createElement('div')
    const inner = host.appendChild(document.createElement('div'))
    const program = vi.fn()
    inner.addEventListener('mousedown', program)
    let reporting = true
    const took = vi.fn()
    const release = holdRightClickFromProgram(host, () => reporting, MAC, took)
    const press = (init: MouseEventInit): void => {
      inner.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2, ...init }))
    }

    press({ altKey: true })
    expect(program).not.toHaveBeenCalled()
    expect(took).toHaveBeenCalledTimes(1)
    press({})
    expect(program).toHaveBeenCalledTimes(1)
    reporting = false
    press({ altKey: true })
    expect(program).toHaveBeenCalledTimes(2)

    release()
    reporting = true
    press({ altKey: true })
    expect(program).toHaveBeenCalledTimes(3)
  })
})

describe('what each row does', () => {
  function host(): TerminalMenuHost & { calls: string[] } {
    const calls: string[] = []
    return {
      calls,
      term: {
        getSelection: () => 'selected text',
        selectAll: () => calls.push('selectAll'),
        clear: () => calls.push('clear'),
        paste: (text) => calls.push(`paste ${text}`)
      },
      clipboard: { copy: (text) => calls.push(`copy ${text}`), read: async () => 'from clipboard' },
      byHand: () => calls.push('byHand'),
      openLink: (uri) => calls.push(`open ${uri}`),
      copyLink: (uri) => calls.push(`copyLink ${uri}`),
      reveal: (absolute, path) => calls.push(`reveal ${absolute} ${path}`),
      find: () => calls.push('find'),
      split: (direction) => calls.push(`split ${direction}`)
    }
  }

  it('copies the selection, selects all and clears the emulator', () => {
    const target = host()
    runTerminalMenuAction('copy', null, target)
    runTerminalMenuAction('select-all', null, target)
    runTerminalMenuAction('clear', null, target)
    expect(target.calls).toEqual(['copy selected text', 'selectAll', 'clear'])
  })

  it('pastes through the emulator, vouched for as typing', async () => {
    const target = host()
    runTerminalMenuAction('paste', null, target)
    await vi.waitFor(() => expect(target.calls).toEqual(['byHand', 'paste from clipboard']))
  })

  it('pastes nothing from an empty clipboard', async () => {
    const target = { ...host(), clipboard: { copy: () => {}, read: async () => '' } }
    runTerminalMenuAction('paste', null, target)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(target.calls).toEqual([])
  })

  it('opens and copies the link it was raised over, and reveals the path', () => {
    const target = host()
    runTerminalMenuAction('open-link', { kind: 'link', uri: 'https://example.com' }, target)
    runTerminalMenuAction('copy-link', { kind: 'link', uri: 'https://example.com' }, target)
    runTerminalMenuAction('reveal-path', { kind: 'path', path: 'src/a.ts', absolute: '/repo/src/a.ts' }, target)
    expect(target.calls).toEqual([
      'open https://example.com',
      'copyLink https://example.com',
      'reveal /repo/src/a.ts src/a.ts'
    ])
  })

  it('finds and splits', () => {
    const target = host()
    runTerminalMenuAction('find', null, target)
    runTerminalMenuAction('split-right', null, target)
    runTerminalMenuAction('split-down', null, target)
    expect(target.calls).toEqual(['find', 'split row', 'split column'])
  })
})
