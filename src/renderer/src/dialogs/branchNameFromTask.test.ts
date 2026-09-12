import { describe, expect, it } from 'vitest'
import { branchNameFromTask } from './branchNameFromTask'

// The rule itself lives in src/shared and is the same function the runtime uses
// to create the branch, so these assert the preview's contract with the user
// rather than that two copies happen to agree.
describe('branchNameFromTask', () => {
  it('slugifies a task name', () => {
    expect(branchNameFromTask('Rewrite the pager')).toBe('rewrite-the-pager')
  })

  it('strips accents rather than dropping the letters', () => {
    expect(branchNameFromTask('Café résumé')).toBe('cafe-resume')
  })

  it('falls back when nothing survives slugification', () => {
    expect(branchNameFromTask('!!!')).toBe('worktree')
  })

  it('disambiguates names Windows reserves', () => {
    expect(branchNameFromTask('con')).toBe('con-1')
  })

  it('trims to a length git and every filesystem accepts', () => {
    const long = 'a very long task name that will certainly exceed the sixty character limit somewhere'
    expect(branchNameFromTask(long).length).toBeLessThanOrEqual(60)
    expect(branchNameFromTask(long).endsWith('-')).toBe(false)
  })

  it('does not prefix the name, because the runtime does not either', () => {
    expect(branchNameFromTask('fix login')).toBe('fix-login')
  })
})
