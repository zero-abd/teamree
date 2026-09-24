import { describe, expect, it } from 'vitest'
import { compareRuns, patchByFile } from './runCompare'

const SUB = [
  'diff --git a/src/math.ts b/src/math.ts',
  'index 1111111..2222222 100644',
  '--- a/src/math.ts',
  '+++ b/src/math.ts',
  '@@ -3,3 +3,7 @@ export function add(a: number, b: number): number {',
  ' }',
  ' ',
  '+export function sub(a: number, b: number): number {',
  '+  return a - b',
  '+}',
  '+',
  ' export function mul(a: number, b: number): number {',
  ''
].join('\n')

const SUB_AT_END = [
  'diff --git a/src/math.ts b/src/math.ts',
  'index 1111111..3333333 100644',
  '--- a/src/math.ts',
  '+++ b/src/math.ts',
  '@@ -7,2 +7,4 @@ export function mul(a: number, b: number): number {',
  '   return a * b',
  ' }',
  '+',
  '+export const sub = (a: number, b: number): number => a - b',
  ''
].join('\n')

const TEST = [
  'diff --git a/src/math.test.ts b/src/math.test.ts',
  'new file mode 100644',
  'index 0000000..4444444',
  '--- /dev/null',
  '+++ b/src/math.test.ts',
  '@@ -0,0 +1,2 @@',
  "+import { sub } from './math'",
  '+test(sub(3, 1) === 2)',
  ''
].join('\n')

const README = [
  'diff --git a/README.md b/README.md',
  'index 5555555..6666666 100644',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1 +1,2 @@',
  ' # pantry',
  '+sub(a, b) subtracts.',
  ''
].join('\n')

describe('a run’s patch by file', () => {
  it('splits the patch at each file, keeping each file’s text as git wrote it, with its line counts', () => {
    const files = patchByFile(SUB + TEST)
    expect([...files.keys()]).toEqual(['src/math.ts', 'src/math.test.ts'])
    expect(files.get('src/math.ts')).toEqual({ patch: SUB, added: 4, removed: 0 })
    expect(files.get('src/math.test.ts')).toEqual({ patch: TEST, added: 2, removed: 0 })
  })

  it('reads nothing from an empty patch', () => {
    expect(patchByFile('').size).toBe(0)
  })
})

describe('two runs, file by file', () => {
  it('pairs each file either run touched, in path order, the side that did not left empty', () => {
    const files = compareRuns(SUB + TEST, SUB_AT_END + README)
    expect(files.map((file) => [file.path, file.left !== null, file.right !== null])).toEqual([
      ['README.md', false, true],
      ['src/math.test.ts', true, false],
      ['src/math.ts', true, true]
    ])
    const math = files[2]!
    expect(math.left?.patch).toBe(SUB)
    expect(math.right?.patch).toBe(SUB_AT_END)
    expect(math.same).toBe(false)
  })

  it('calls a file the same when both runs made the one change, whatever the blob ids say', () => {
    const other = SUB.replace('index 1111111..2222222', 'index 1111111..9999999')
    const [math] = compareRuns(SUB, other)
    expect(math?.same).toBe(true)
  })

  it('never calls a file only one run touched the same', () => {
    expect(compareRuns(TEST, '').map((file) => file.same)).toEqual([false])
  })
})
