import { describe, expect, it } from 'vitest'
import { parsePatch } from '@shared/patch'
import { hunkLabel, inChangesOrder, isViewedFile, isViewedRow, viewedMark } from './reviewModel'

const patch = (path: string, body: string, header = '@@ -5,3 +5,4 @@'): string =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${header}\n${body}\n`

const MATH = patch(
  'src/math.ts',
  ' }\n+\n+export const x = 1\n }',
  '@@ -5,3 +5,5 @@ export function add(a: number, b: number): number {'
)
const NOTES = patch('docs/NOTES.md', '+# Notes', '@@ -0,0 +1 @@')

describe('a hunk header as a reader wants it', () => {
  it('keeps the function it is in, arguments folded', () => {
    const [file] = parsePatch(MATH)
    expect(hunkLabel(file!.hunks[0]!)).toBe('export function add(…)')
  })

  it('says which lines it covers when git named no function', () => {
    const [file] = parsePatch(NOTES)
    expect(hunkLabel(file!.hunks[0]!)).toBe('Line 1')
    const [three] = parsePatch(patch('a.ts', '+a\n+b\n+c', '@@ -0,0 +1,3 @@'))
    expect(hunkLabel(three!.hunks[0]!)).toBe('Lines 1–3')
  })

  it('drops the brace from a heading with no arguments', () => {
    const [file] = parsePatch(patch('a.ts', ' x', '@@ -5,1 +5,1 @@ class Ranker {'))
    expect(hunkLabel(file!.hunks[0]!)).toBe('class Ranker')
  })
})

describe('viewed files', () => {
  it('stays viewed while the file reads the same, and not once it changes', () => {
    const [math] = parsePatch(MATH)
    const mark = viewedMark(math!)
    expect(isViewedFile(mark, parsePatch(MATH)[0]!)).toBe(true)
    const edited = parsePatch(MATH.replace('x = 1', 'x = 2'))[0]!
    expect(isViewedFile(mark, edited)).toBe(false)
    expect(isViewedFile(undefined, math!)).toBe(false)
  })

  it('marks a Changes row while its counts match what was viewed', () => {
    const mark = viewedMark(parsePatch(MATH)[0]!)
    expect(mark).toMatchObject({ added: 2, removed: 0 })
    const row = { path: 'src/math.ts', kind: 'modified' as const, staged: false, unstaged: true }
    expect(isViewedRow(mark, { ...row, added: 2, removed: 0 })).toBe(true)
    expect(isViewedRow(mark, { ...row, added: 3, removed: 0 })).toBe(false)
    expect(isViewedRow(undefined, { ...row, added: 2, removed: 0 })).toBe(false)
  })
})

it('lays the files out in the order the Changes list has them, unlisted ones last', () => {
  const whole = patch('z.ts', '+z') + MATH + NOTES
  const rows = [
    { path: 'docs/NOTES.md', kind: 'untracked' as const, staged: false, unstaged: true },
    { path: 'src/math.ts', kind: 'modified' as const, staged: false, unstaged: true }
  ]
  const ordered = inChangesOrder(whole, rows)
  expect(parsePatch(ordered).map((file) => file.path)).toEqual(['docs/NOTES.md', 'src/math.ts', 'z.ts'])
  expect(ordered.length).toBe(whole.length)
})
