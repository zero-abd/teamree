/** @vitest-environment jsdom */

// The window onto somebody else's machine: a keystroke that went nowhere says so, the picture is the
// owner's size (resizing the slot moves only the scale), gaps are admitted, and an ended watch stays
// ended. xterm is replaced by a recorder of which bytes the view put in the pane.

import { act, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WatchedPaneEvent } from '@shared/methods'
import { DEFAULT_APPEARANCE, resolvePalette } from '@shared/theme'

/** The escape a terminal's own replies begin with, spelled rather than pasted. */
const ESC = '\u001b'

/** What the fake emulator reports as its rendered size, for the letterbox. */
const picture = { width: 800, height: 600 }

type FakeTerm = {
  options: Record<string, unknown>
  element: HTMLElement | null
  writes: string[]
  data: ((data: string) => void) | null
  disposed: boolean
  resized: number
  focused: boolean
  /** What the view told the emulator to decline, so the app can have it. */
  keyHandler: ((event: KeyboardEvent) => boolean) | null
}

const terms = vi.hoisted(() => [] as unknown[])
const fakeTerms = terms as FakeTerm[]

vi.mock('@xterm/xterm', () => {
  class Terminal {
    options: Record<string, unknown>
    element: HTMLElement | null = null
    writes: string[] = []
    data: ((data: string) => void) | null = null
    disposed = false
    resized = 0
    focused = false
    keyHandler: ((event: KeyboardEvent) => boolean) | null = null

    constructor(options: Record<string, unknown>) {
      this.options = options
      terms.push(this)
    }

    open(host: HTMLElement): void {
      const element = document.createElement('div')
      // jsdom has no layout; the letterbox's one measurement is supplied.
      Object.defineProperty(element, 'offsetWidth', { get: () => picture.width })
      Object.defineProperty(element, 'offsetHeight', { get: () => picture.height })
      host.appendChild(element)
      this.element = element
    }

    onData(handler: (data: string) => void): void {
      this.data = handler
    }

    write(text: string): void {
      this.writes.push(text)
    }

    resize(): void {
      this.resized += 1
    }

    focus(): void {
      this.focused = true
    }

    blur(): void {
      this.focused = false
    }

    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
      this.keyHandler = handler
    }

    loadAddon(): void {}

    dispose(): void {
      this.disposed = true
    }
  }
  return { Terminal }
})

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss(): void {}
    dispose(): void {}
  }
}))

/** The slot's observers; jsdom never fires them, so the drag test calls the callback itself. */
const observers: (() => void)[] = []

class RecordingResizeObserver implements ResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    observers.push(() => callback([], this))
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver = RecordingResizeObserver

const call = vi.fn<(method: string, params: unknown) => Promise<unknown>>()
const watchPane = vi.fn()

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: {
    call: (method: string, params: unknown) => call(method, params),
    watchPane: (projectId: string, paneId: string, onEvent: (event: WatchedPaneEvent) => void) =>
      watchPane(projectId, paneId, onEvent)
  },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { applyPalette } = await import('../theme/applyPalette')
const { WatchedPaneView } = await import('./WatchedPaneView')

/** One in-flight watch: the callback the view registered, and its answer. */
type Opened = {
  emit: (event: WatchedPaneEvent) => void
  resolve: (handle?: { cols?: number; rows?: number }) => Promise<void>
  reject: (error: unknown) => Promise<void>
  closed: () => number
}

function armWatch(): Opened {
  let settle!: (value: unknown) => void
  let fail!: (error: unknown) => void
  let emit: (event: WatchedPaneEvent) => void = () => {}
  let closes = 0

  watchPane.mockImplementation((_projectId: string, _paneId: string, onEvent: (event: WatchedPaneEvent) => void) => {
    emit = onEvent
    return new Promise((resolveOuter, rejectOuter) => {
      settle = resolveOuter
      fail = rejectOuter
    })
  })

  return {
    emit: (event) => act(() => emit(event)),
    resolve: (handle = {}) =>
      act(async () => {
        settle({
          subscription: {
            close: () => {
              closes += 1
            }
          },
          cols: handle.cols ?? 100,
          rows: handle.rows ?? 30,
          handle: 'priya'
        })
      }),
    reject: (error) =>
      act(async () => {
        fail(error)
      }),
    closed: () => closes
  }
}

function mount(overrides: Partial<Parameters<typeof WatchedPaneView>[0]> = {}): {
  onClose: ReturnType<typeof vi.fn>
  onFocus: ReturnType<typeof vi.fn>
  onOutput: ReturnType<typeof vi.fn>
  rerender: (next: Partial<Parameters<typeof WatchedPaneView>[0]>) => void
  unmount: () => void
} {
  const onClose = vi.fn()
  const onFocus = vi.fn()
  const onOutput = vi.fn()
  const view = (extra: Partial<Parameters<typeof WatchedPaneView>[0]>): React.JSX.Element => (
    <WatchedPaneView
      projectId="p1"
      paneId="priya:t7"
      label="agent"
      handle="priya"
      focused={false}
      onFocus={onFocus}
      isAppChord={() => false}
      onClose={onClose}
      onOutput={onOutput}
      {...overrides}
      {...extra}
    />
  )
  const { rerender, unmount } = render(view({}))
  return { onClose, onFocus, onOutput, rerender: (next) => rerender(view(next)), unmount }
}

/** One keystroke as the browser delivers it: the DOM event, then xterm's bytes. `emits` is the no-person case. */
function press(data: string): void {
  emits(data, { user: true })
}

/** Bytes leaving the emulator, with or without a person behind them. */
function emits(data: string, { user }: { user: boolean }): void {
  const term = fakeTerms.at(-1)
  if (user) term?.element?.dispatchEvent(new KeyboardEvent('keydown', { key: data, bubbles: true }))
  term?.data?.(data)
}

/** Everything the view has put into the pane, as one string. */
const paneText = (): string => (fakeTerms.at(-1)?.writes ?? []).join('')

const pane = (): HTMLElement => screen.getByRole('region', { name: /priya/ })

beforeEach(() => {
  observers.length = 0
  fakeTerms.length = 0
  call.mockReset()
  call.mockResolvedValue(undefined)
  watchPane.mockReset()
  picture.width = 800
  picture.height = 600
})

afterEach(() => {
  vi.useRealTimers()
})

describe('whose pane this is', () => {
  it('names the owner, the pane and what typing here means, before anything has opened', () => {
    armWatch()
    mount()
    expect(screen.getByRole('region', { name: 'priya’s pane agent, which you can type into' })).toBeTruthy()
    expect(within(pane()).getByText('priya')).toBeTruthy()
    expect(screen.getByText('Opening priya’s pane…')).toBeTruthy()
  })

  // A standing sentence: the person typing must know whose machine it runs on.
  it('says whose machine a keystroke runs on, at all times and in words', async () => {
    const watch = armWatch()
    mount()
    // Including "once they allow it".
    const promise = 'what you type runs on priya’s machine, as priya, once they allow it, with your name on it'
    expect(screen.getByText(promise)).toBeTruthy()
    await watch.resolve()
    expect(screen.getByText(promise)).toBeTruthy()
  })
})

describe('the size is the owner’s', () => {
  it('builds the emulator at their columns and rows and shows them', async () => {
    const watch = armWatch()
    mount()
    await watch.resolve({ cols: 132, rows: 43 })
    expect(fakeTerms).toHaveLength(1)
    expect(fakeTerms[0]?.options.cols).toBe(132)
    expect(fakeTerms[0]?.options.rows).toBe(43)
    expect(screen.getByText('132×43')).toBeTruthy()
  })

  it('never resizes the far pty, and never asks to', async () => {
    const watch = armWatch()
    mount()
    await watch.resolve()
    press('ls\r')
    expect(fakeTerms[0]?.resized).toBe(0)
    for (const [method] of call.mock.calls) expect(method).not.toMatch(/resize/)
  })

  it('scales the whole picture down to fit a smaller window', async () => {
    const watch = armWatch()
    picture.width = 800
    picture.height = 600
    mount()
    const frame = document.querySelector('.watch__frame') as HTMLElement
    Object.defineProperty(frame, 'clientWidth', { get: () => 400 })
    Object.defineProperty(frame, 'clientHeight', { get: () => 600 })
    await watch.resolve()
    expect(fakeTerms[0]?.element?.style.transform).toBe('scale(0.5)')
  })

  // Scaling an 80-column pane up would show something other than what the owner sees.
  it('never scales it up, however much room there is', async () => {
    const watch = armWatch()
    mount()
    const frame = document.querySelector('.watch__frame') as HTMLElement
    Object.defineProperty(frame, 'clientWidth', { get: () => 4000 })
    Object.defineProperty(frame, 'clientHeight', { get: () => 3000 })
    await watch.resolve()
    expect(fakeTerms[0]?.element?.style.transform).toBe('scale(1)')
  })
})

/** The element the picture is letterboxed into, with a size jsdom cannot give it. */
function frameOf(width: number, height: number): HTMLElement {
  const frame = document.querySelector('.watch__frame') as HTMLElement
  Object.defineProperty(frame, 'clientWidth', { configurable: true, get: () => width })
  Object.defineProperty(frame, 'clientHeight', { configurable: true, get: () => height })
  return frame
}

// Dragging the slot's edge must never reach the far end.
describe('a slot in the window, like any other pane', () => {
  it('is a pane, with the accent that says it is not one of yours', async () => {
    const watch = armWatch()
    mount()
    await watch.resolve()
    expect(pane().classList.contains('pane')).toBe(true)
    expect(pane().classList.contains('pane--watched')).toBe(true)
    expect(pane().classList.contains('pane--focused')).toBe(false)
  })

  it('wears the focused border, and takes the keyboard, when the window says it has the focus', async () => {
    const watch = armWatch()
    const { rerender } = mount()
    await watch.resolve()
    expect(fakeTerms[0]?.focused).toBe(false)
    act(() => rerender({ focused: true }))
    expect(pane().classList.contains('pane--focused')).toBe(true)
    expect(fakeTerms[0]?.focused).toBe(true)
    act(() => rerender({ focused: false }))
    expect(fakeTerms[0]?.focused).toBe(false)
  })

  // Focused from its first frame; the emulator exists only a tick later.
  it('takes the keyboard when it was focused before there was an emulator', async () => {
    const watch = armWatch()
    mount({ focused: true })
    await watch.resolve()
    expect(fakeTerms[0]?.focused).toBe(true)
  })

  it('asks for the focus when somebody presses it, the way a pane does', async () => {
    const watch = armWatch()
    const { onFocus } = mount()
    await watch.resolve()
    act(() => {
      pane().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(onFocus).toHaveBeenCalled()
  })

  it('declines the app’s own chords rather than sending them to the owner', async () => {
    const watch = armWatch()
    mount({ isAppChord: (event: KeyboardEvent) => event.key === 'w' })
    await watch.resolve()
    const handler = fakeTerms[0]?.keyHandler
    expect(handler?.(new KeyboardEvent('keydown', { key: 'w' }))).toBe(false)
    expect(handler?.(new KeyboardEvent('keydown', { key: 'a' }))).toBe(true)
  })

  // The slot is this window's, the geometry theirs, joined by a CSS transform only.
  it('rescales when its slot is dragged narrower, and never renegotiates their size', async () => {
    const watch = armWatch()
    picture.width = 800
    picture.height = 600
    mount()
    frameOf(800, 600)
    await watch.resolve({ cols: 100, rows: 30 })
    expect(fakeTerms[0]?.element?.style.transform).toBe('scale(1)')

    frameOf(400, 600)
    act(() => {
      for (const fire of observers) fire()
    })
    expect(fakeTerms[0]?.element?.style.transform).toBe('scale(0.5)')
    expect(fakeTerms[0]?.resized).toBe(0)
    expect(screen.getByText('100×30')).toBeTruthy()
    for (const [method] of call.mock.calls) expect(method).not.toMatch(/resize/)
  })
})

describe('typing is a request', () => {
  it('sends each keystroke to the owner’s machine, named by pane', async () => {
    const watch = armWatch()
    mount()
    await watch.resolve()
    await act(async () => {
      press('l')
      press('s')
    })
    expect(call.mock.calls).toEqual([
      ['teamwork.type', { projectId: 'p1', paneId: 'priya:t7', data: 'l' }],
      ['teamwork.type', { projectId: 'p1', paneId: 'priya:t7', data: 's' }]
    ])
  })

  // Emulator replies arrive on the same `onData` as keystrokes; sent, they would type into the owner's
  // pty under this reader's name. `handsHere` is the distinction.
  it('never sends bytes nobody in this window produced', async () => {
    const watch = armWatch()
    mount()
    await watch.resolve()
    await act(async () => {
      emits('[1;1R', { user: false })
      emits('[?1;2c', { user: false })
    })
    expect(call).not.toHaveBeenCalled()
    // No keystroke, so nothing to report.
    expect(paneText()).not.toContain('not typed')
    expect(screen.getByText(/what you type runs on/)).toBeTruthy()
  })

  // A mark on the action, not a byte filter: a reply and a keystroke can be the same string.
  it('sends the same bytes when a person did produce them', async () => {
    const watch = armWatch()
    mount()
    await watch.resolve()
    await act(async () => {
      press('[1;1R')
    })
    expect(call).toHaveBeenCalledWith('teamwork.type', {
      projectId: 'p1',
      paneId: 'priya:t7',
      data: '[1;1R'
    })
  })

  // One microtask, or every later reply would ride out on a past keystroke's mark.
  it('does not let one keystroke license the replies that follow it', async () => {
    const watch = armWatch()
    mount()
    await watch.resolve()
    await act(async () => {
      press('a')
    })
    call.mockClear()
    await act(async () => {
      emits(`${ESC}[1;1R`, { user: false })
    })
    expect(call).not.toHaveBeenCalled()
  })

  it('prints a refusal where the keystroke would have appeared, and says so on the header', async () => {
    const watch = armWatch()
    mount()
    await watch.resolve()
    call.mockRejectedValue(new Error('this pane is muted'))
    await act(async () => {
      press('x')
    })
    expect(paneText()).toContain('[not typed: this pane is muted]')
    expect(screen.getByText('this pane is muted')).toBeTruthy()
    expect(screen.queryByText(/what you type runs on/)).toBeNull()
  })

  it('says one refusal once for a held key, rather than once per key', async () => {
    const watch = armWatch()
    mount()
    await watch.resolve()
    call.mockRejectedValue(new Error('this pane is muted'))
    await act(async () => {
      for (const key of 'aaaaa') press(key)
    })
    expect(paneText().match(/not typed: this pane is muted/g)).toHaveLength(1)
  })

  it('always prints a different refusal, because it is a different fact', async () => {
    const watch = armWatch()
    mount()
    await watch.resolve()
    call.mockRejectedValueOnce(new Error('this pane is muted'))
    call.mockRejectedValueOnce(new Error('their process has exited'))
    await act(async () => {
      press('a')
    })
    await act(async () => {
      press('b')
    })
    expect(paneText()).toContain('[not typed: this pane is muted]')
    expect(paneText()).toContain('[not typed: their process has exited]')
  })

  it('repeats the same refusal once the pane has been quiet, so it is never stale', async () => {
    const watch = armWatch()
    mount()
    await watch.resolve()
    call.mockRejectedValue(new Error('this pane is muted'))
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    await act(async () => {
      press('a')
    })
    vi.setSystemTime(1_000 + 4_000)
    await act(async () => {
      press('a')
    })
    expect(paneText().match(/not typed: this pane is muted/g)).toHaveLength(2)
  })

  // An unanswered keystroke has not run; the pane says so.
  it('says nothing has run while the owner’s machine has not answered', async () => {
    const watch = armWatch()
    mount()
    await watch.resolve()
    vi.useFakeTimers()
    // Never resolved: the pane must say so on its own. The next test does answer.
    call.mockImplementation(() => new Promise<undefined>(() => {}))

    await act(async () => {
      for (const key of 'npm test') press(key)
    })
    expect(paneText()).not.toContain('waiting')

    await act(async () => {
      vi.advanceTimersByTime(1_100)
    })
    expect(paneText()).toContain('[waiting: nothing you have typed has run')
    expect(screen.getByText('waiting for priya’s machine — nothing you have typed has run')).toBeTruthy()

    // Once per burst, not per key.
    expect(paneText().match(/waiting: nothing you have typed has run/g)).toHaveLength(1)
  })

  it('says when the waiting ended, because an allowed keystroke may echo nothing', async () => {
    const watch = armWatch()
    mount()
    await watch.resolve()
    vi.useFakeTimers()
    let allow: (() => void) | undefined
    call.mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          allow = () => resolve(undefined)
        })
    )
    await act(async () => {
      press('x')
    })
    await act(async () => {
      vi.advanceTimersByTime(1_100)
    })
    expect(paneText()).toContain('[waiting: nothing you have typed has run')

    await act(async () => {
      allow?.()
    })
    // A password prompt echoes nothing, so allowed and ignored would look alike.
    expect(paneText()).toContain('[no longer held: what you typed has run]')
    expect(screen.getByText(/what you type runs on priya’s machine/)).toBeTruthy()
  })

  it('stops saying typing is refused the moment one is accepted', async () => {
    const watch = armWatch()
    mount()
    await watch.resolve()
    call.mockRejectedValueOnce(new Error('this pane is muted'))
    await act(async () => {
      press('a')
    })
    expect(screen.getByText('this pane is muted')).toBeTruthy()
    call.mockResolvedValue(undefined)
    await act(async () => {
      press('b')
    })
    expect(screen.queryByText('this pane is muted')).toBeNull()
    expect(screen.getByText(/what you type runs on priya’s machine/)).toBeTruthy()
  })
})

describe('the stream is honest about its own gaps', () => {
  it('writes a teammate’s output into the pane and passes it on to be quoted', async () => {
    const watch = armWatch()
    const { onOutput } = mount()
    await watch.resolve()
    watch.emit({ type: 'data', data: 'building…\r\n' })
    expect(paneText()).toContain('building…')
    expect(onOutput).toHaveBeenCalledWith('building…\r\n')
  })

  // Quoting teamree's own notice as the teammate's output would invent output.
  it('does not pass its own notices off as the teammate’s output', async () => {
    const watch = armWatch()
    const { onOutput } = mount()
    await watch.resolve()
    watch.emit({ type: 'elided', bytes: 4096 })
    watch.emit({ type: 'exit', exitCode: 1 })
    expect(onOutput).not.toHaveBeenCalled()
  })

  it('admits a hole in the stream at the point of the hole', async () => {
    const watch = armWatch()
    mount()
    await watch.resolve()
    watch.emit({ type: 'data', data: 'before' })
    watch.emit({ type: 'elided', bytes: 4096 })
    watch.emit({ type: 'data', data: 'after' })
    const shown = paneText()
    expect(shown).toContain('4096 bytes skipped: this pane is outrunning the relay')
    expect(shown.indexOf('before')).toBeLessThan(shown.indexOf('skipped'))
    expect(shown.indexOf('skipped')).toBeLessThan(shown.indexOf('after'))
  })

  it('says when their process exited, with the code', async () => {
    const watch = armWatch()
    mount()
    await watch.resolve()
    watch.emit({ type: 'exit', exitCode: 137 })
    expect(paneText()).toContain('[their process exited with code 137]')
  })
})

describe('a watch that ends', () => {
  it('says why, in the pane and on the header, rather than simply stopping', async () => {
    const watch = armWatch()
    mount()
    await watch.resolve()
    watch.emit({ type: 'lost', reason: 'priya’s machine stopped answering' })
    expect(paneText()).toContain('[stopped watching: priya’s machine stopped answering]')
    expect(screen.getByText('priya’s machine stopped answering')).toBeTruthy()
  })

  // The loss can arrive while the header says "Opening…"; the continuation must not overwrite it.
  it('stays ended when the loss beat the stream being answered', async () => {
    const watch = armWatch()
    mount()
    watch.emit({ type: 'lost', reason: 'the relay dropped the link' })
    await watch.resolve({ cols: 132, rows: 43 })
    expect(screen.getByText('the relay dropped the link')).toBeTruthy()
    expect(screen.queryByText('132×43')).toBeNull()
    expect(screen.queryByText('Opening priya’s pane…')).toBeNull()
  })

  it('reports a watch that never opened, in the runtime’s own words', async () => {
    const watch = armWatch()
    mount()
    await watch.reject(new Error('priya is not connected'))
    expect(screen.getByText('priya is not connected')).toBeTruthy()
    expect(fakeTerms).toHaveLength(0)
  })

  it('reports a non-Error refusal rather than rendering "[object Object]"', async () => {
    const watch = armWatch()
    mount()
    await watch.reject('no such pane')
    expect(screen.getByText('no such pane')).toBeTruthy()
  })
})

describe('closing', () => {
  it('hands the decision back rather than unmounting itself', async () => {
    const watch = armWatch()
    const { onClose } = mount()
    await watch.resolve()
    screen.getByRole('button', { name: 'Stop watching priya’s pane agent' }).click()
    expect(onClose).toHaveBeenCalledOnce()
  })

  // Unmounting must close the subscription, or the owner keeps streaming.
  it('stops the bytes and disposes the emulator on unmount', async () => {
    const watch = armWatch()
    const { unmount } = mount()
    await watch.resolve()
    expect(watch.closed()).toBe(0)
    act(() => unmount())
    expect(watch.closed()).toBe(1)
    expect(fakeTerms[0]?.disposed).toBe(true)
  })

  it('stops the bytes even when the stream opened after the viewer was gone', async () => {
    const watch = armWatch()
    const { unmount } = mount()
    act(() => unmount())
    await watch.resolve()
    expect(watch.closed()).toBe(1)
    expect(fakeTerms).toHaveLength(0)
  })
})

// A watched pane repaints when the palette changes, like a local one; reopening it would pay for the watch twice.
describe('the palette, after it changes under a running watch', () => {
  it('repaints the emulator rather than leaving it in the theme it opened in', async () => {
    const watch = armWatch()
    mount()
    await watch.resolve()
    const term = fakeTerms.at(-1) as FakeTerm
    const before = (term.options.theme as { background: string }).background

    const midnight = { ...DEFAULT_APPEARANCE, themeId: 'midnight' }
    act(() => {
      // What `App` does on an appearance change: resolve onto the root; panes read it back.
      applyPalette(document.documentElement, resolvePalette(midnight))
      useWorkspaceStore.setState({ appearance: midnight })
    })

    const after = (term.options.theme as { background: string }).background
    expect(after).not.toBe(before)
    expect(after).toBe(resolvePalette(midnight)['term-bg'])
  })
  it('repaints when the Mac switches to light under Match System', async () => {
    const watch = armWatch()
    mount()
    await watch.resolve()
    const term = fakeTerms.at(-1) as FakeTerm

    act(() => {
      applyPalette(document.documentElement, resolvePalette(DEFAULT_APPEARANCE, 'light'))
      useWorkspaceStore.setState({ systemTone: 'light' })
    })

    expect((term.options.theme as { background: string }).background).toBe(
      resolvePalette(DEFAULT_APPEARANCE, 'light')['term-bg']
    )
  })
})
