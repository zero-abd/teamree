// Preferences kept in the browser's storage. Storage can throw for reasons
// outside the app (private window, quota), and a preference that cannot be read
// back costs a default and nothing else.

import { describe, expect, it } from 'vitest'
import {
  ANY_PROJECT,
  CONFIRMATIONS_DEFAULT,
  editorFor,
  NOTICE_EVENTS_DEFAULT,
  readStoredConfirmations,
  readStoredNoticeEvents,
  TERMINAL_LINE_HEIGHT_MAX,
  TERMINAL_LINE_HEIGHT_MIN,
  writeStoredConfirmations,
  writeStoredNoticeEvents,
  clampTerminalFontSize,
  DIFF_LAYOUT_DEFAULT,
  NO_DEFAULT_AGENT,
  readStoredAgentArgs,
  readStoredDefaultAgent,
  readStoredDiffLayout,
  readStoredDiffOptions,
  readStoredKeepAwake,
  readStoredEditorCommands,
  readStoredStartPoints,
  clearStoredStartPoints,
  readStoredTerminalFontSize,
  readStoredTerminalOptions,
  KEEP_AWAKE_DEFAULT,
  TERMINAL_OPTIONS_DEFAULT,
  TERMINAL_SCROLLBACK_MAX,
  TERMINAL_SCROLLBACK_MIN,
  TERMINAL_FONT_DEFAULT_PX,
  TERMINAL_FONT_MAX_PX,
  TERMINAL_FONT_MIN_PX,
  withAgentArgs,
  withEditorCommand,
  writeStoredAgentArgs,
  writeStoredDefaultAgent,
  writeStoredDiffLayout,
  writeStoredDiffOptions,
  writeStoredKeepAwake,
  writeStoredEditorCommands,
  writeStoredTerminalFontSize,
  writeStoredTerminalOptions
} from './preferences'

/** A storage that holds what it is given, which is all these functions need. */
function memoryStorage(seed: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const entries = new Map(Object.entries(seed))
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value)
    },
    removeItem: (key) => {
      entries.delete(key)
    }
  }
}

/** A storage that refuses, the way a private window's does. */
const refusingStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = {
  getItem: () => {
    throw new Error('storage is not available')
  },
  setItem: () => {
    throw new Error('quota exceeded')
  },
  removeItem: () => {
    throw new Error('storage is not available')
  }
}

describe('the size of the text in a pane', () => {
  it('holds a size the emulator can actually draw', () => {
    expect(clampTerminalFontSize(TERMINAL_FONT_MIN_PX - 5)).toBe(TERMINAL_FONT_MIN_PX)
    expect(clampTerminalFontSize(TERMINAL_FONT_MAX_PX + 100)).toBe(TERMINAL_FONT_MAX_PX)
    expect(clampTerminalFontSize(14)).toBe(14)
  })

  // A grid of fractional cells is where a column count and the PTY's idea of one stop agreeing.
  it('rounds to a whole pixel', () => {
    expect(clampTerminalFontSize(13.6)).toBe(14)
  })

  it('falls back to the default rather than passing a number that is not one', () => {
    expect(clampTerminalFontSize(Number.NaN)).toBe(TERMINAL_FONT_DEFAULT_PX)
    // Infinity is not a size somebody meant: clamping it to the maximum would
    // turn a broken value into a deliberate-looking one.
    expect(clampTerminalFontSize(Number.POSITIVE_INFINITY)).toBe(TERMINAL_FONT_DEFAULT_PX)
  })

  it('comes back as it was written', () => {
    const storage = memoryStorage()
    writeStoredTerminalFontSize(storage, 17)
    expect(readStoredTerminalFontSize(storage)).toBe(17)
  })

  it('is the default when nothing has ever been written', () => {
    expect(readStoredTerminalFontSize(memoryStorage())).toBe(TERMINAL_FONT_DEFAULT_PX)
  })

  // The value on disk is a string somebody's browser kept, so it is treated as hostile.
  it('clamps what it reads, not only what it writes', () => {
    expect(readStoredTerminalFontSize(memoryStorage({ 'teamree.terminal.fontSize': '900' }))).toBe(TERMINAL_FONT_MAX_PX)
    expect(readStoredTerminalFontSize(memoryStorage({ 'teamree.terminal.fontSize': 'enormous' }))).toBe(
      TERMINAL_FONT_DEFAULT_PX
    )
  })

  it('survives a storage that refuses, in both directions', () => {
    expect(readStoredTerminalFontSize(refusingStorage)).toBe(TERMINAL_FONT_DEFAULT_PX)
    expect(() => writeStoredTerminalFontSize(refusingStorage, 16)).not.toThrow()
    expect(readStoredTerminalFontSize(undefined)).toBe(TERMINAL_FONT_DEFAULT_PX)
  })
})

describe('the start points an older build kept in this window', () => {
  it('come back by project, trimmed, and are gone once cleared', () => {
    const storage = memoryStorage({ 'teamree.worktree.startPoints': '{"alpha":"develop","beta":"  release/2.0  "}' })
    expect(readStoredStartPoints(storage)).toEqual({ alpha: 'develop', beta: 'release/2.0' })
    clearStoredStartPoints(storage)
    expect(readStoredStartPoints(storage)).toEqual({})
  })

  it('are empty when nothing has ever been written', () => {
    expect(readStoredStartPoints(memoryStorage())).toEqual({})
  })

  // A wrong shape has to end here rather than rendered into the field that names a git ref.
  it('drops anything that is not a ref, and anything that is not a map of them', () => {
    expect(readStoredStartPoints(memoryStorage({ 'teamree.worktree.startPoints': 'not json at all' }))).toEqual({})
    expect(readStoredStartPoints(memoryStorage({ 'teamree.worktree.startPoints': '["develop"]' }))).toEqual({})
    expect(readStoredStartPoints(memoryStorage({ 'teamree.worktree.startPoints': 'null' }))).toEqual({})
    expect(
      readStoredStartPoints(memoryStorage({ 'teamree.worktree.startPoints': '{"a":7,"b":"main","c":""}' }))
    ).toEqual({ b: 'main' })
  })

  it('survives a storage that refuses, in both directions', () => {
    expect(readStoredStartPoints(refusingStorage)).toEqual({})
    expect(() => clearStoredStartPoints(refusingStorage)).not.toThrow()
    expect(readStoredStartPoints(undefined)).toEqual({})
  })
})

// This value reaches the main process, which looks for it on PATH, so shapes
// that are not a program name have to stop here.
describe('the editor a project opens its checkouts in', () => {
  const KEY = 'teamree.editor.commands'

  it('is empty when nothing has ever been written', () => {
    expect(readStoredEditorCommands(memoryStorage())).toEqual({})
  })

  it('sets one project without disturbing another, and clearing removes the entry', () => {
    expect(withEditorCommand({ alpha: 'code' }, 'beta', 'zed')).toEqual({ alpha: 'code', beta: 'zed' })
    expect(withEditorCommand({ alpha: 'code' }, 'alpha', null)).toEqual({})
    expect(withEditorCommand({ alpha: 'code' }, 'alpha', '   ')).toEqual({})
  })

  it('trims, so a stray space cannot become part of a program name', () => {
    expect(withEditorCommand({}, 'alpha', '  code  ')).toEqual({ alpha: 'code' })
    expect(readStoredEditorCommands(memoryStorage({ [KEY]: '{"a":"  zed  "}' }))).toEqual({ a: 'zed' })
  })

  it('drops anything that is not a command, and anything that is not a map of them', () => {
    expect(readStoredEditorCommands(memoryStorage({ [KEY]: 'not json at all' }))).toEqual({})
    expect(readStoredEditorCommands(memoryStorage({ [KEY]: '["code"]' }))).toEqual({})
    expect(readStoredEditorCommands(memoryStorage({ [KEY]: '{"a":7,"b":"code","c":""}' }))).toEqual({ b: 'code' })
  })

  it('survives a storage that refuses, in both directions', () => {
    expect(readStoredEditorCommands(refusingStorage)).toEqual({})
    expect(() => writeStoredEditorCommands(refusingStorage, { alpha: 'code' })).not.toThrow()
    expect(readStoredEditorCommands(undefined)).toEqual({})
  })
})

describe('how a patch is laid out', () => {
  it('comes back as it was chosen', () => {
    const storage = memoryStorage()
    writeStoredDiffLayout(storage, 'split')
    expect(readStoredDiffLayout(storage)).toBe('split')
    writeStoredDiffLayout(storage, 'inline')
    expect(readStoredDiffLayout(storage)).toBe('inline')
  })

  // Two columns in three hundred pixels is two columns of nothing.
  it('is inline until somebody says otherwise', () => {
    expect(readStoredDiffLayout(memoryStorage())).toBe('inline')
    expect(DIFF_LAYOUT_DEFAULT).toBe('inline')
  })

  // A third value would reach the panel as a layout with no rules written for it.
  it('takes the default rather than a value that is not one of the two', () => {
    expect(readStoredDiffLayout(memoryStorage({ 'teamree.diff.layout': 'unified' }))).toBe('inline')
    expect(readStoredDiffLayout(memoryStorage({ 'teamree.diff.layout': '' }))).toBe('inline')
  })

  it('survives a storage that refuses, in both directions', () => {
    expect(readStoredDiffLayout(refusingStorage)).toBe('inline')
    expect(() => writeStoredDiffLayout(refusingStorage, 'split')).not.toThrow()
    expect(readStoredDiffLayout(undefined)).toBe('inline')
  })
})

describe('the agent you always use', () => {
  it('comes back as it was stored', () => {
    const storage = memoryStorage()
    writeStoredDefaultAgent(storage, 'codex')
    expect(readStoredDefaultAgent(storage)).toBe('codex')
  })

  // Nothing stored means nobody has said, and the first-found rule answers instead.
  it('is empty until somebody chooses one', () => {
    expect(readStoredDefaultAgent(memoryStorage())).toBe(NO_DEFAULT_AGENT)
  })

  it('can be cleared back to no preference', () => {
    const storage = memoryStorage()
    writeStoredDefaultAgent(storage, 'codex')
    writeStoredDefaultAgent(storage, NO_DEFAULT_AGENT)
    expect(readStoredDefaultAgent(storage)).toBe(NO_DEFAULT_AGENT)
  })

  it('survives a storage that refuses, in both directions', () => {
    expect(readStoredDefaultAgent(refusingStorage)).toBe(NO_DEFAULT_AGENT)
    expect(() => writeStoredDefaultAgent(refusingStorage, 'claude')).not.toThrow()
    expect(readStoredDefaultAgent(undefined)).toBe(NO_DEFAULT_AGENT)
  })
})

describe('the flag you always pass', () => {
  it('comes back as it was stored, per agent', () => {
    const storage = memoryStorage()
    writeStoredAgentArgs(storage, { claude: '--model opus', codex: '--full-auto' })
    expect(readStoredAgentArgs(storage)).toEqual({ claude: '--model opus', codex: '--full-auto' })
  })

  // The decision this ships with: no agent is given an argument nobody typed.
  it('is empty until somebody types one', () => {
    expect(readStoredAgentArgs(memoryStorage())).toEqual({})
  })

  it('sets one agent without disturbing another', () => {
    expect(withAgentArgs({ claude: '--model opus' }, 'codex', '--full-auto')).toEqual({
      claude: '--model opus',
      codex: '--full-auto'
    })
  })

  it('removes the entry rather than storing an empty one', () => {
    expect(withAgentArgs({ claude: '--model opus' }, 'claude', null)).toEqual({})
    expect(withAgentArgs({ claude: '--model opus' }, 'claude', '   ')).toEqual({})
  })

  // This ends up on a command line, so a non-string has to stop here.
  it('drops anything that is not a fragment, and anything that is not a map of them', () => {
    expect(readStoredAgentArgs(memoryStorage({ 'teamree.agent.args': 'not json at all' }))).toEqual({})
    expect(readStoredAgentArgs(memoryStorage({ 'teamree.agent.args': '["--model opus"]' }))).toEqual({})
    expect(readStoredAgentArgs(memoryStorage({ 'teamree.agent.args': '{"claude":7,"codex":"-a","x":""}' }))).toEqual({
      codex: '-a'
    })
  })

  it('survives a storage that refuses, in both directions', () => {
    expect(readStoredAgentArgs(refusingStorage)).toEqual({})
    expect(() => writeStoredAgentArgs(refusingStorage, { claude: '--model opus' })).not.toThrow()
    expect(readStoredAgentArgs(undefined)).toEqual({})
  })
})

describe('whether this Mac may sleep', () => {
  it('remembers the mode', () => {
    const storage = memoryStorage()
    writeStoredKeepAwake(storage, 'on')
    expect(readStoredKeepAwake(storage)).toBe('on')
    writeStoredKeepAwake(storage, 'off')
    expect(readStoredKeepAwake(storage)).toBe('off')
  })

  // Awake while an agent is on something: costs nobody fan noise and nobody a stopped run.
  it('follows the agents until somebody says otherwise', () => {
    expect(readStoredKeepAwake(memoryStorage())).toBe('agent')
    expect(KEEP_AWAKE_DEFAULT).toBe('agent')
  })

  it('takes the default rather than a value that is not one of the three', () => {
    expect(readStoredKeepAwake(memoryStorage({ 'teamree.keepAwake': 'forever' }))).toBe('agent')
    expect(readStoredKeepAwake(memoryStorage({ 'teamree.keepAwake': '' }))).toBe('agent')
  })

  it('survives a storage that refuses, in both directions', () => {
    expect(readStoredKeepAwake(refusingStorage)).toBe('agent')
    expect(() => writeStoredKeepAwake(refusingStorage, 'on')).not.toThrow()
  })
})

describe('how a pane draws and reads keys', () => {
  it('starts at what the emulator was hard-coded to', () => {
    expect(readStoredTerminalOptions(memoryStorage())).toEqual(TERMINAL_OPTIONS_DEFAULT)
    expect(TERMINAL_OPTIONS_DEFAULT).toMatchObject({
      cursorStyle: 'bar',
      cursorBlink: true,
      optionIsMeta: false,
      copyOnSelect: false,
      scrollback: 5000
    })
  })

  it('remembers the font', () => {
    const storage = memoryStorage()
    writeStoredTerminalOptions(storage, { ...TERMINAL_OPTIONS_DEFAULT, fontFamily: '"Iosevka Term", monospace' })
    expect(readStoredTerminalOptions(storage).fontFamily).toBe('"Iosevka Term", monospace')
  })

  it('remembers the cursor shape and whether it blinks', () => {
    const storage = memoryStorage()
    writeStoredTerminalOptions(storage, { ...TERMINAL_OPTIONS_DEFAULT, cursorStyle: 'underline', cursorBlink: false })
    expect(readStoredTerminalOptions(storage)).toMatchObject({ cursorStyle: 'underline', cursorBlink: false })
  })

  it('remembers Option as Meta', () => {
    const storage = memoryStorage()
    writeStoredTerminalOptions(storage, { ...TERMINAL_OPTIONS_DEFAULT, optionIsMeta: true })
    expect(readStoredTerminalOptions(storage).optionIsMeta).toBe(true)
  })

  it('remembers copy on select', () => {
    const storage = memoryStorage()
    writeStoredTerminalOptions(storage, { ...TERMINAL_OPTIONS_DEFAULT, copyOnSelect: true })
    expect(readStoredTerminalOptions(storage).copyOnSelect).toBe(true)
  })

  it('remembers the line height, held between its bounds in steps of 0.05', () => {
    expect(TERMINAL_OPTIONS_DEFAULT.lineHeight).toBe(1.25)
    const storage = memoryStorage()
    writeStoredTerminalOptions(storage, { ...TERMINAL_OPTIONS_DEFAULT, lineHeight: 1.43 })
    expect(readStoredTerminalOptions(storage).lineHeight).toBe(1.45)
    writeStoredTerminalOptions(storage, { ...TERMINAL_OPTIONS_DEFAULT, lineHeight: 0.2 })
    expect(readStoredTerminalOptions(storage).lineHeight).toBe(TERMINAL_LINE_HEIGHT_MIN)
    writeStoredTerminalOptions(storage, { ...TERMINAL_OPTIONS_DEFAULT, lineHeight: 9 })
    expect(readStoredTerminalOptions(storage).lineHeight).toBe(TERMINAL_LINE_HEIGHT_MAX)
  })

  it('remembers the scrollback, held between its bounds', () => {
    const storage = memoryStorage()
    writeStoredTerminalOptions(storage, { ...TERMINAL_OPTIONS_DEFAULT, scrollback: 20_000 })
    expect(readStoredTerminalOptions(storage).scrollback).toBe(20_000)
    writeStoredTerminalOptions(storage, { ...TERMINAL_OPTIONS_DEFAULT, scrollback: 10 })
    expect(readStoredTerminalOptions(storage).scrollback).toBe(TERMINAL_SCROLLBACK_MIN)
    writeStoredTerminalOptions(storage, { ...TERMINAL_OPTIONS_DEFAULT, scrollback: 9_000_000 })
    expect(readStoredTerminalOptions(storage).scrollback).toBe(TERMINAL_SCROLLBACK_MAX)
  })

  // Field by field: one bad value costs that field its default, not the rest their values.
  it('drops what it cannot use and keeps the rest', () => {
    const raw = JSON.stringify({
      fontFamily: '   ',
      cursorStyle: 'beam',
      cursorBlink: 'yes',
      optionIsMeta: true,
      copyOnSelect: 1,
      scrollback: 'lots'
    })
    expect(readStoredTerminalOptions(memoryStorage({ 'teamree.terminal.options': raw }))).toEqual({
      ...TERMINAL_OPTIONS_DEFAULT,
      optionIsMeta: true
    })
    expect(readStoredTerminalOptions(memoryStorage({ 'teamree.terminal.options': '[1]' }))).toEqual(
      TERMINAL_OPTIONS_DEFAULT
    )
    expect(readStoredTerminalOptions(memoryStorage({ 'teamree.terminal.options': '{' }))).toEqual(
      TERMINAL_OPTIONS_DEFAULT
    )
  })

  it('survives a storage that refuses, in both directions', () => {
    expect(readStoredTerminalOptions(refusingStorage)).toEqual(TERMINAL_OPTIONS_DEFAULT)
    expect(() => writeStoredTerminalOptions(refusingStorage, TERMINAL_OPTIONS_DEFAULT)).not.toThrow()
    expect(readStoredTerminalOptions(undefined)).toEqual(TERMINAL_OPTIONS_DEFAULT)
  })
})

describe('how a diff wraps and treats whitespace', () => {
  it('comes back as it was chosen', () => {
    const storage = memoryStorage()
    writeStoredDiffOptions(storage, { wrap: true, hideWhitespace: false })
    expect(readStoredDiffOptions(storage)).toEqual({ wrap: true, hideWhitespace: false })
    writeStoredDiffOptions(storage, { wrap: false, hideWhitespace: true })
    expect(readStoredDiffOptions(storage)).toEqual({ wrap: false, hideWhitespace: true })
  })

  it('is off until chosen, and off for anything unreadable', () => {
    expect(readStoredDiffOptions(memoryStorage())).toEqual({ wrap: false, hideWhitespace: false })
    expect(readStoredDiffOptions(memoryStorage({ 'teamree.diff.options': '{' }))).toEqual({
      wrap: false,
      hideWhitespace: false
    })
    expect(readStoredDiffOptions(memoryStorage({ 'teamree.diff.options': '{"wrap":"yes"}' }))).toEqual({
      wrap: false,
      hideWhitespace: false
    })
  })

  it('survives a storage that refuses, in both directions', () => {
    expect(readStoredDiffOptions(refusingStorage)).toEqual({ wrap: false, hideWhitespace: false })
    expect(() => writeStoredDiffOptions(refusingStorage, { wrap: true, hideWhitespace: true })).not.toThrow()
  })
})

describe('which events notify', () => {
  it('notifies for every event until one is turned off', () => {
    expect(readStoredNoticeEvents(memoryStorage())).toEqual(NOTICE_EVENTS_DEFAULT)
    expect(NOTICE_EVENTS_DEFAULT).toEqual({ finished: true, asking: true, teammates: true })
  })

  it('remembers each event on its own, and defaults a bad one alone', () => {
    const storage = memoryStorage()
    writeStoredNoticeEvents(storage, { finished: false, asking: true, teammates: false })
    expect(readStoredNoticeEvents(storage)).toEqual({ finished: false, asking: true, teammates: false })
    const raw = JSON.stringify({ finished: 'no', asking: false })
    expect(readStoredNoticeEvents(memoryStorage({ 'teamree.notices.events': raw }))).toEqual({
      finished: true,
      asking: false,
      teammates: true
    })
  })

  it('survives a storage that refuses, in both directions', () => {
    expect(readStoredNoticeEvents(refusingStorage)).toEqual(NOTICE_EVENTS_DEFAULT)
    expect(() => writeStoredNoticeEvents(refusingStorage, NOTICE_EVENTS_DEFAULT)).not.toThrow()
  })
})

describe('what is asked before it happens', () => {
  it('asks before deleting a worktree and before stopping an agent until told not to', () => {
    expect(readStoredConfirmations(memoryStorage())).toEqual(CONFIRMATIONS_DEFAULT)
    expect(CONFIRMATIONS_DEFAULT).toEqual({ removeWorktree: true, stopAgent: true })
  })

  it('remembers each on its own', () => {
    const storage = memoryStorage()
    writeStoredConfirmations(storage, { removeWorktree: false, stopAgent: true })
    expect(readStoredConfirmations(storage)).toEqual({ removeWorktree: false, stopAgent: true })
    const raw = JSON.stringify({ removeWorktree: 0, stopAgent: false })
    expect(readStoredConfirmations(memoryStorage({ 'teamree.confirm': raw }))).toEqual({
      removeWorktree: true,
      stopAgent: false
    })
  })

  it('survives a storage that refuses, in both directions', () => {
    expect(readStoredConfirmations(refusingStorage)).toEqual(CONFIRMATIONS_DEFAULT)
    expect(() => writeStoredConfirmations(refusingStorage, CONFIRMATIONS_DEFAULT)).not.toThrow()
  })
})

describe('the editor every project opens in', () => {
  it('is the project’s own pick, else the one set for every project, else none', () => {
    const both = withEditorCommand(withEditorCommand({}, ANY_PROJECT, 'zed'), 'p1', 'code')
    expect(editorFor(both, 'p1')).toBe('code')
    expect(editorFor(both, 'p2')).toBe('zed')
    expect(editorFor({}, 'p2')).toBeUndefined()
  })
})
