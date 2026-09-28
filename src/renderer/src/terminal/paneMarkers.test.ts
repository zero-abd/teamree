/** @vitest-environment jsdom */

import { Terminal as Emulator, type IDecoration, type IDecorationOptions, type IMarker } from '@xterm/xterm'
import { afterEach, describe, expect, it } from 'vitest'
import { markerRows, paneMarkers } from './paneMarkers'

const write = (term: Emulator, data: string): Promise<void> => new Promise((resolve) => term.write(data, resolve))
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 200))
const markerLine = (label: string): string => `\x1b[0m\r\n\x1b[38;5;244m── ${label} ──\x1b[0m\r\n`
const lines = (count: number, word = 'Working…'): string => `${word}\r\n`.repeat(count)

type Drawn = { marker: IMarker; disposed: boolean; render?: (element: HTMLElement) => void }

/** An emulator whose decorations are recorded rather than drawn: nothing here opens a renderer. */
function emulator(rows = 6): { term: Emulator; drawn: Drawn[]; live: () => string[] } {
  const term = new Emulator({ cols: 60, rows, scrollback: 2000, allowProposedApi: true })
  const drawn: Drawn[] = []
  term.registerDecoration = (options: IDecorationOptions): IDecoration => {
    const entry: Drawn = { marker: options.marker, disposed: false }
    drawn.push(entry)
    return {
      marker: options.marker,
      element: undefined,
      options: {},
      isDisposed: false,
      onRender: (render: (element: HTMLElement) => void) => {
        entry.render = render
        return { dispose: () => {} }
      },
      onDispose: () => ({ dispose: () => {} }),
      dispose: () => {
        entry.disposed = true
      }
    } as unknown as IDecoration
  }
  const live = (): string[] =>
    drawn
      .filter((entry) => !entry.disposed && !entry.marker.isDisposed)
      .map((entry) => term.buffer.active.getLine(entry.marker.line)?.translateToString(true) ?? '')
  return { term, drawn, live }
}

const terms: Emulator[] = []
afterEach(() => terms.splice(0).forEach((term) => term.dispose()))

describe('the marker lines in a pane', () => {
  it('are found by line and label, dim colour and all, and nothing else is', async () => {
    const term = new Emulator({ cols: 60, rows: 6, scrollback: 100, allowProposedApi: true })
    terms.push(term)
    await write(
      term,
      'old output\r\n\x1b[0m\r\n\x1b[38;5;244m── Restored · 11:07 ──\x1b[0m\r\n% ls\r\n── not a marker\r\n'
    )
    const buffer = term.buffer.active
    expect(markerRows(buffer, 0, buffer.length)).toEqual([{ line: 2, label: 'Restored · 11:07' }])
    expect(markerRows(buffer, 3, buffer.length)).toEqual([])
  })
})

describe('a pane’s marker rules', () => {
  // A later `New session` marker in the buffer never got a rule.
  it('draws every marker line, however much was written between two looks', async () => {
    const { term, live } = emulator()
    terms.push(term)
    const markers = paneMarkers(term)
    await write(term, `${markerLine('Restored · 04:07')}${lines(400)}`)
    markers.scan()
    await settle()
    await write(term, `${markerLine('New session · 04:14')}${lines(400)}${markerLine('Resumed · 04:20')}${lines(3)}`)
    markers.scan()
    await settle()
    expect(live()).toEqual(['── Restored · 04:07 ──', '── New session · 04:14 ──', '── Resumed · 04:20 ──'])
    markers.dispose()
  })

  it('rides a marker on its line, so it scrolls and reflows with it', async () => {
    const { term, live } = emulator()
    terms.push(term)
    const markers = paneMarkers(term)
    await write(term, `${markerLine('Restored · 04:07')}`)
    markers.scan()
    await settle()
    await write(term, lines(50))
    term.resize(40, 6)
    term.resize(70, 9)
    await write(term, lines(5))
    expect(live()).toEqual(['── Restored · 04:07 ──'])
    markers.dispose()
  })

  // Its line cleared by the program, the rule stayed on screen over whatever was written there next.
  it('lets a rule go when its line no longer says it, and draws none twice', async () => {
    const { term, drawn, live } = emulator()
    terms.push(term)
    const markers = paneMarkers(term)
    await write(term, markerLine('Restored · 04:07'))
    markers.scan()
    await settle()
    await write(term, `\x1b[H\x1b[2J${lines(2, 'Working…')}`)
    markers.scan(true)
    await settle()
    expect(live()).toEqual([])
    expect(drawn.every((entry) => entry.disposed || entry.marker.isDisposed)).toBe(true)

    await write(term, markerLine('New session · 04:14'))
    markers.scan(true)
    markers.scan(true)
    await settle()
    markers.scan(true)
    await settle()
    expect(live()).toEqual(['── New session · 04:14 ──'])
    markers.dispose()
  })

  it('goes with a clear', async () => {
    const { term, live } = emulator()
    terms.push(term)
    const markers = paneMarkers(term)
    await write(term, `${markerLine('Restored · 04:07')}${lines(20)}`)
    markers.scan()
    await settle()
    term.clear()
    expect(live()).toEqual([])
    markers.dispose()
  })

  // xterm hides a decoration off the screen by its `display`; a rule that set its own stayed drawn.
  it('draws the rule inside xterm’s element and leaves that element’s display alone', async () => {
    const { term, drawn } = emulator()
    terms.push(term)
    const markers = paneMarkers(term)
    await write(term, markerLine('Restored · 04:07'))
    markers.scan()
    await settle()
    const element = document.createElement('div')
    element.style.display = 'none'
    drawn[0]?.render?.(element)
    drawn[0]?.render?.(element)
    expect(element.style.display).toBe('none')
    expect(element.classList.contains('pane-marker')).toBe(false)
    expect(element.querySelectorAll('.pane-marker')).toHaveLength(1)
    expect(element.querySelector('.pane-marker')?.textContent).toBe('Restored · 04:07')
    markers.dispose()
  })
})
