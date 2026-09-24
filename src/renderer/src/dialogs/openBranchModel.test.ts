import { describe, expect, it } from 'vitest'
import type { BranchEntry, PullRequestEntry } from '@shared/entities'
import { ageLabel, branchRows, filterRows, pullRequestRows, reviewPrompt } from './openBranchModel'

const NOW = Date.parse('2026-09-23T12:00:00Z')

const BRANCH: BranchEntry = {
  name: 'add-a-sub-function',
  checkout: 'origin/add-a-sub-function',
  remote: true,
  updatedAt: NOW - 3 * 3_600_000,
  author: 'Ana',
  subject: 'Add a sub function'
}

const PULL: PullRequestEntry = {
  number: 12,
  title: 'Add div',
  author: 'teammate',
  branch: 'add-div',
  checkout: 'origin/add-div',
  base: 'origin/main',
  updatedAt: NOW - 2 * 86_400_000
}

describe('the rows Open Branch lists', () => {
  it('names a branch, its last commit, whose it is and how old', () => {
    expect(branchRows([BRANCH], 'origin/main', NOW)).toEqual([
      {
        key: 'origin/add-a-sub-function',
        title: 'add-a-sub-function',
        detail: 'Add a sub function · Ana · 3h',
        name: 'Add a sub function',
        checkout: 'origin/add-a-sub-function',
        base: 'origin/main'
      }
    ])
  })

  it('names a pull request by number, title and author, compared against its base', () => {
    expect(pullRequestRows([PULL], NOW)).toEqual([
      {
        key: '#12',
        title: '#12 Add div · teammate',
        detail: 'add-div · 2d',
        name: 'Add div',
        checkout: 'origin/add-div',
        base: 'origin/main'
      }
    ])
  })

  it('filters on any word of the row, whatever its case', () => {
    const rows = [...branchRows([BRANCH], 'origin/main', NOW), ...pullRequestRows([PULL], NOW)]
    expect(filterRows(rows, 'ana').map((row) => row.key)).toEqual(['origin/add-a-sub-function'])
    expect(filterRows(rows, '#12').map((row) => row.key)).toEqual(['#12'])
    expect(filterRows(rows, '  ')).toHaveLength(2)
  })

  it('says ages in the shortest unit that fits', () => {
    expect(ageLabel(NOW - 30_000, NOW)).toBe('now')
    expect(ageLabel(NOW - 5 * 60_000, NOW)).toBe('5m')
    expect(ageLabel(NOW - 40 * 86_400_000, NOW)).toBe('40d')
    expect(ageLabel(null, NOW)).toBe('')
  })

  it('prefills the reviewer’s prompt with the base', () => {
    expect(reviewPrompt('origin/main')).toBe('Review this branch against origin/main')
  })
})
