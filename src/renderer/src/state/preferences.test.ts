// Preferences kept in the browser's storage. Storage can throw for reasons
// outside the app (private window, quota), and a preference that cannot be read
// back costs a default and nothing else.

import { describe, expect, it } from 'vitest'
import {
  clampTerminalFontSize,
  DIFF_LAYOUT_DEFAULT,
  NO_DEFAULT_AGENT,
  readStoredAgentArgs,
  readStoredDefaultAgent,
  readStoredDiffLayout,
  readStoredKeepAwake,
  readStoredEditorCommands,
  readStoredStartPoints,
  readStoredTerminalFontSize,
  KEEP_AWAKE_DEFAULT,
  TERMINAL_FONT_DEFAULT_PX,
  TERMINAL_FONT_MAX_PX,
  TERMINAL_FONT_MIN_PX,
  withAgentArgs,
  withEditorCommand,
  withStartPoint,
  writeStoredAgentArgs,
  writeStoredDefaultAgent,
  writeStoredDiffLayout,
  writeStoredKeepAwake,
  writeStoredEditorCommands,
  writeStoredStartPoints,
  writeStoredTerminalFontSize
} from './preferences'

/** A storage that holds what it is given, which is all these functions need. */
function memoryStorage(seed: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> {
  const entries = new Map(Object.entries(seed))
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value)
    }
  }
}

/** A storage that refuses, the way a private window's does. */
const refusingStorage: Pick<Storage, 'getItem' | 'setItem'> = {
  getItem: () => {
    throw new Error('storage is not available')
  },
  setItem: () => {
    throw new Error('quota exceeded')
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

describe('the ref a project starts new worktrees from', () => {
  it('comes back as it was written, by project', () => {
    const storage = memoryStorage()
    writeStoredStartPoints(storage, { alpha: 'develop', beta: 'release/2.0' })
    expect(readStoredStartPoints(storage)).toEqual({ alpha: 'develop', beta: 'release/2.0' })
  })

  it('is empty when nothing has ever been written', () => {
    expect(readStoredStartPoints(memoryStorage())).toEqual({})
  })

  // Setting a ref and clearing it are the same call; splitting them would
  // leave two ways to mean "no preference".
  it('sets one project without disturbing another', () => {
    const refs = withStartPoint({ alpha: 'develop' }, 'beta', 'main')
    expect(refs).toEqual({ alpha: 'develop', beta: 'main' })
  })

  it('removes the entry rather than storing an empty one', () => {
    expect(withStartPoint({ alpha: 'develop' }, 'alpha', null)).toEqual({})
    expect(withStartPoint({ alpha: 'develop' }, 'alpha', '   ')).toEqual({})
  })

  it('trims what it is given, so a stray space cannot become part of a ref name', () => {
    expect(withStartPoint({}, 'alpha', '  develop  ')).toEqual({ alpha: 'develop' })
    expect(readStoredStartPoints(memoryStorage({ 'teamree.worktree.startPoints': '{"a":"  main  "}' }))).toEqual({
      a: 'main'
    })
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
    expect(() => writeStoredStartPoints(refusingStorage, { alpha: 'develop' })).not.toThrow()
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
