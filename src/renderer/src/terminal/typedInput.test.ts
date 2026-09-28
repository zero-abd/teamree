/** @vitest-environment jsdom */

// ⌘A in a pane selects what was typed at the prompt, and a key clears it through the program: read off a
// real emulator, and driven against small stand-ins for a shell's line and an agent's input box.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Terminal as XTerm } from '@xterm/xterm'
import { resolvePlatformModifier } from '../keyboard/platformModifier'
import { paneKeyHandler } from './TerminalView'
import {
  clearTypedInput,
  findTypedInput,
  promptEnds,
  replacesInput,
  typedInputKey,
  typedInputSelection
} from './typedInput'

const APPLE = resolvePlatformModifier('darwin')
const B = '\u001b]133;B\u0007'
const FAST = { quietMs: 5, maxMs: 1_000 }
const FIXTURES = join(__dirname, '../../../main/terminals/fixtures')
const KEY_CODES: Record<string, number> = { Backspace: 8, Delete: 46, Escape: 27, ArrowLeft: 37, ArrowRight: 39 }

const open: XTerm[] = []
afterEach(() => {
  for (const term of open.splice(0)) term.dispose()
})

function emulator(
  cols = 80,
  rows = 24
): {
  term: XTerm
  write: (data: string) => Promise<void>
  find: () => ReturnType<typeof findTypedInput>
} {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const term = new XTerm({ allowProposedApi: true, cols, rows })
  term.open(host)
  open.push(term)
  const prompts = promptEnds(term)
  return {
    term,
    write: (data) => new Promise((resolve) => term.write(data, () => setTimeout(resolve, 0))),
    find: () => findTypedInput(term, prompts.last())
  }
}

describe('findTypedInput at a shell prompt', () => {
  it('takes what follows the marked prompt end', async () => {
    const { write, find } = emulator()
    await write(`user@host ~ % ${B}echo hello world`)
    expect(find()?.text).toBe('echo hello world')
    expect(find()?.start).toEqual({ col: 14, row: 0 })
  })

  it('follows input the line wrapped', async () => {
    const { write, find } = emulator(20)
    await write(`% ${B}${'x'.repeat(30)}`)
    expect(find()?.text).toBe('x'.repeat(30))
    expect(find()?.end).toEqual({ col: 11, row: 1 })
  })

  it('follows input zsh wrapped itself, erasing the row it wrapped onto', async () => {
    const { write, find } = emulator(30)
    await write(`w1 % ${B}a long line that wraps ac \r\u001b[Kr\rross the pane`)
    expect(find()?.text).toBe('a long line that wraps across the pane')
  })

  it('finds nothing once the line is run', async () => {
    const { write, find } = emulator()
    await write(`% ${B}sleep 5`)
    expect(find()?.text).toBe('sleep 5')
    await write('\u001b]133;C\u0007')
    expect(find()).toBeNull()
  })

  it('keeps text past a caret moved left, not a right prompt or a faint suggestion', async () => {
    const { write, find } = emulator()
    await write(`% \u001b7\u001b[70G[right]\u001b8${B}echo hello\u001b[5D`)
    expect(find()?.text).toBe('echo hello')
    await write(`\u001b[5C\u001b[90m there\u001b[39m\u001b[6D`)
    expect(find()?.text).toBe('echo hello')
  })

  it('finds nothing at an empty prompt, after Return, or on the alternate screen', async () => {
    const { write, find } = emulator()
    await write(`% ${B}`)
    expect(find()).toBeNull()
    await write('ls\r\nfile\r\n')
    expect(find()).toBeNull()
    await write(`% ${B}vim`)
    expect(find()?.text).toBe('vim')
    await write('\u001b[?1049hsome file\u001b[1;3H')
    expect(find()).toBeNull()
  })

  it('finds nothing without a mark', async () => {
    const { write, find } = emulator()
    await write('% echo hello')
    expect(find()).toBeNull()
  })
})

describe('findTypedInput in an agent’s input box', () => {
  it('reads Claude Code’s draft between its rules', async () => {
    const { write, find } = emulator(100, 30)
    await write(readFileSync(join(FIXTURES, 'claude-images-draft.txt'), 'utf8'))
    expect(find()?.text).toBe('[Image #1] [Image #2] what changed between these two?')
  })

  it('finds nothing in an empty box', async () => {
    const { write, find } = emulator(100, 30)
    await write(readFileSync(join(FIXTURES, 'claude-images-sent.txt'), 'utf8'))
    expect(find()).toBeNull()
  })

  it('reads every row of a box, but not its faint placeholder', async () => {
    const { write, find } = emulator(40, 10)
    const rule = '─'.repeat(40)
    await write(`${rule}\r\n❯ first line\r\n  second line\r\n${rule}\r\n  ? for shortcuts\u001b[3;14H`)
    expect(find()?.text).toBe('first line\nsecond line')
    await write(`\u001b[2;1H\u001b[2K❯ \u001b[2mTry "fix the bug"\u001b[22m\u001b[3;1H\u001b[2K\u001b[2;3H`)
    expect(find()).toBeNull()
  })

  it('reads a tinted composer led by ›, and not its dim placeholder', async () => {
    const { write, find } = emulator(40, 10)
    const tint = '\u001b[48;5;236m'
    await write(
      `${tint}\u001b[K\r\n\u001b[1m›\u001b[22m fix the bug\u001b[K\r\n\u001b[K\u001b[0m\r\n  ? for shortcuts\u001b[2;14H`
    )
    expect(find()?.text).toBe('fix the bug')
    await write(`\u001b[2;3H${tint}\u001b[2mAsk anything\u001b[22m\u001b[K\u001b[0m\u001b[2;3H`)
    expect(find()).toBeNull()
  })

  it('finds nothing where the caret is outside the box', async () => {
    const { write, find } = emulator(40, 10)
    const rule = '─'.repeat(40)
    await write(`${rule}\r\n❯ typed\r\n${rule}\r\n\u001b[6;1H`)
    expect(find()).toBeNull()
  })
})

/** A readline-ish line editor behind a prompt: ^A, ^E, ^U, ←, →, backspace and text. */
function shell(term: XTerm, typed = ''): { send: (data: string) => void; line: () => string } {
  let line = typed
  let caret = typed.length
  const draw = (): void => {
    const back = line.length - caret
    term.write(`\r\u001b[K% ${B}${line}${back > 0 ? `\u001b[${back}D` : ''}`)
  }
  draw()
  return {
    line: () => line,
    send: (data) => {
      for (const key of data.match(/\u001b\[[CD]|\u001b\[200~|\u001b\[201~|[\s\S]/gu) ?? []) {
        if (key === '\u0001') caret = 0
        else if (key === '\u0005') caret = line.length
        else if (key === '\u0015') [line, caret] = [line.slice(caret), 0]
        else if (key === '\u007f')
          [line, caret] = [line.slice(0, Math.max(0, caret - 1)) + line.slice(caret), Math.max(0, caret - 1)]
        else if (key === '\u001b[D') caret = Math.max(0, caret - 1)
        else if (key === '\u001b[C') caret = Math.min(line.length, caret + 1)
        else if (key >= ' ') [line, caret] = [line.slice(0, caret) + key + line.slice(caret), caret + key.length]
      }
      draw()
    }
  }
}

function pane(options: { typed?: string; left?: number; clipboard?: string } = {}): {
  term: XTerm
  sent: string[]
  copied: string[]
  line: () => string
  press: (key: string, modifiers?: Partial<Record<'metaKey' | 'shiftKey' | 'altKey' | 'ctrlKey', boolean>>) => void
  settled: () => Promise<void>
} {
  const { term, find } = emulator()
  const program = shell(term, options.typed)
  if (options.left) program.send('\u001b[D'.repeat(options.left))
  const sent: string[] = []
  const copied: string[] = []
  const input = typedInputSelection({
    term,
    find,
    send: (data) => {
      sent.push(data)
      program.send(data)
    },
    settle: FAST
  })
  term.onData((data) => input.write(data, true))
  term.attachCustomKeyEventHandler(
    paneKeyHandler({
      isAppChord: () => false,
      term,
      modifier: APPLE,
      send: (data) => input.write(data, true),
      input,
      clipboard: { copy: (text) => copied.push(text), read: () => Promise.resolve(options.clipboard ?? '') }
    })
  )
  return {
    term,
    sent,
    copied,
    line: program.line,
    press: (key, modifiers = {}) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers })
      Object.defineProperty(event, 'keyCode', { value: KEY_CODES[key] ?? key.toUpperCase().charCodeAt(0) })
      term.textarea?.dispatchEvent(event)
    },
    settled: () => new Promise((resolve) => term.write('', () => setTimeout(resolve, 0)))
  }
}

describe('⌘A in a pane', () => {
  it('selects only the typed input and sends nothing', async () => {
    const { term, press, sent, settled } = pane({ typed: 'echo hello world' })
    await settled()
    press('a', { metaKey: true })
    expect(term.getSelection()).toBe('echo hello world')
    expect(sent).toEqual([])
  })

  it('widens to everything on a second press', async () => {
    const { term, press, settled } = pane({ typed: 'echo hi' })
    await settled()
    press('a', { metaKey: true })
    press('a', { metaKey: true })
    expect(term.getSelection()).toContain('% echo hi')
  })

  it('selects everything at an empty prompt', async () => {
    const { term, press, settled } = pane()
    await settled()
    press('a', { metaKey: true })
    expect(term.getSelection()).toContain('%')
  })

  it('clears the input on Backspace with ^U, going to the end first when the caret is not there', async () => {
    const atEnd = pane({ typed: 'echo hello world' })
    await atEnd.settled()
    atEnd.press('a', { metaKey: true })
    atEnd.press('Backspace')
    await vi.waitFor(() => expect(atEnd.line()).toBe(''))
    expect(atEnd.sent).toEqual(['\u0015'])
    expect(atEnd.line()).toBe('')

    const inside = pane({ typed: 'echo hello world', left: 6 })
    await inside.settled()
    inside.sent.length = 0
    inside.press('a', { metaKey: true })
    inside.press('Delete')
    await vi.waitFor(() => expect(inside.line()).toBe(''))
    expect(inside.sent).toEqual(['\u0005', '\u0015'])
    expect(inside.line()).toBe('')
  })

  it('replaces the input with what is typed or pasted', async () => {
    const typing = pane({ typed: 'echo hello' })
    await typing.settled()
    typing.press('a', { metaKey: true })
    typing.press('x')
    await vi.waitFor(() => expect(typing.line()).toBe('x'))
    expect(typing.sent).toEqual(['\u0015', 'x'])
    expect(typing.line()).toBe('x')

    const pasting = pane({ typed: 'echo hello', clipboard: 'ls -la' })
    await pasting.settled()
    pasting.press('a', { metaKey: true })
    pasting.press('v', { metaKey: true })
    await vi.waitFor(() => expect(pasting.line()).toBe('ls -la'))
    expect(pasting.line()).toBe('ls -la')
  })

  it('lets go on an arrow or Escape, deleting nothing', async () => {
    const { term, press, sent, line, settled } = pane({ typed: 'echo hello' })
    await settled()
    press('a', { metaKey: true })
    press('ArrowLeft')
    expect(term.hasSelection()).toBe(false)
    press('Backspace')
    await settled()
    expect(sent).toEqual(['\u001b[D', '\u007f'])
    expect(line()).toBe('echo helo')

    press('a', { metaKey: true })
    press('Escape')
    expect(term.hasSelection()).toBe(false)
    expect(sent).toHaveLength(2)
  })

  it('replaces the input with text that lands a turn late, and lets a reply to the program through', async () => {
    const { term } = emulator()
    const program = shell(term, 'echo hello')
    const sent: string[] = []
    const prompts = promptEnds(term)
    await new Promise((resolve) => term.write('', () => setTimeout(resolve, 0)))
    const input = typedInputSelection({
      term,
      find: () => findTypedInput(term, prompts.last()),
      send: (data) => {
        sent.push(data)
        program.send(data)
      },
      settle: FAST
    })
    expect(input.select()).toBe(true)
    input.write('\u001b[?1;2c', false)
    expect(input.active()).toBe(true)
    input.write('ü', false)
    await vi.waitFor(() => expect(program.line()).toBe('ü'))
    expect(sent).toEqual(['\u001b[?1;2c', '\u0015', 'ü'])
    expect(program.line()).toBe('ü')
  })

  it('copies just the input on ⌘C', async () => {
    const { press, copied, sent, settled } = pane({ typed: 'echo hello' })
    await settled()
    press('a', { metaKey: true })
    press('c', { metaKey: true })
    expect(copied).toEqual(['echo hello'])
    expect(sent).toEqual([])
  })
})

/** An agent's multi-line box: ^E to the logical line's end, → across lines, ^U to line start or through a newline. */
function agentBox(
  term: XTerm,
  lines: string[],
  at: { line: number; col: number }
): {
  send: (data: string) => void
  lines: () => string[]
} {
  let caret = { ...at }
  const rule = '─'.repeat(term.cols)
  const draw = (): void => {
    const rows = lines.map((text, index) => `${index === 0 ? '❯ ' : '  '}${text}`)
    term.write(`\u001b[H\u001b[J${rule}\r\n${rows.join('\r\n')}\r\n${rule}\u001b[${caret.line + 2};${caret.col + 3}H`)
  }
  draw()
  return {
    lines: () => lines,
    send: (data) => {
      const line = lines[caret.line]!
      if (data === '\u0005') caret.col = line.length
      else if (data === '\u001b[C') {
        if (caret.col < line.length) caret.col++
        else if (caret.line < lines.length - 1) caret = { line: caret.line + 1, col: 0 }
      } else if (data === '\u0015') {
        if (caret.col > 0) {
          lines[caret.line] = line.slice(caret.col)
          caret.col = 0
        } else if (caret.line > 0) {
          const above = lines[caret.line - 1]!
          lines.splice(caret.line - 1, 2, above + line)
          caret = { line: caret.line - 1, col: above.length }
        }
      }
      draw()
    }
  }
}

describe('clearTypedInput in an agent’s box', () => {
  it('walks to the end of a multi-line draft, then kills it line by line', async () => {
    const { term, find } = emulator(40, 12)
    const sent: string[] = []
    const box = agentBox(term, ['first line', 'second', 'third one'], { line: 0, col: 3 })
    await new Promise((resolve) => term.write('', () => setTimeout(resolve, 0)))
    expect(find()?.text).toBe('first line\nsecond\nthird one')

    await clearTypedInput(
      {
        term,
        send: (data) => {
          sent.push(data)
          box.send(data)
        }
      },
      find,
      FAST
    )

    expect(box.lines()).toEqual([''])
    // ^E finds the caret already at its line's end, so → takes it on to the next line.
    expect(sent.slice(0, 3)).toEqual(['\u0005', '\u0005', '\u001b[C'])
    expect(sent.filter((key) => key === '\u0015').length).toBeGreaterThanOrEqual(5)
  })

  it('stops when a key does nothing', async () => {
    const { term, find } = emulator(40, 12)
    const rule = '─'.repeat(40)
    await new Promise((resolve) => term.write(`${rule}\r\n❯ stuck\r\n${rule}\u001b[2;8H`, () => resolve(null)))
    const sent: string[] = []
    await clearTypedInput({ term, send: (data) => sent.push(data) }, find, FAST)
    expect(sent).toEqual(['\u0015'])
  })
})

describe('the keys around a selected input', () => {
  const key = (k: string, held: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...held
  })

  it('selects on ⌘A, widens on the next, clears on Backspace and Delete, lets go on Escape', () => {
    expect(typedInputKey(key('a', { metaKey: true }), false)).toBe('select')
    expect(typedInputKey(key('a', { metaKey: true }), true)).toBe('select-all')
    expect(typedInputKey(key('Backspace'), true)).toBe('clear')
    expect(typedInputKey(key('Backspace', { metaKey: true }), true)).toBe('clear')
    expect(typedInputKey(key('Delete'), true)).toBe('clear')
    expect(typedInputKey(key('Escape'), true)).toBe('drop')
    expect(typedInputKey(key('Backspace'), false)).toBeNull()
    expect(typedInputKey(key('ArrowLeft'), true)).toBeNull()
    expect(typedInputKey(key('a', { ctrlKey: true }), false)).toBeNull()
  })

  it('treats text and bracketed pastes as replacing, and control keys as not', () => {
    expect(replacesInput('x')).toBe(true)
    expect(replacesInput('é')).toBe(true)
    expect(replacesInput('\u001b[200~a\nb\u001b[201~')).toBe(true)
    expect(replacesInput('\r')).toBe(false)
    expect(replacesInput('\u001b[D')).toBe(false)
    expect(replacesInput('\u0001')).toBe(false)
  })
})
