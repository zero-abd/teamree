/** @vitest-environment jsdom */

// The terminal block's preview is drawn in the font, size, line height and cursor set beside it, so a face is
// judged before it reaches a pane.

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: () => new Promise(() => {}),
    watchPane: () => new Promise(() => {}),
    subscribeTerminal: () => new Promise(() => {}),
    watchWorkspace: () => ({ close: () => {} }),
    connection: { phase: 'ready' },
    onConnectionChange: () => () => {}
  },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { TERMINAL_OPTIONS_DEFAULT } = await import('../state/preferences')
const { TerminalBlock, fontName } = await import('./TerminalSettings')

const INITIAL = useWorkspaceStore.getState()
const setTerminalFontSize = vi.fn((size: number) => useWorkspaceStore.setState({ terminalFontSize: size }))
const setTerminalOptions = vi.fn((changes: Partial<typeof TERMINAL_OPTIONS_DEFAULT>) =>
  useWorkspaceStore.setState((state) => ({ terminalOptions: { ...state.terminalOptions, ...changes } }))
)

beforeEach(() => {
  useWorkspaceStore.setState(
    {
      ...INITIAL,
      terminalFontSize: 13,
      terminalOptions: { ...TERMINAL_OPTIONS_DEFAULT, lineHeight: 1.25, cursorStyle: 'bar', cursorBlink: true },
      setTerminalFontSize,
      setTerminalOptions
    },
    true
  )
})

afterEach(cleanup)

const screenOf = (): HTMLElement => screen.getByTestId('terminal-preview').firstChild as HTMLElement
const cursor = (): HTMLElement =>
  screen.getByTestId('terminal-preview').querySelector('.term-preview__cursor') as HTMLElement

describe('the terminal preview', () => {
  it('is drawn in the font, size and line height in effect, with the cursor set', () => {
    render(<TerminalBlock idPrefix="t" />)
    expect(screenOf().style.fontFamily).toBe(TERMINAL_OPTIONS_DEFAULT.fontFamily)
    expect(screenOf().style.fontSize).toBe('13px')
    expect(screenOf().style.lineHeight).toBe('1.25')
    expect(cursor().className).toContain('term-preview__cursor--bar')
    expect(cursor().hasAttribute('data-blink')).toBe(true)
  })

  it('follows every control beside it', () => {
    render(<TerminalBlock idPrefix="t" />)
    fireEvent.click(screen.getByRole('button', { name: 'More Terminal text size' }))
    expect(screenOf().style.fontSize).toBe('14px')

    fireEvent.change(screen.getByLabelText('Font'), { target: { value: 'Menlo, monospace' } })
    expect(screenOf().style.fontFamily).toBe('Menlo, monospace')

    const height = screen.getByLabelText('Line height')
    fireEvent.change(height, { target: { value: '1.5' } })
    fireEvent.keyDown(height, { key: 'Enter' })
    expect(screenOf().style.lineHeight).toBe('1.5')

    fireEvent.click(within(screen.getByRole('group', { name: 'Cursor' })).getByRole('button', { name: 'Block' }))
    expect(cursor().className).toContain('term-preview__cursor--block')

    fireEvent.click(screen.getByLabelText('Blink'))
    expect(cursor().hasAttribute('data-blink')).toBe(false)
  })

  it('shows all sixteen terminal colours', () => {
    render(<TerminalBlock idPrefix="t" />)
    const swatches = screen.getByTestId('terminal-preview').querySelectorAll('.term-preview__ansi > span')
    expect(swatches).toHaveLength(16)
    expect((swatches[9] as HTMLElement).style.background).toBe('var(--term-bright-red)')
  })

  it('names a font stack by its first face', () => {
    expect(fontName(TERMINAL_OPTIONS_DEFAULT.fontFamily)).toBe('SF Mono')
    expect(fontName('"JetBrains Mono", ui-monospace, monospace')).toBe('JetBrains Mono')
    expect(fontName('monospace')).toBe('Monospace')
  })
})
