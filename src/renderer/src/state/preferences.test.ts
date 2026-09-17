// The two preferences that are kept in the browser's storage rather than in the
// workspace file.
//
// Everything here is about the same promise: a preference that cannot be read
// back costs a default and nothing else. Storage is the one place in this
// renderer that can throw for reasons that have nothing to do with the app —
// a private window, a quota, a browser configured to refuse it — and a
// preference is never worth a blank window, so each of those is asserted rather
// than assumed.

import { describe, expect, it } from 'vitest'
import {
  clampTerminalFontSize,
  readStoredStartPoints,
  readStoredTerminalFontSize,
  TERMINAL_FONT_DEFAULT_PX,
  TERMINAL_FONT_MAX_PX,
  TERMINAL_FONT_MIN_PX,
  withStartPoint,
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

  // A fractional size is a fractional cell, and a grid of fractional cells is
  // where a column count and the PTY's idea of one stop agreeing.
  it('rounds to a whole pixel', () => {
    expect(clampTerminalFontSize(13.6)).toBe(14)
  })

  it('falls back to the default rather than passing a number that is not one', () => {
    expect(clampTerminalFontSize(Number.NaN)).toBe(TERMINAL_FONT_DEFAULT_PX)
    // Infinity is not a size somebody meant, so it is the default rather than
    // the top of the range: clamping it to the maximum would silently turn a
    // broken value into a deliberate-looking one.
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

  // The value on disk is a string somebody's browser kept, so it is treated as
  // hostile: a stored size out of range is clamped on the way back in rather
  // than trusted because it was once written by this app.
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

  // Setting a ref and clearing it are the same call, because the two are the
  // same question answered differently and splitting them would leave two ways
  // to mean "no preference".
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

  // The value is a string from storage, so every shape that is not the one this
  // expects has to end somewhere. It ends here rather than in the start-point
  // box, where a number or an object would have been rendered into the field
  // that names a git ref.
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
