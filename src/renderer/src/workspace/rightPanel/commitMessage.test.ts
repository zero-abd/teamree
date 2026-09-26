import { describe, expect, it } from 'vitest'
import type { Worktree } from '@shared/entities'
import { commitMessageOf, commitSuggestion, shownDraft, useCommitDrafts, type CommitSuggestion } from './commitMessage'

type Source = Pick<Worktree, 'report' | 'task' | 'issue'>

const report = (summary: string, outcome: 'succeeded' | 'failed' = 'succeeded'): Source['report'] => ({
  outcome,
  summary,
  paths: [],
  at: 0
})

describe('where the message comes from', () => {
  it('takes the done report first, its first line as the subject', () => {
    const worktree: Source = {
      task: 'Add tax to cart totals',
      report: report('Cart totals include tax, rounded per line.\nAdded tests for the rounding.')
    }
    expect(commitSuggestion(worktree)).toEqual({
      text: 'Cart totals include tax, rounded per line.\n\nAdded tests for the rounding.',
      from: 'report'
    })
  })

  it('falls back to the task’s first line', () => {
    expect(commitSuggestion({ task: 'Add tax to cart totals\n\nRound per line, not per cart.' })).toEqual({
      text: 'Add tax to cart totals',
      from: 'task'
    })
  })

  // A failed report says what went wrong, which is no commit message.
  it('passes over a failed report for the task', () => {
    expect(commitSuggestion({ task: 'Add tax', report: report('Could not run the tests.', 'failed') })).toEqual({
      text: 'Add tax',
      from: 'task'
    })
  })

  it('passes over a blank report and a blank task', () => {
    expect(commitSuggestion({ task: '  \n\n  Add tax', report: report('   ') })).toEqual({
      text: 'Add tax',
      from: 'task'
    })
  })

  it('offers nothing with neither', () => {
    expect(commitSuggestion({})).toBeNull()
    expect(commitSuggestion(undefined)).toBeNull()
    expect(commitSuggestion({ task: '  ' })).toBeNull()
  })
})

describe('an issue task', () => {
  const issue = { number: 123, url: 'https://github.com/acme/api/issues/123' }

  it('closes its issue under the report', () => {
    expect(commitSuggestion({ issue, report: report('Totals include tax.') })?.text).toBe(
      'Totals include tax.\n\nCloses #123'
    )
  })

  it('moves the issue number from the task’s subject to the trailer', () => {
    expect(commitSuggestion({ issue, task: '#123 Tax in cart totals\n\nBody of the issue.' })?.text).toBe(
      'Tax in cart totals\n\nCloses #123'
    )
  })

  it('does not close it twice when the report already does', () => {
    expect(commitSuggestion({ issue, report: report('Totals include tax.\nFixes #123') })?.text).toBe(
      'Totals include tax.\n\nFixes #123'
    )
  })
})

describe('subject and body', () => {
  it('keeps a subject of 72 characters whole', () => {
    const subject = 'a'.repeat(72)
    expect(commitMessageOf(subject)).toBe(subject)
  })

  it('ends a long subject at its first sentence and moves the rest to the body', () => {
    const line = 'Cart totals include tax. Each line is rounded on its own before the sum, as the till does.'
    expect(commitMessageOf(line)).toBe(
      'Cart totals include tax.\n\nEach line is rounded on its own before the sum, as the till does.'
    )
  })

  it('cuts a long subject with no sentence end at a word, carrying the rest', () => {
    const line = `${'word '.repeat(20)}end`.trim()
    const [subject = '', , rest = ''] = commitMessageOf(line).split('\n')
    expect(subject.length).toBeLessThanOrEqual(72)
    expect(subject.endsWith('…')).toBe(true)
    expect(rest.startsWith('…')).toBe(true)
    expect(`${subject.slice(0, -1)} ${rest.slice(1)}`).toBe(line)
  })

  it('wraps a body line past 80 characters at 72', () => {
    const long = `${'lorem ipsum '.repeat(12)}dolor`.trim()
    const body = commitMessageOf(`Subject\n${long}`).split('\n').slice(2)
    expect(body.length).toBeGreaterThan(1)
    for (const line of body) expect(line.length).toBeLessThanOrEqual(72)
    expect(body.join(' ')).toBe(long)
  })

  // A report already set out by hand (a list, a table) is left as written.
  it('leaves body lines of 80 or fewer as written', () => {
    const line = `- ${'x'.repeat(76)}`
    expect(line.length).toBe(78)
    expect(commitMessageOf(`Subject\n${line}\n- short`)).toBe(`Subject\n\n${line}\n- short`)
  })

  it('hangs a wrapped list item under its text', () => {
    const item = `- ${'item text '.repeat(10)}end`
    const body = commitMessageOf(`Subject\n\n${item}`).split('\n').slice(2)
    expect(body[0]!.startsWith('- ')).toBe(true)
    for (const line of body.slice(1)) expect(line.startsWith('  ')).toBe(true)
  })

  it('never breaks a word longer than the width, such as a link', () => {
    const url = `https://example.com/${'a'.repeat(90)}`
    expect(commitMessageOf(`Subject\nsee ${url} for more`)).toBe(`Subject\n\nsee\n${url}\nfor more`)
  })

  it('keeps paragraphs apart and drops runs of blank lines', () => {
    expect(commitMessageOf('Subject\n\n\none\n\n\n\ntwo\n')).toBe('Subject\n\none\n\ntwo')
  })
})

describe('what the box shows', () => {
  const first: CommitSuggestion = { text: 'Totals include tax.', from: 'report' }
  const second: CommitSuggestion = { text: 'Totals include tax and fees.', from: 'report' }

  it('shows the suggestion, marked, until something is typed', () => {
    expect(shownDraft(undefined, first)).toEqual({ text: first.text, from: 'report' })
    expect(shownDraft(undefined, null)).toEqual({ text: '', from: null })
  })

  it('keeps typed text, unmarked', () => {
    expect(shownDraft({ text: 'Mine', seed: first.text }, first)).toEqual({ text: 'Mine', from: null })
  })

  it('never lets a new report overwrite typed text', () => {
    expect(shownDraft({ text: 'Mine', seed: first.text }, second)).toEqual({ text: 'Mine', from: null })
  })

  it('follows a new report while the old one is untouched', () => {
    expect(shownDraft({ text: first.text, seed: first.text }, second)).toEqual({ text: second.text, from: 'report' })
  })

  it('stays clear once cleared, until the agent reports again', () => {
    expect(shownDraft({ text: '', seed: first.text }, first)).toEqual({ text: '', from: null })
    expect(shownDraft({ text: '', seed: first.text }, second)).toEqual({ text: second.text, from: 'report' })
  })
})

// Reading another worktree's diff is not abandoning the message typed for this one.
it('keeps each worktree’s draft to itself', () => {
  useCommitDrafts.getState().setDraft('wt-a', { text: 'fix the parser', seed: null })
  useCommitDrafts.getState().setDraft('wt-b', { text: 'bump the relay', seed: null })
  expect(useCommitDrafts.getState().drafts['wt-a']?.text).toBe('fix the parser')
  expect(useCommitDrafts.getState().drafts['wt-b']?.text).toBe('bump the relay')
})
