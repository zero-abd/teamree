import { describe, expect, it } from 'vitest'
import { branchNameFromTask } from './branchNameFromTask'

describe('branchNameFromTask', () => {
  it('slugs a plain task name', () => {
    expect(branchNameFromTask('Rewrite the pager')).toBe('task/rewrite-the-pager')
  })

  it('collapses punctuation and trims the edges', () => {
    expect(branchNameFromTask('  fix: flaky (retry) tests!  ')).toBe('task/fix-flaky-retry-tests')
  })

  it('still produces a usable branch for an empty name', () => {
    expect(branchNameFromTask('   ')).toBe('task/untitled')
  })

  it('keeps the branch short enough to read', () => {
    const branch = branchNameFromTask('a'.repeat(120))
    expect(branch.length).toBeLessThanOrEqual('task/'.length + 48)
    expect(branch.endsWith('-')).toBe(false)
  })
})
