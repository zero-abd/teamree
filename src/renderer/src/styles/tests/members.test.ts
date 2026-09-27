// Teamwork's pins.

import { describe, expect, it } from 'vitest'
import { declarationOf, findRule, parse, ruleFor } from './css'

describe('members.css', () => {
  it('draws no head or column of its own; the page frame does', () => {
    expect(findRule('members.css', '.teamwork-view__head')).toBeUndefined()
    expect(findRule('members.css', '.teamwork-view__column')).toBeUndefined()
  })

  // Two columns: what needs you and who is here, then what happened beside them.
  it('lays the home in a main column and a narrower side column, one column when narrow', () => {
    const columns: string[] = []
    parse('members.css').walkRules('.team-home__grid', (rule) => {
      columns.push(`${rule.parent?.type}: ${declarationOf(rule, 'grid-template-columns')}`)
    })
    expect(columns).toEqual(['root: minmax(0, 1fr) 280px', 'atrule: minmax(0, 1fr)'])
  })

  // An ask is the one card with an edge, inset and amber, never a fill.
  it('marks an asking card by its amber inset edge only', () => {
    const asking = ruleFor('members.css', '.home-card--asking')
    expect(declarationOf(asking, 'box-shadow')).toContain('inset 2px 0 var(--warning)')
    expect(declarationOf(asking, 'background')).toBeUndefined()
  })

  it('keeps a shared note’s actions out of sight until its row is hovered or focused', () => {
    expect(declarationOf(ruleFor('members.css', '.shared-notes__line .button'), 'opacity')).toBe(
      'var(--row-action-rest)'
    )
  })
})
