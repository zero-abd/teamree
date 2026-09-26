import { describe, expect, it } from 'vitest'
import { parsePatch, type PatchHunk, type PatchLine } from '@shared/patch'
import { changedSpans, MAX_HUNK_LINES, MAX_LINE_LENGTH, sourceHunk, withoutWhitespace } from './lineDiff'

function hunkOf(body: string): PatchHunk {
  const [file] = parsePatch(`diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,9 +1,9 @@\n${body}\n`)
  const hunk = file?.hunks[0]
  if (hunk === undefined) throw new Error('no hunk')
  return hunk
}

/** The text of each span on a line. */
function marked(spans: Map<PatchLine, readonly (readonly [number, number])[]>, line: PatchLine | undefined): string[] {
  if (line === undefined) return []
  return (spans.get(line) ?? []).map(([start, end]) => line.text.slice(start, end))
}

describe('changed spans in a line pair', () => {
  it('marks the changed word on each side of a one-word fix', () => {
    const hunk = hunkOf(['-const name = servce()', '+const name = service()'].join('\n'))
    const spans = changedSpans(hunk.lines)
    expect(marked(spans, hunk.lines[0])).toEqual(['servce'])
    expect(marked(spans, hunk.lines[1])).toEqual(['service'])
  })

  it('marks each change in a line, and joins changes separated only by spaces', () => {
    const hunk = hunkOf(['-call(a, b, c)', '+call(x, b, y z)'].join('\n'))
    const spans = changedSpans(hunk.lines)
    expect(marked(spans, hunk.lines[0])).toEqual(['a', 'c'])
    expect(marked(spans, hunk.lines[1])).toEqual(['x', 'y z'])
  })

  it('pairs a removed line with the added line it resembles, not the one in its position', () => {
    const hunk = hunkOf(
      ['-  return total', '+  // totals are cached', '+  const cached = memo.get(key)', '+  return totals'].join('\n')
    )
    const spans = changedSpans(hunk.lines)
    expect(marked(spans, hunk.lines[0])).toEqual(['total'])
    expect(marked(spans, hunk.lines[3])).toEqual(['totals'])
    expect(spans.has(hunk.lines[1] as PatchLine)).toBe(false)
    expect(spans.has(hunk.lines[2] as PatchLine)).toBe(false)
  })

  it('leaves unlike lines unmarked: the row colour already says all of it changed', () => {
    const hunk = hunkOf(['-import { a } from "./a"', '+export default function main() {}'].join('\n'))
    expect(changedSpans(hunk.lines).size).toBe(0)
  })

  it('marks nothing on context lines or on an addition with nothing removed', () => {
    const hunk = hunkOf([' keep()', '+added()', ' keep()'].join('\n'))
    expect(changedSpans(hunk.lines).size).toBe(0)
  })

  it('pairs within each run of changes, not across the context between them', () => {
    const hunk = hunkOf(['-let a = 1', ' middle()', '+let a = 2'].join('\n'))
    expect(changedSpans(hunk.lines).size).toBe(0)
  })

  it('skips a line longer than the cap', () => {
    const long = 'x'.repeat(MAX_LINE_LENGTH)
    const hunk = hunkOf([`-${long} a`, `+${long} b`].join('\n'))
    expect(changedSpans(hunk.lines).size).toBe(0)
  })

  it('skips a hunk longer than the cap', () => {
    const pairs = Math.ceil(MAX_HUNK_LINES / 2) + 1
    const body = [
      ...Array.from({ length: pairs }, (_, at) => `-value ${at} old`),
      ...Array.from({ length: pairs }, (_, at) => `+value ${at} new`)
    ]
    expect(changedSpans(hunkOf(body.join('\n')).lines).size).toBe(0)
  })

  it('stays fast over a long run of edited lines', () => {
    const body = [
      ...Array.from({ length: 400 }, (_, at) => `-  const value${at} = compute(${at}, 'alpha', options.first)`),
      ...Array.from({ length: 400 }, (_, at) => `+  const value${at} = compute(${at}, 'beta', options.second)`)
    ]
    const hunk = hunkOf(body.join('\n'))
    const started = performance.now()
    const spans = changedSpans(hunk.lines)
    expect(performance.now() - started).toBeLessThan(500)
    expect(marked(spans, hunk.lines[0])).toEqual(['alpha', 'first'])
  })
})

describe('whitespace changes hidden', () => {
  const PATCH = [
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,3 +1,3 @@',
    ' function a() {',
    '-    return 1',
    '+  return 1',
    ' }',
    '@@ -10,4 +10,4 @@ function b() {',
    '-  if (x) {',
    '-    go()',
    '+  if (y) {',
    '+  go()',
    '   }',
    ''
  ].join('\n')

  it('drops a hunk whose only change is whitespace', () => {
    const [file] = withoutWhitespace(parsePatch(PATCH))
    expect(file?.hunks).toHaveLength(1)
    expect(file?.hunks[0]?.header).toContain('@@ -10,4 +10,4 @@')
  })

  it('reads a line that changed only in whitespace as context, with both numbers', () => {
    const [file] = withoutWhitespace(parsePatch(PATCH))
    const lines = file?.hunks[0]?.lines ?? []
    expect(lines.map((line) => line.kind)).toEqual(['removed', 'added', 'context', 'context'])
    expect(lines[2]).toMatchObject({ text: '  go()', oldNumber: 11, newNumber: 11 })
  })

  it('keeps the hunk git wrote for staging it', () => {
    const [original] = parsePatch(PATCH)
    const [file] = withoutWhitespace(parsePatch(PATCH))
    const shown = file?.hunks[0] as PatchHunk
    expect(sourceHunk(shown)).toEqual(original?.hunks[1])
    expect(sourceHunk(shown).lines).toHaveLength(5)
  })

  it('leaves a patch with no whitespace-only lines as it was', () => {
    const files = parsePatch(PATCH.replace('+  return 1', '+  return 2'))
    const shown = withoutWhitespace(files)
    expect(shown[0]?.hunks[0]).toBe(files[0]?.hunks[0])
  })

  it('keeps an added blank line, as git does', () => {
    const files = parsePatch('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,1 +1,2 @@\n x\n+\n')
    expect(withoutWhitespace(files)[0]?.hunks).toHaveLength(1)
  })
})
