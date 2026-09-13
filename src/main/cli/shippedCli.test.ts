import { describe, expect, it } from 'vitest'
import { findShippedCli, shippedCliCandidates } from './shippedCli'

const PACKAGED = '/Applications/teamree.app/Contents/Resources'
const CHECKOUT = '/Users/ann/src/teamree'

describe('finding the CLI this app ships', () => {
  it('looks inside the packaged app first, then in the checkout it was started from', () => {
    expect(shippedCliCandidates({ resourcesPath: PACKAGED, cwd: CHECKOUT })).toEqual([
      '/Applications/teamree.app/Contents/Resources/cli/teamree',
      '/Users/ann/src/teamree/resources/cli/teamree'
    ])
  })

  it('has only the checkout to offer when nothing is packaged', () => {
    expect(shippedCliCandidates({ cwd: CHECKOUT })).toEqual(['/Users/ann/src/teamree/resources/cli/teamree'])
  })

  it('takes the packaged one when both are there', () => {
    expect(findShippedCli({ resourcesPath: PACKAGED, cwd: CHECKOUT, exists: () => true })).toBe(
      '/Applications/teamree.app/Contents/Resources/cli/teamree'
    )
  })

  it('falls back to the checkout, which is what a development run has', () => {
    const found = findShippedCli({
      resourcesPath: PACKAGED,
      cwd: CHECKOUT,
      exists: (candidate) => candidate.startsWith(CHECKOUT)
    })
    expect(found).toBe('/Users/ann/src/teamree/resources/cli/teamree')
  })

  it('answers null rather than a path that is not there', () => {
    expect(findShippedCli({ resourcesPath: PACKAGED, cwd: CHECKOUT, exists: () => false })).toBeNull()
  })
})
