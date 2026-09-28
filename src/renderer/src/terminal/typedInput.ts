// What was typed at the prompt, read off the screen, so ⌘A can select just that and a key can clear it.
// A shell marks where its prompt ends (OSC 133;B, see `shell-integration.ts`); an agent draws an input box.

import type { IBufferCell, IBufferLine, IMarker, Terminal as XTerm } from '@xterm/xterm'
import { SETTLE, sendAndSettle, type Settle } from './promptEdit'
import { inputBox, screenOf } from './promptImages'

/** A cell; `row` is the buffer line, not the screen row. */
type Cell = { col: number; row: number }

/** The typed input: its first and last cells, the caret, and the text. */
export type TypedInput = { start: Cell; end: Cell; caret: Cell; text: string }

type Glyph = Cell & { chars: string; width: number; faint: boolean }

type Screen = Pick<XTerm, 'buffer' | 'rows'>

/** Where the last prompt ended; null once its line has left the buffer. */
export type PromptEnd = { line: number; col: number }

export function promptEnds(term: Pick<XTerm, 'parser' | 'registerMarker' | 'buffer'>): {
  last: () => PromptEnd | null
  dispose: () => void
} {
  let marker: IMarker | undefined
  let col = 0
  const handler = term.parser.registerOscHandler(133, (data) => {
    if (data !== 'B' && !data.startsWith('B;')) return false
    if (term.buffer.active.type !== 'normal') return true
    marker?.dispose()
    marker = term.registerMarker(0)
    col = term.buffer.active.cursorX
    return true
  })
  return {
    last: () => (marker === undefined || marker.isDisposed ? null : { line: marker.line, col }),
    dispose: () => {
      handler.dispose()
      marker?.dispose()
    }
  }
}

/** The input at the prompt the caret is in; null when there is none or it cannot be told from the rest. */
export function findTypedInput(term: Screen, prompt: PromptEnd | null): TypedInput | null {
  return shellInput(term, prompt) ?? boxInput(term) ?? blockInput(term)
}

/** A shell's line: from its prompt's end to the last typed cell, the caret on that same line. */
function shellInput(term: Screen, prompt: PromptEnd | null): TypedInput | null {
  const buffer = term.buffer.active
  if (prompt === null || buffer.type !== 'normal') return null
  const caret = { col: buffer.cursorX, row: buffer.baseY + buffer.cursorY }
  let last = prompt.line
  while (buffer.getLine(last + 1)?.isWrapped) last++
  if (caret.row < prompt.line || caret.row > last || (caret.row === prompt.line && caret.col < prompt.col)) {
    return null
  }
  const glyphs: Glyph[] = []
  for (let row = prompt.line; row <= last; row++) {
    const line = buffer.getLine(row)
    if (line !== undefined) glyphs.push(...glyphsOf(line, row, row === prompt.line ? prompt.col : 0))
  }
  const at = glyphs.findIndex((glyph) => order(glyph, caret) >= 0)
  const split = at < 0 ? glyphs.length : at
  let stop = -1
  for (let index = 0; index < split; index++) if (!blank(glyphs[index]!)) stop = index
  // Past the caret: a right prompt sits beyond a gap, an autosuggestion is faint.
  let blanks = 0
  for (let index = split; index < glyphs.length; index++) {
    const glyph = glyphs[index]!
    if (blank(glyph)) {
      if (++blanks >= 2) break
      continue
    }
    if (glyph.faint) break
    blanks = 0
    stop = index
  }
  return stop < 0 ? null : typed([glyphs.slice(0, stop + 1)], caret)
}

const PROMPT_GLYPHS = new Set(['❯', '>', '›'])

/** Claude Code's input, and any box like it: between two rules, the first row led by `❯` or `>`. */
function boxInput(term: Screen): TypedInput | null {
  const buffer = term.buffer.active
  const box = inputBox(screenOf(term))
  if (box === null || buffer.cursorY <= box.top || buffer.cursorY >= box.bottom) return null
  return rowsInput(term, box.top + 1, box.bottom - 1)
}

/** Codex's composer: a tinted block led by `›`, the caret inside it. */
function blockInput(term: Screen): TypedInput | null {
  const buffer = term.buffer.active
  const tint = (y: number): string | null => {
    const cell = buffer.getLine(buffer.baseY + y)?.getCell(0)
    return cell === undefined || cell.isBgDefault() ? null : `${cell.getBgColorMode()}:${cell.getBgColor()}`
  }
  const led = (y: number): boolean => {
    const line = buffer.getLine(buffer.baseY + y)
    const glyphs = line === undefined ? [] : glyphsOf(line, 0).slice(0, 3)
    const at = glyphs.findIndex((glyph) => !blank(glyph))
    return at >= 0 && at <= 1 && glyphs[at]!.chars === '›' && glyphs[at + 1] !== undefined && blank(glyphs[at + 1]!)
  }
  const shade = tint(buffer.cursorY)
  if (shade === null) return null
  let top = buffer.cursorY
  while (top >= 0 && tint(top) === shade && !led(top)) top--
  if (top < 0 || tint(top) !== shade) return null
  let bottom = buffer.cursorY
  while (bottom + 1 < term.rows && tint(bottom + 1) === shade) bottom++
  return rowsInput(term, top, bottom)
}

/** The typed cells of screen rows `top`..`bottom`: past a border, the prompt glyph and indent; not a faint placeholder. */
function rowsInput(term: Screen, top: number, bottom: number): TypedInput | null {
  const buffer = term.buffer.active
  const rows: Glyph[][] = []
  for (let y = top; y <= bottom; y++) {
    const line = buffer.getLine(buffer.baseY + y)
    const glyphs = line === undefined ? [] : glyphsOf(line, buffer.baseY + y)
    let from = 0
    const lead = (): void => {
      while (from < glyphs.length && (blank(glyphs[from]!) || glyphs[from]!.chars === '│')) from++
    }
    lead()
    if (y === top && PROMPT_GLYPHS.has(glyphs[from]?.chars ?? '')) {
      from++
      lead()
    }
    let to = glyphs.length - 1
    while (to >= from && (blank(glyphs[to]!) || glyphs[to]!.faint || glyphs[to]!.chars === '│')) to--
    rows.push(glyphs.slice(from, to + 1))
  }
  return typed(rows, { col: buffer.cursorX, row: buffer.baseY + buffer.cursorY })
}

function typed(rows: Glyph[][], caret: Cell): TypedInput | null {
  const first = rows.findIndex((row) => row.length > 0)
  if (first < 0) return null
  let last = rows.length - 1
  while (rows[last]!.length === 0) last--
  const kept = rows.slice(first, last + 1)
  const start = kept[0]![0]!
  const end = kept.at(-1)!.at(-1)!
  return {
    start: { col: start.col, row: start.row },
    // The last cell a wide character covers, so a selection takes all of it.
    end: { col: end.col + end.width - 1, row: end.row },
    caret,
    text: kept.map((row) => row.map((glyph) => glyph.chars).join('')).join('\n')
  }
}

function glyphsOf(line: IBufferLine, row: number, from = 0): Glyph[] {
  const glyphs: Glyph[] = []
  let cell: IBufferCell | undefined
  for (let col = from; col < line.length; col++) {
    cell = line.getCell(col, cell)
    if (cell === undefined || cell.getWidth() === 0) continue
    // Bright black is what shells' autosuggestions draw in.
    const faint = cell.isDim() !== 0 || (cell.isFgPalette() && cell.getFgColor() === 8)
    glyphs.push({ col, row, chars: cell.getChars() || ' ', width: cell.getWidth(), faint })
  }
  return glyphs
}

function blank(glyph: Glyph): boolean {
  return glyph.chars.trim() === ''
}

function order(a: Cell, b: Cell): number {
  return a.row - b.row || a.col - b.col
}

function same(a: TypedInput, b: TypedInput): boolean {
  return a.text === b.text && order(a.caret, b.caret) === 0
}

const LINE_END = '\u0005'
const KILL_TO_START = '\u0015'

/**
 * Deletes the input the way a person would, with the keys shells, Claude Code and Codex share: ^E to
 * the line's end (→ onto the next line), then ^U, reading the screen after each and stopping when one does nothing.
 */
export async function clearTypedInput(
  pane: { term: Pick<XTerm, 'buffer' | 'rows' | 'modes' | 'onWriteParsed'>; send: (data: string) => void },
  read: () => TypedInput | null,
  settle: Settle = SETTLE
): Promise<void> {
  let input = read()
  if (input === null) return
  const right = (): string => (pane.term.modes.applicationCursorKeysMode ? '\u001bOC' : '\u001b[C')
  const press = async (data: string): Promise<TypedInput | null> => {
    await sendAndSettle(pane, data, settle)
    return read()
  }
  const steps = 3 * (input.end.row - input.start.row + 1) + 4
  for (let step = 0; input !== null && step < steps; step++) {
    if (order(input.caret, input.end) <= 0) {
      let moved = await press(LINE_END)
      if (moved !== null && same(moved, input)) moved = await press(right())
      if (moved === null || !same(moved, input)) {
        input = moved
        continue
      }
    }
    const next = await press(KILL_TO_START)
    if (next !== null && same(next, input)) return
    input = next
  }
}

/** Keys that act on a selected input, or null to leave the key alone. */
export type TypedInputKey = 'select' | 'select-all' | 'clear' | 'drop'

export function typedInputKey(
  event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
  selected: boolean
): TypedInputKey | null {
  const { metaKey, ctrlKey, altKey, shiftKey } = event
  if (metaKey && !ctrlKey && !altKey && !shiftKey && event.key.toLowerCase() === 'a') {
    return selected ? 'select-all' : 'select'
  }
  if (!selected || ctrlKey) return null
  if (event.key === 'Backspace' || event.key === 'Delete') return 'clear'
  if (event.key === 'Escape' && !metaKey && !altKey && !shiftKey) return 'drop'
  return null
}

/** Text, or a bracketed paste: what replaces a selected input. Control keys and escapes only let go of it. */
export function replacesInput(data: string): boolean {
  if (data.startsWith('\u001b[200~')) return true
  return data !== '' && !/[\u0000-\u001f\u007f]/u.test(data)
}

export type TypedInputSelection = {
  /** Selects the input; false when there is none to select. */
  select: () => boolean
  /** Whether an input is found now, for the menu. */
  found: () => boolean
  active: () => boolean
  text: () => string
  drop: () => void
  clear: () => Promise<void>
  /** Every byte for the pty: while an input is selected, typing replaces it and anything else lets go of it. */
  write: (data: string, byHand: boolean) => void
  dispose: () => void
}

type SelectionTerm = Pick<
  XTerm,
  | 'buffer'
  | 'rows'
  | 'cols'
  | 'modes'
  | 'element'
  | 'onWriteParsed'
  | 'onSelectionChange'
  | 'getSelectionPosition'
  | 'hasSelection'
  | 'select'
  | 'clearSelection'
>

export function typedInputSelection(options: {
  term: SelectionTerm
  find: () => TypedInput | null
  send: (data: string, byHand: boolean) => void
  settle?: Settle
}): TypedInputSelection {
  const { term, find, send } = options
  let held: { input: TypedInput; range: string } | null = null
  let selecting = false
  let clearing = false
  const queued: [string, boolean][] = []

  const range = (): string => {
    const at = term.getSelectionPosition()
    return at === undefined ? '' : `${at.start.x},${at.start.y},${at.end.x},${at.end.y}`
  }
  const changed = term.onSelectionChange(() => {
    const was = held
    if (selecting || was === null) return
    const now = range()
    if (now !== '' && now !== was.range) held = null
    // xterm clears the selection on a keypress just before it hands over the key's bytes, which replace the input.
    else if (now === '') {
      queueMicrotask(() => {
        if (held === was && !term.hasSelection()) held = null
      })
    }
  })
  const drop = (): void => {
    if (held === null) return
    held = null
    term.clearSelection()
  }
  // With the mouse reported, xterm leaves the selection alone on a click.
  const press = (event: MouseEvent): void => {
    if (event.button === 0) drop()
  }
  term.element?.addEventListener('mousedown', press, true)

  const clear = async (): Promise<void> => {
    drop()
    clearing = true
    try {
      await clearTypedInput({ term, send: (data) => send(data, true) }, find, options.settle)
    } finally {
      clearing = false
      for (const [data, byHand] of queued.splice(0)) send(data, byHand)
    }
  }

  return {
    select: () => {
      const input = find()
      if (input === null) return false
      selecting = true
      try {
        const length = (input.end.row - input.start.row) * term.cols + input.end.col - input.start.col + 1
        term.select(input.start.col, input.start.row, length)
      } finally {
        selecting = false
      }
      held = { input, range: range() }
      return true
    },
    found: () => find() !== null,
    active: () => held !== null,
    text: () => held?.input.text ?? '',
    drop,
    clear,
    write: (data, byHand) => {
      // A reply to the program's own query is not typing.
      if (!byHand) send(data, byHand)
      else if (clearing) queued.push([data, byHand])
      else if (held !== null && replacesInput(data)) {
        queued.push([data, byHand])
        void clear()
      } else {
        drop()
        send(data, byHand)
      }
    },
    dispose: () => {
      changed.dispose()
      term.element?.removeEventListener('mousedown', press, true)
    }
  }
}
