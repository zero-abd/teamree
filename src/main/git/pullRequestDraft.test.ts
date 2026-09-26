import { describe, expect, it } from 'vitest'
import { commitOf, pullRequestDraft } from './pullRequestDraft'

describe('a pull request draft', () => {
  it('is the agent’s report first: its first line the title, the rest the body', () => {
    const draft = pullRequestDraft({
      report: 'Stop the login loop\n\nThe redirect kept its own URL.',
      name: 'Login loop',
      commits: [{ subject: 'wip', body: '' }]
    })
    expect(draft).toEqual({ title: 'Stop the login loop', body: 'The redirect kept its own URL.' })
  })

  it('is one commit’s subject and body', () => {
    const draft = pullRequestDraft({ name: 'Login loop', commits: [commitOf('Stop the loop\n\nIt redirected.')] })
    expect(draft).toEqual({ title: 'Stop the loop', body: 'It redirected.' })
  })

  it('lists several commits, oldest first, under the task’s first line', () => {
    const draft = pullRequestDraft({
      task: '\nMake checkout two steps\nand keep the cart',
      name: 'Two steps',
      commits: [
        { subject: 'First step', body: '' },
        { subject: 'Second step', body: 'why' }
      ]
    })
    expect(draft).toEqual({ title: 'Make checkout two steps', body: '- First step\n- Second step' })
  })

  it('falls back to the name, and closes the issue once, without its number in the title', () => {
    expect(pullRequestDraft({ name: 'Two steps', issue: 9, commits: [] })).toEqual({
      title: 'Two steps',
      body: 'Closes #9'
    })
    expect(
      pullRequestDraft({
        task: '#9 Fix the cart',
        name: 'Fix the cart',
        issue: 9,
        commits: [
          { subject: 'a', body: '' },
          { subject: 'b', body: '' }
        ]
      })
    ).toEqual({ title: 'Fix the cart', body: '- a\n- b\n\nCloses #9' })
    expect(pullRequestDraft({ name: 'x', issue: 9, commits: [commitOf('Fix it\n\nFixes #9')] }).body).toBe('Fixes #9')
  })
})
