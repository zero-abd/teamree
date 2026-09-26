import { describe, expect, it } from 'vitest'
import { emptyProjectContext } from '../../shared/memory.js'
import { contextText } from './context.js'

describe('teamree context', () => {
  it('says so in one line when nothing overlaps, and prints nothing with --text', () => {
    expect(contextText(emptyProjectContext('w1'), false)).toBe('No overlap.')
    expect(contextText(emptyProjectContext('w1'), true)).toBe('')
  })

  it('prints the bundle, and what the budget cut', () => {
    const context = { ...emptyProjectContext('w1'), text: 'goal: x', truncated: [{ section: 'siblings', dropped: 2 }] }
    expect(contextText(context, false)).toBe('goal: x\n(cut: 2 siblings)')
    expect(contextText(context, true)).toBe('goal: x')
  })
})
