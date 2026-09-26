/** @vitest-environment jsdom */

// The ways a pane used to draw zsh's line fill twice or narrower than it was written, leaving a
// reverse-video `%`: a remount replaying the stream into a new emulator, output that arrived while
// the snapshot was in flight written again after it, and an emulator narrowed before its pty.

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

type FakeTerm = {
  element: HTMLElement | null
  writes: string[]
  /** The width each write landed at. */
  widths: number[]
  disposed: boolean
  cols: number
}

/** The size the fit addon would give the pane's box. */
const box = vi.hoisted(() => ({ cols: 100, rows: 30 }))

const terms = vi.hoisted(() => [] as unknown[])
const fakeTerms = terms as FakeTerm[]

vi.mock('@xterm/xterm', () => {
  class Terminal {
    options: Record<string, unknown>
    element: HTMLElement | null = null
    writes: string[] = []
    disposed = false
    cols = 80
    rows = 24

    constructor(options: Record<string, unknown>) {
      this.options = options
      terms.push(this)
    }

    open(host: HTMLElement): void {
      this.element = document.createElement('div')
      host.appendChild(this.element)
    }

    widths: number[] = []

    write(text: string, done?: () => void): void {
      this.writes.push(text)
      this.widths.push(this.cols)
      if (done) queueMicrotask(done)
    }

    resize(cols: number, rows: number): void {
      this.cols = cols
      this.rows = rows
    }

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

    dispose(): void {
      this.disposed = true
    }
  }
  return { Terminal }
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    term: { cols: number; rows: number } | null = null
    activate(term: { cols: number; rows: number }): void {
      this.term = term
    }
    proposeDimensions(): { cols: number; rows: number } {
      return { ...box }
    }
    fit(): void {
      Object.assign(this.term!, box)
    }
  }
}))

// jsdom lays nothing out; a pane with no box is never fitted.
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 })
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 })
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
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

type StreamEvent = { type: 'data'; data: string; end?: number }

/** The runtime's answer to `terminal.read`, and what the pane prints while that read is in flight. */
const runtime = {
  snapshot: { data: 'prompt % ' } as { data: string; end?: number; widest?: number },
  duringRead: [] as StreamEvent[]
}
let emit: (event: StreamEvent) => void = () => {}

/** Holds `terminal.resize` answers back while set. */
let resizes: (() => void)[] | null = null

const call = vi.fn(async (method: string, _params: unknown) => {
  if (method === 'terminal.resize' && resizes) await new Promise<void>((resolve) => resizes!.push(resolve))
  if (method !== 'terminal.read') return {}
  for (const event of runtime.duringRead) emit(event)
  return runtime.snapshot
})
const closed = vi.fn()

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: (method: string, params: unknown) => call(method, params),
    subscribeTerminal: async (_terminalId: string, onEvent: (event: StreamEvent) => void) => {
      emit = onEvent
      return { close: closed }
    }
  },
  RUNTIME_IS_SEEDED: false
}))

const { TerminalView } = await import('./TerminalView')

function Pane({ nested }: { nested: boolean }): React.JSX.Element {
  const view = (
    <TerminalView
      terminalId="t1"
      focused={false}
      onFocus={() => {}}
      isAppChord={() => false}
      searchOpen={false}
      searchToken={0}
      onCloseSearch={() => {}}
    />
  )
  // A different element type above the view, as a split gives it: React remounts the view.
  return nested ? <section className="split">{view}</section> : <main>{view}</main>
}

/** Lets the view's subscribe-then-read chain settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

afterEach(async () => {
  // Unmounted and let go before the next test, which mounts the same pane id.
  cleanup()
  await new Promise((resolve) => setTimeout(resolve, 0))
  runtime.snapshot = { data: 'prompt % ' }
  runtime.duringRead = []
  Object.assign(box, { cols: 100, rows: 30 })
  resizes = null
  fakeTerms.length = 0
  call.mockClear()
  closed.mockClear()
})

it('moves the emulator into the new pane rather than replaying the stream into another', async () => {
  const view = render(<Pane nested={false} />)
  await settle()
  view.rerender(<Pane nested />)
  await settle()

  expect(fakeTerms).toHaveLength(1)
  const [term] = fakeTerms
  expect(term!.disposed).toBe(false)
  expect(document.querySelector('.split .terminal-surface')!.contains(term!.element)).toBe(true)
  expect(call.mock.calls.filter(([method]) => method === 'terminal.read')).toHaveLength(1)
  expect(term!.writes).toEqual(['prompt % '])
  view.unmount()
  await settle()
})

it('lets the emulator go once the pane has really closed', async () => {
  const view = render(<Pane nested={false} />)
  await settle()
  view.unmount()
  await settle()

  expect(fakeTerms[0]!.disposed).toBe(true)
  expect(closed).toHaveBeenCalledOnce()
})

it('writes output the snapshot already holds once', async () => {
  runtime.duringRead = [{ type: 'data', data: 'prompt % ', end: 9 }]
  runtime.snapshot = { data: 'prompt % ', end: 9 }
  const view = render(<Pane nested={false} />)
  await settle()

  expect(fakeTerms[0]!.writes.join('')).toBe('prompt % ')
  view.unmount()
  await settle()
})

it('writes only the part of a chunk the snapshot missed', async () => {
  runtime.duringRead = [
    { type: 'data', data: 'abc', end: 3 },
    { type: 'data', data: 'def', end: 6 }
  ]
  runtime.snapshot = { data: 'abcd', end: 4 }
  const view = render(<Pane nested={false} />)
  await settle()

  expect(fakeTerms[0]!.writes.join('')).toBe('abcdef')
  view.unmount()
  await settle()
})

it('narrows a moved emulator only once its pty has the narrower width', async () => {
  const view = render(<Pane nested={false} />)
  await settle()
  const [term] = fakeTerms
  expect(term!.cols).toBe(100)

  // The split halves the pane: the pty is told first, and the emulator waits for the answer.
  resizes = []
  box.cols = 48
  view.rerender(<Pane nested />)
  await settle()
  expect(call).toHaveBeenCalledWith('terminal.resize', { terminalId: 't1', cols: 48, rows: 30 })
  expect(term!.cols).toBe(100)

  await act(async () => {
    for (const answer of resizes!.splice(0)) answer()
  })
  await settle()
  expect(term!.cols).toBe(48)
  view.unmount()
})

it('replays a pane first drawn after it narrowed at the width its output was written for, then fits', async () => {
  // Born 134 wide, narrowed by later panes before this window drew it.
  box.cols = 48
  runtime.snapshot = { data: '%' + ' '.repeat(133) + '\r \rprompt % ', widest: 134 }
  const view = render(<Pane nested={false} />)
  await settle()

  const [term] = fakeTerms
  expect(term!.widths[term!.writes.indexOf(runtime.snapshot.data)]).toBe(134)
  expect(term!.cols).toBe(48)
  expect(call.mock.calls.filter(([, params]) => (params as { cols?: number }).cols === 134)).toEqual([])
  view.unmount()
})
