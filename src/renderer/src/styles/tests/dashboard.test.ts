// All Panes' pins.

import { describe, expect, it } from 'vitest'
import { declarationOf, findRule, parse, ruleFor } from './css'

const SHEET = 'dashboard.css'

describe('dashboard.css', () => {
  it('draws no head or close of its own; the page frame does', () => {
    expect(findRule(SHEET, '.board__head')).toBeUndefined()
    expect(findRule(SHEET, '.board__close')).toBeUndefined()
  })

  // Answering is the most urgent thing on the row; under the pointer only, it also covered the question.
  it('draws a row’s answers at rest, in flow, never over the question', () => {
    const hiding: string[] = []
    parse(SHEET).walkRules((rule) => {
      if (!rule.selectors.some((each) => each.includes('.board-item__answers'))) return
      rule.walkDecls((decl) => {
        if (/^(visibility|opacity|display|position)$/.test(decl.prop) && /hidden|^0$|none|absolute/.test(decl.value))
          hiding.push(`${rule.selector} { ${decl.prop}: ${decl.value} }`)
      })
    })
    expect(hiding).toEqual([])
  })

  // A summary to read, not code: the row's own face and ink.
  it('sets a pane’s last line in the UI face at 12px, in secondary ink', () => {
    const evidence = ruleFor(SHEET, '.board-row__evidence')
    expect(declarationOf(evidence, 'font-family')).toBeUndefined()
    expect(declarationOf(evidence, 'font-size')).toBe('var(--text-sm)')
    expect(declarationOf(evidence, 'color')).toBe('var(--fg-secondary)')
  })

  it('names no stage or state in upper case', () => {
    expect(declarationOf(ruleFor(SHEET, '.task-head'), 'text-transform')).toBeUndefined()
  })
})
