import { Terminal as Emulator } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'
import { markerRows } from './paneMarkers'

const write = (term: Emulator, data: string): Promise<void> => new Promise((resolve) => term.write(data, resolve))

describe('the marker lines in a pane', () => {
  it('are found by line and label, dim colour and all, and nothing else is', async () => {
    const term = new Emulator({ cols: 60, rows: 6, scrollback: 100, allowProposedApi: true })
    await write(
      term,
      'old output\r\n\x1b[0m\r\n\x1b[38;5;244m── Restored · 11:07 ──\x1b[0m\r\n% ls\r\n── not a marker\r\n'
    )
    const buffer = term.buffer.active
    expect(markerRows(buffer, 0, buffer.length)).toEqual([{ line: 2, label: 'Restored · 11:07' }])
    expect(markerRows(buffer, 3, buffer.length)).toEqual([])
    term.dispose()
  })
})
