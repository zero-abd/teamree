// Taking a pasted image out of Claude Code's unsent prompt. The stand-in below edits and draws its
// input the way 2.1.283's bundle reads: a placeholder is one caret stop for ←, → and Backspace, and
// every frame parks the terminal cursor on the caret. The recorded 2.1.280 draft frame anchors it.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Terminal as XTerm } from '@xterm/xterm'
import { readPrompt, removePromptImage, type PromptPane } from './promptEdit'

const fixture = (name: string): string =>
  readFileSync(path.join(import.meta.dirname, '../../../main/terminals/fixtures', name), 'utf8')

const DRAFT = fixture('claude-images-draft.txt')
const PERMISSION = fixture('claude-permission.txt')

const COLS = 60
const ROWS = 24
const WIDTH = COLS - 4
const PLACEHOLDER = /\[(?:Pasted text|Image|Audio|\.\.\.Truncated text) #\d+(?: \+\d+ lines)?\.*\]/gu
const FAST = { quietMs: 5, maxMs: 80 }

type StandInOptions = { atomic?: boolean; fullscreen?: boolean; ignoreBackspace?: boolean; rows?: number }

/** Claude Code's input as its bundle has it, drawn as a full frame at 60 columns. */
class StandIn {
  constructor(
    public text: string,
    public caret: number,
    private readonly options: StandInOptions = {}
  ) {}

  key(data: string): void {
    if (data === '\x1b[D' || data === '\x1bOD') this.caret = this.left()
    else if (data === '\x1b[C' || data === '\x1bOC') this.caret = this.right()
    else if (data === '\x7f' && !this.options.ignoreBackspace) {
      const to = this.left()
      this.text = this.text.slice(0, to) + this.text.slice(this.caret)
      this.caret = to
    } else {
      this.text = this.text.slice(0, this.caret) + data + this.text.slice(this.caret)
      this.caret += data.length
    }
  }

  frame(): string {
    const rows = this.options.rows ?? ROWS
    const lines = this.lines()
    const rule = '─'.repeat(COLS - 2)
    const bottom = rows - 2
    const top = bottom - lines.length - 1
    const at = lines.findLastIndex((line) => line.start <= this.caret)
    const screen = new Map<number, string>([
      [0, '▐▛███▜▌ Claude Code'],
      [top, rule],
      [bottom, rule],
      [rows - 1, '  ? for shortcuts']
    ])
    lines.forEach((line, n) => screen.set(top + 1 + n, `${n === 0 ? '❯ ' : '  '}${line.text}`))
    const drawn = [...screen].map(([row, text]) => `\x1b[${row + 1};1H${text}`).join('')
    const cursor = `\x1b[${top + 2 + at};${3 + this.caret - lines[at]!.start}H`
    return `\x1b[?25l\x1b[2J${drawn}${cursor}\x1b[?25h`
  }

  start(): string {
    return (this.options.fullscreen === false ? '' : '\x1b[?1049h') + this.frame()
  }

  /** Word wrap that keeps the space at the end of the row it ends. */
  private lines(): { start: number; text: string }[] {
    const lines: { start: number; text: string }[] = []
    let start = 0
    while (start < this.text.length || lines.length === 0) {
      let end = Math.min(this.text.length, start + WIDTH)
      if (end < this.text.length) {
        const space = this.text.lastIndexOf(' ', end - 1)
        if (space >= start) end = space + 1
      }
      lines.push({ start, text: this.text.slice(start, end) })
      if (end === start) break
      start = end
    }
    return lines
  }

  private left(): number {
    if (this.caret === 0) return 0
    if (this.options.atomic !== false) {
      const ending = [...this.text.slice(0, this.caret).matchAll(PLACEHOLDER)].find(
        (match) => match.index + match[0].length === this.caret
      )
      if (ending) return ending.index
    }
    return this.caret - 1
  }

  private right(): number {
    if (this.caret >= this.text.length) return this.caret
    if (this.options.atomic !== false) {
      const starting = [...this.text.matchAll(PLACEHOLDER)].find((match) => match.index === this.caret)
      if (starting) return this.caret + starting[0].length
    }
    return this.caret + 1
  }
}

function write(term: XTerm, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

async function paneFor(
  standIn: StandIn,
  over: Partial<Omit<PromptPane, 'term' | 'send'>> & { onKey?: (sent: string[]) => void; rows?: number } = {}
) {
  const term = new XTerm({ cols: COLS, rows: over.rows ?? ROWS, allowProposedApi: true })
  await write(term, standIn.start())
  const sent: string[] = []
  const pane: PromptPane = {
    term,
    send: (data) => {
      sent.push(data)
      over.onKey?.(sent)
      standIn.key(data)
      term.write(standIn.frame())
    },
    busy: over.busy ?? (() => false),
    typedAt: over.typedAt ?? (() => 0),
    now: over.now ?? (() => 10_000)
  }
  return { term, pane, sent }
}

const PROMPT = '[Image #1] [Image #2] what changed between these two?'

describe('readPrompt', () => {
  it('finds each placeholder and the caret on the recorded draft frame', async () => {
    const term = new XTerm({ cols: 100, rows: 30, allowProposedApi: true })
    await write(term, DRAFT)
    const prompt = readPrompt(term, 2)
    expect(prompt).toMatchObject({
      caret: { row: 26, col: 55 },
      start: { row: 26, col: 13 },
      end: { row: 26, col: 22 }
    })
    expect(readPrompt(term, 1)).toMatchObject({ start: { row: 26, col: 2 }, end: { row: 26, col: 11 } })
    expect(readPrompt(term, 3)).toBeNull()
  })

  it('reads nothing while a permission dialog covers the input', async () => {
    const term = new XTerm({ cols: 100, rows: 30, allowProposedApi: true })
    await write(term, PERMISSION)
    expect(readPrompt(term, 1)).toBeNull()
  })
})

describe('removePromptImage', () => {
  it('takes the placeholder out from the caret at the end, one Backspace on it', async () => {
    const standIn = new StandIn(PROMPT, PROMPT.length)
    const { pane, sent } = await paneFor(standIn)
    expect(await removePromptImage(pane, 1, FAST)).toBeNull()
    expect(standIn.text).toBe(' [Image #2] what changed between these two?')
    expect(sent.filter((key) => key === '\x7f')).toHaveLength(1)
    expect(sent.at(-2)).toBe('\x1b[C')
  })

  it('walks right from a caret before the placeholder', async () => {
    const standIn = new StandIn(PROMPT, 0)
    const { pane } = await paneFor(standIn)
    expect(await removePromptImage(pane, 2, FAST)).toBeNull()
    expect(standIn.text).toBe('[Image #1]  what changed between these two?')
  })

  it('finds a placeholder the input wrapped across two rows', async () => {
    // 49 characters, so the row breaks at the space inside `[Image #4]`.
    const text = 'compare [Image #3] with the header in this one:  [Image #4] please'
    const standIn = new StandIn(text, text.length)
    const { pane, term } = await paneFor(standIn)
    const wrapped = readPrompt(term, 4)!
    expect(wrapped.start.row).toBeLessThan(wrapped.end.row)
    expect(await removePromptImage(pane, 4, FAST)).toBeNull()
    expect(standIn.text).not.toContain('[Image #4]')
    expect(standIn.text).toContain('[Image #3]')
  })

  it('sends the arrows a program in application cursor mode reads', async () => {
    const standIn = new StandIn(PROMPT, PROMPT.length)
    const { pane, term, sent } = await paneFor(standIn)
    await write(term, '\x1b[?1h')
    expect(await removePromptImage(pane, 2, FAST)).toBeNull()
    expect(sent).toContain('\x1bOD')
    expect(sent).not.toContain('\x1b[D')
  })

  it('leaves the prompt alone while the agent works or asks', async () => {
    const standIn = new StandIn(PROMPT, PROMPT.length)
    const { pane, sent } = await paneFor(standIn, { busy: () => true })
    expect(await removePromptImage(pane, 1, FAST)).toBe('busy')
    expect(sent).toEqual([])
  })

  it('leaves the prompt alone within a second of a keystroke', async () => {
    const standIn = new StandIn(PROMPT, PROMPT.length)
    const { pane, sent } = await paneFor(standIn, { typedAt: () => 9_400 })
    expect(await removePromptImage(pane, 1, FAST)).toBe('typing')
    expect(sent).toEqual([])
  })

  it('stops short of deleting when somebody types while the caret walks', async () => {
    let typedAt = 0
    const standIn = new StandIn(PROMPT, PROMPT.length)
    const { pane, sent } = await paneFor(standIn, {
      typedAt: () => typedAt,
      onKey: () => {
        typedAt = 9_990
      }
    })
    expect(await removePromptImage(pane, 1, FAST)).toBe('typing')
    expect(sent).not.toContain('\x7f')
    expect(standIn.text).toBe(PROMPT)
  })

  it('does not type into a dialog', async () => {
    const term = new XTerm({ cols: 100, rows: 30, allowProposedApi: true })
    await write(term, PERMISSION)
    const sent: string[] = []
    const pane: PromptPane = { term, send: (data) => sent.push(data), busy: () => false, typedAt: () => 0 }
    expect(await removePromptImage(pane, 1, FAST)).toBe('hidden')
    expect(sent).toEqual([])
  })

  it('refuses a placeholder the input holds twice', async () => {
    const text = '[Image #1] and again [Image #1]'
    const { pane, sent } = await paneFor(new StandIn(text, text.length))
    expect(await removePromptImage(pane, 1, FAST)).toBe('hidden')
    expect(sent).toEqual([])
  })

  it('refuses a full-screen input tall enough to be scrolled', async () => {
    const text = `[Image #1] ${'word '.repeat(40)}`
    const standIn = new StandIn(text, 0, { rows: 16 })
    const { pane, sent } = await paneFor(standIn, { rows: 16 })
    expect(await removePromptImage(pane, 1, FAST)).toBe('hidden')
    expect(sent).toEqual([])
  })

  it('edits an inline input of any height', async () => {
    const text = `[Image #1] ${'word '.repeat(40)}`
    const standIn = new StandIn(text, 0, { rows: 16, fullscreen: false })
    const { pane } = await paneFor(standIn, { rows: 16 })
    expect(await removePromptImage(pane, 1, FAST)).toBeNull()
    expect(standIn.text).not.toContain('[Image #1]')
  })

  it('puts the caret back and deletes nothing where a placeholder is not one caret stop', async () => {
    const standIn = new StandIn(PROMPT, PROMPT.length, { atomic: false })
    const { pane, sent } = await paneFor(standIn)
    expect(await removePromptImage(pane, 2, FAST)).toBe('failed')
    expect(sent).not.toContain('\x7f')
    expect(standIn.text).toBe(PROMPT)
    expect(standIn.caret).toBe(PROMPT.indexOf('[Image #2]'))
  })

  it('says so when the placeholder is still there after Backspace', async () => {
    const standIn = new StandIn(PROMPT, PROMPT.length, { ignoreBackspace: true })
    const { pane } = await paneFor(standIn)
    expect(await removePromptImage(pane, 1, FAST)).toBe('failed')
  })
})
