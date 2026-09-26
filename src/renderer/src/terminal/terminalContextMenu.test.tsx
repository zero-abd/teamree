/** @vitest-environment jsdom */

// A right-click on a pane's terminal: it opens the menu at the pointer with Copy off until something
// is selected, leads with the link under the pointer, pastes through the emulator, and leaves a
// program that asked for the mouse its right-click unless ⌥ is held.

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

type LinkOptions = { hover?: (event: MouseEvent, text: string) => void; leave?: () => void }

type FakeTerm = {
  element: HTMLElement | null
  selection: string
  mouseTrackingMode: string
  pasted: string[]
  cleared: number
  selectedAll: number
}

const terms = vi.hoisted(() => [] as unknown[])
const fakeTerms = terms as FakeTerm[]
const webLinks = vi.hoisted(() => [] as unknown[])

vi.mock('@xterm/xterm', () => {
  class Terminal {
    options: Record<string, unknown>
    element: HTMLElement | null = null
    cols = 80
    rows = 24
    selection = ''
    mouseTrackingMode = 'none'
    pasted: string[] = []
    cleared = 0
    selectedAll = 0

    constructor(options: Record<string, unknown>) {
      this.options = options
      terms.push(this)
    }

    get modes(): { mouseTrackingMode: string } {
      return { mouseTrackingMode: this.mouseTrackingMode }
    }

    open(host: HTMLElement): void {
      this.element = document.createElement('div')
      host.appendChild(this.element)
    }

    write(_text: string, done?: () => void): void {
      if (done) queueMicrotask(done)
    }

    hasSelection(): boolean {
      return this.selection !== ''
    }
    getSelection(): string {
      return this.selection
    }
    paste(text: string): void {
      this.pasted.push(text)
    }
    clear(): void {
      this.cleared += 1
    }
    selectAll(): void {
      this.selectedAll += 1
    }

    resize(): void {}
    onData(): { dispose: () => void } {
      return { dispose: () => {} }
    }
    onResize(): { dispose: () => void } {
      return { dispose: () => {} }
    }
    onSelectionChange(): { dispose: () => void } {
      return { dispose: () => {} }
    }
    onWriteParsed(): { dispose: () => void } {
      return { dispose: () => {} }
    }
    buffer = { active: { baseY: 0, getLine: () => undefined } }
    attachCustomKeyEventHandler(): void {}
    registerLinkProvider(): { dispose: () => void } {
      return { dispose: () => {} }
    }
    loadAddon(addon: { activate?: (term: unknown) => void }): void {
      addon.activate?.(this)
    }
    focus(): void {}
    blur(): void {}
    dispose(): void {}
  }
  return { Terminal }
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    proposeDimensions(): undefined {
      return undefined
    }
    fit(): void {}
  }
}))
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    constructor(_handler: unknown, options: LinkOptions) {
      webLinks.push(options)
    }
  }
}))
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {
    onDidChangeResults(): void {}
    clearDecorations(): void {}
  }
}))
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss(): void {}
    dispose(): void {}
  }
}))

globalThis.ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: async (method: string) => (method === 'terminal.read' ? { data: '' } : {}),
    subscribeTerminal: async () => ({ close: () => {} })
  },
  RUNTIME_IS_SEEDED: false
}))

const readText = vi.fn(async () => 'echo pasted')
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: { readText, writeText: vi.fn(async () => {}) }
})
Object.defineProperty(window, 'teamree', { configurable: true, value: { platform: 'darwin' } })

const { TerminalView } = await import('./TerminalView')

async function mount(): Promise<FakeTerm> {
  render(
    <TerminalView
      terminalId="t1"
      focused
      onFocus={() => {}}
      isAppChord={() => false}
      searchOpen={false}
      searchToken={0}
      onCloseSearch={() => {}}
    />
  )
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return fakeTerms.at(-1)!
}

const surface = (): HTMLElement => document.querySelector('.terminal-surface') as HTMLElement

function rightClick(init: MouseEventInit = {}): void {
  fireEvent.contextMenu(surface(), { clientX: 40, clientY: 50, button: 2, ...init })
}

const labels = (): string[] =>
  within(screen.getByRole('menu'))
    .getAllByRole('menuitem')
    .map((item) => item.textContent ?? '')

beforeEach(() => {
  fakeTerms.length = 0
  webLinks.length = 0
})

afterEach(async () => {
  cleanup()
  await new Promise((resolve) => setTimeout(resolve, 0))
})

it('opens at the pointer, with Copy off while nothing is selected', async () => {
  await mount()
  rightClick()
  const copy = screen.getByRole('menuitem', { name: /^Copy/ })
  expect(copy.getAttribute('aria-disabled')).toBe('true')
  expect(labels()).toContain('Split Right⌘D')
  expect(screen.getByRole('menu').style.left).toBe('40px')
  fireEvent.click(copy)
  expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
  expect(screen.getByRole('menu')).toBeTruthy()
})

it('turns Copy on over a selection and leaves the selection alone', async () => {
  const term = await mount()
  term.selection = 'kept'
  rightClick()
  expect(screen.getByRole('menuitem', { name: /^Copy/ }).getAttribute('aria-disabled')).toBeNull()
  expect(term.selection).toBe('kept')
})

it('leads with the link the pointer is on', async () => {
  await mount()
  const links = webLinks.at(-1) as LinkOptions
  act(() => links.hover?.(new MouseEvent('mousemove'), 'https://example.com/pr/1'))
  rightClick()
  expect(labels().slice(0, 2)).toEqual(['Open Link', 'Copy Link'])
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  act(() => links.leave?.())
  rightClick()
  expect(labels()[0]).toMatch(/^Copy/)
})

it('pastes through the emulator, which adds the program’s bracketed-paste markers', async () => {
  const term = await mount()
  rightClick()
  fireEvent.click(screen.getByRole('menuitem', { name: /^Paste/ }))
  await vi.waitFor(() => expect(term.pasted).toEqual(['echo pasted']))
  expect(screen.queryByRole('menu')).toBeNull()
})

it('leaves the right-click to a program reporting the mouse, unless ⌥ is held', async () => {
  const term = await mount()
  term.mouseTrackingMode = 'vt200'
  rightClick()
  expect(screen.queryByRole('menu')).toBeNull()
  rightClick({ altKey: true })
  expect(screen.getByRole('menu')).toBeTruthy()
})
