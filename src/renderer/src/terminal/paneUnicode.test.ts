/** @vitest-environment jsdom */

import { expect, it } from 'vitest'
import { Terminal as XTerm } from '@xterm/xterm'
import { wideEmoji } from './paneUnicode'

async function columnAfter(text: string): Promise<number> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 4 })
  term.open(host)
  wideEmoji(term)
  expect(term.unicode.activeVersion).toBe('11')
  await new Promise<void>((resolve) => term.write(text, resolve))
  const column = term.buffer.active.cursorX
  term.dispose()
  host.remove()
  return column
}

it.each([
  ['🚀', 2],
  ['✅', 2],
  ['⏺', 1],
  ['日本', 4],
  ['🇯🇵', 2]
])('%s takes %i cells', async (text, cells) => {
  expect(await columnAfter(text)).toBe(cells)
})

// The audit's line: text after the emoji lands where a program counting Unicode 11 widths put its cursor.
it('keeps the text after an emoji run in its column', async () => {
  expect(await columnAfter('🚀✅👩‍💻🇯🇵|')).toBe(11)
})
