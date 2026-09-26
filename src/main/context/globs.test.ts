import { describe, expect, it } from 'vitest'
import { matchesAny, matchesGlob, normalizeGlob } from './globs'

describe('claim globs', () => {
  it('matches a single segment with * and any depth with **', () => {
    expect(matchesGlob('src/api/auth.ts', 'src/api/*.ts')).toBe(true)
    expect(matchesGlob('src/api/v2/auth.ts', 'src/api/*.ts')).toBe(false)
    expect(matchesGlob('src/api/v2/auth.ts', 'src/api/**')).toBe(true)
    expect(matchesGlob('src/api/v2/auth.ts', 'src/**/auth.ts')).toBe(true)
    expect(matchesGlob('src/auth.ts', 'src/**/auth.ts')).toBe(true)
    expect(matchesGlob('lib/auth.ts', 'src/**')).toBe(false)
  })

  it('reads a bare directory, or one ending in a slash, as everything under it', () => {
    expect(matchesGlob('src/api/auth.ts', 'src/api')).toBe(true)
    expect(matchesGlob('src/api/auth.ts', 'src/api/')).toBe(true)
    expect(matchesGlob('src/apix/auth.ts', 'src/api')).toBe(false)
    expect(matchesGlob('src/api', 'src/api')).toBe(true)
  })

  it('treats regex characters literally and ? as one character', () => {
    expect(matchesGlob('a+b(1).ts', 'a+b(1).ts')).toBe(true)
    expect(matchesGlob('a1.ts', 'a?.ts')).toBe(true)
    expect(matchesGlob('a/.ts', 'a?.ts')).toBe(false)
  })

  it('normalizes a leading ./ and backslashes', () => {
    expect(normalizeGlob('./src\\api\\*.ts')).toBe('src/api/*.ts')
    expect(matchesAny('src/api/auth.ts', ['docs/**', './src/api/*.ts'])).toBe(true)
    expect(matchesAny('src/api/auth.ts', [])).toBe(false)
  })
})
