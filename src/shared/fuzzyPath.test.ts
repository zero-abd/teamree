import { describe, expect, it } from 'vitest'
import { fuzzyPathScore, rankPaths } from './fuzzyPath'

const PATHS = [
  'src/renderer/src/keyboard/workspaceShortcuts.ts',
  'src/renderer/src/palette/paletteModel.ts',
  'src/renderer/src/palette/CommandPalette.tsx',
  'src/lib/math/index.ts',
  'src/math.ts',
  'docs/mathematics-notes.md',
  'fixtures/big.ts',
  'src/bigger/tests.ts',
  'README.md',
  'packages/pkg0/src/auth7/mathHelper6.ts'
]

const rank = (query: string): string[] => rankPaths(PATHS, query, 50).paths

describe('fuzzyPathScore', () => {
  it('matches the characters in order, whatever their case, and refuses them out of order', () => {
    expect(fuzzyPathScore('src/renderer/src/keyboard/workspaceShortcuts.ts', 'wsshort')).not.toBeNull()
    expect(fuzzyPathScore('src/renderer/src/keyboard/workspaceShortcuts.ts', 'WSS')).not.toBeNull()
    expect(fuzzyPathScore('src/math.ts', 'htam')).toBeNull()
  })

  it('ignores spaces in the query', () => {
    expect(fuzzyPathScore('src/renderer/src/palette/paletteModel.ts', 'palette model')).not.toBeNull()
  })
})

describe('rankPaths', () => {
  it('puts the file whose name is the query first', () => {
    expect(rank('big.ts')[0]).toBe('fixtures/big.ts')
    expect(rank('math')[0]).toBe('src/math.ts')
  })

  // A run of the query beats the same letters picked off word starts: `math` is not m-a-t + `H`elper.
  it('prefers the query in one run over a scattered match', () => {
    expect(fuzzyPathScore('src/math.ts', 'math')!).toBeGreaterThan(
      fuzzyPathScore('packages/pkg0/src/auth7/mathHelper6.ts', 'math')!
    )
  })

  it('prefers a match in the file name over one spread across directories', () => {
    const ranked = rank('pm')
    expect(ranked.indexOf('src/renderer/src/palette/paletteModel.ts')).toBeLessThan(
      ranked.indexOf('src/renderer/src/palette/CommandPalette.tsx')
    )
  })

  it('finds camel-case initials', () => {
    expect(rank('wss')[0]).toBe('src/renderer/src/keyboard/workspaceShortcuts.ts')
  })

  it('caps the answer and says it did', () => {
    const answer = rankPaths(PATHS, 's', 3)
    expect(answer.paths).toHaveLength(3)
    expect(answer.truncated).toBe(true)
  })

  it('ranks ten thousand paths quickly', () => {
    const many = Array.from(
      { length: 12_000 },
      (_, index) => `packages/p${index % 40}/src/module${index}/file${index}.ts`
    )
    const started = performance.now()
    const answer = rankPaths(many, 'mod12file', 50)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(answer.paths[0]).toBe('packages/p12/src/module12/file12.ts')
  })
})
