// Takes a pasted image out of Claude Code's unsent prompt: the keys a person would press to delete
// its placeholder, the caret checked after each. See docs/plans/pasted-image-preview.md.

import type { IBufferCell, Terminal as XTerm } from '@xterm/xterm'
import { inputBox, promptImageIndices, screenOf } from './promptImages'

type Term = Pick<XTerm, 'buffer' | 'rows' | 'modes' | 'onWriteParsed'>

export type PromptPane = {
  term: Term
  send: (data: string) => void
  /** True unless the agent sits idle at its prompt. */
  busy: () => boolean
  /** When a person last typed into the pane, here or as a teammate. */
  typedAt: () => number
  now?: () => number
}

/** Why an image stayed in the prompt. */
export type NotRemoved = 'busy' | 'typing' | 'hidden' | 'failed'

type Cell = { row: number; col: number }

/** One image's placeholder in a fully shown input, and the caret, in screen cells. */
export type PromptSpot = { caret: Cell; start: Cell; end: Cell; text: string; firstCol: (row: number) => number }

/** How long a redraw is waited on: quiet for `quietMs` after output, or `maxMs` without any. */
export type Settle = { quietMs: number; maxMs: number }

export const SETTLE: Settle = { quietMs: 30, maxMs: 600 }
const TYPED_WITHIN_MS = 1_000
const BACKSPACE = '\x7f'

/** Where the image's placeholder and the caret are; null unless the whole input is on screen and holds it once. */
export function readPrompt(term: Term, index: number): PromptSpot | null {
  const buffer = term.buffer.active
  const rows: string[] = []
  const cols: number[][] = []
  let cell: IBufferCell | undefined
  for (let row = buffer.baseY; row < buffer.baseY + term.rows; row++) {
    const line = buffer.getLine(row)
    let text = ''
    const at: number[] = []
    for (let x = 0; line !== undefined && x < line.length; x++) {
      cell = line.getCell(x, cell)
      if (cell === undefined || cell.getWidth() === 0) continue
      const chars = cell.getChars() || ' '
      text += chars
      for (const _ of chars) at.push(x)
    }
    const kept = text.trimEnd()
    rows.push(kept)
    cols.push(at.slice(0, kept.length))
  }
  const box = inputBox(rows)
  const caret = { row: buffer.cursorY, col: buffer.cursorX }
  if (box === null || caret.row <= box.top || caret.row >= box.bottom) return null
  // A full-screen input taller than this scrolls with the caret, silently.
  const shown = box.bottom - box.top - 1
  if (buffer.type === 'alternate' && shown >= Math.max(3, Math.floor(term.rows / 2) - 5)) return null

  let joined = ''
  const cells: (Cell | null)[] = []
  for (let row = box.top + 1; row < box.bottom; row++) {
    if (row > box.top + 1) {
      joined += ' '
      cells.push(null)
    }
    const from = textStart(rows[row]!)
    joined += rows[row]!.slice(from)
    for (const col of cols[row]!.slice(from)) cells.push({ row, col })
  }
  const token = `[Image #${index}]`
  const first = joined.indexOf(token)
  if (first < 0 || joined.includes(token, first + 1)) return null
  const firstCol = (row: number): number => cols[row]?.[textStart(rows[row] ?? '')] ?? Infinity
  return { caret, start: cells[first]!, end: cells[first + token.length - 1]!, text: joined, firstCol }
}

/** Where a row of the input starts: past the prompt mark, or the indent of a wrapped row. */
function textStart(row: string): number {
  return Math.max(0, row.search(/[^\s│❯>]/u))
}

/** Deletes image `index`'s placeholder, which Claude Code drops the image with. Null when it went. */
export async function removePromptImage(
  pane: PromptPane,
  index: number,
  settle: Settle = SETTLE
): Promise<NotRemoved | null> {
  const now = pane.now ?? Date.now
  const since = pane.typedAt()
  const typing = (): boolean => pane.typedAt() !== since || now() - pane.typedAt() < TYPED_WITHIN_MS
  if (pane.busy()) return 'busy'
  if (typing()) return 'typing'
  const before = readPrompt(pane.term, index)
  if (before === null) return 'hidden'
  const token = `[Image #${index}]`

  const key = (final: 'C' | 'D'): string => (pane.term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + final
  const press = async (data: string): Promise<PromptSpot | null> => {
    await sendAndSettle(pane, data, settle)
    return readPrompt(pane.term, index)
  }

  // Only ← and →: ↑ and ↓ leave the input for history at its first and last rows.
  let spot = before
  for (let steps = 0; order(spot.caret, spot.start) !== 0; steps++) {
    if (steps > before.text.length + 2) return 'failed'
    if (typing()) return 'typing'
    const next = await press(key(order(spot.caret, spot.start) < 0 ? 'C' : 'D'))
    if (next === null) return 'hidden'
    if (order(next.caret, spot.caret) === 0) return 'failed'
    spot = next
  }

  // One → from its `[` has to land past its `]`: proof the placeholder is a single caret stop.
  const past = await press(key('C'))
  if (past === null) return 'hidden'
  const end = spot.end
  const jumped =
    (past.caret.row === end.row && past.caret.col === end.col + 1) ||
    (past.caret.row === end.row + 1 && past.caret.col <= past.firstCol(past.caret.row))
  if (!jumped) {
    await press(key('D'))
    return 'failed'
  }
  if (typing()) return 'typing'

  await sendAndSettle(pane, BACKSPACE, settle)
  const rows = screenOf(pane.term)
  const box = inputBox(rows)
  const indices = promptImageIndices(rows)
  if (box === null || indices === null || indices.includes(index)) return 'failed'
  // Nothing but the placeholder may have gone; wrapping can move the spaces.
  const squeeze = (text: string): string => text.replace(/\s/gu, '')
  const input = rows.slice(box.top + 1, box.bottom).map((row) => row.slice(textStart(row)))
  return squeeze(input.join('')) === squeeze(before.text).replace(squeeze(token), '') ? null : 'failed'
}

function order(a: Cell, b: Cell): number {
  return a.row - b.row || a.col - b.col
}

/** Sends `data` and resolves once the program's answer to it has been drawn. */
export function sendAndSettle(
  pane: Pick<PromptPane, 'term' | 'send'>,
  data: string,
  { quietMs, maxMs }: Settle
): Promise<void> {
  return new Promise((resolve) => {
    let quiet: ReturnType<typeof setTimeout> | undefined
    const done = (): void => {
      clearTimeout(quiet)
      clearTimeout(cap)
      parsed.dispose()
      resolve()
    }
    const cap = setTimeout(done, maxMs)
    const parsed = pane.term.onWriteParsed(() => {
      clearTimeout(quiet)
      quiet = setTimeout(done, quietMs)
    })
    pane.send(data)
  })
}
