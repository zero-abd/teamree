import { describe, expect, it } from 'vitest'
import { parseStatusPaths } from './gitReads'

describe('touched paths from git status', () => {
  it('counts a rename under its new name and skips the old one', () => {
    const raw = [' M src/a.ts', 'R  src/new.ts', 'src/old.ts', '?? src/space name.ts', ''].join('\0')
    expect(parseStatusPaths(raw)).toEqual(['src/a.ts', 'src/new.ts', 'src/space name.ts'])
  })
})
