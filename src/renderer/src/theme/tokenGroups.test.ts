// The editor has to be able to reach every colour there is.
//
// A token the theme layer can produce and the editor does not list is a colour
// nobody can change and nobody is told about — the list simply has one fewer
// row than it should, which is not a thing anybody notices by looking. So the
// two lists are held to each other here, in both directions.

import { describe, expect, it } from 'vitest'
import { THEME_TOKENS } from '@shared/theme'
import { GROUPED_TOKENS, TOKEN_GROUPS, groupsCoverEveryToken } from './tokenGroups'

describe('the colour editor’s list', () => {
  it('reaches every token the theme layer has', () => {
    expect(groupsCoverEveryToken()).toBe(true)
    expect([...GROUPED_TOKENS].sort()).toEqual([...THEME_TOKENS].sort())
  })

  it('lists each of them exactly once', () => {
    expect(new Set(GROUPED_TOKENS).size).toBe(GROUPED_TOKENS.length)
  })

  // The whole reason the groups exist rather than one flat list: a hex field
  // labelled `--fg-secondary` tells you nothing, and the only way to find out
  // what it does is to change it and go looking.
  it('says what each colour is for, in terms of something on screen', () => {
    for (const group of TOKEN_GROUPS) {
      for (const { token, label, about } of group.tokens) {
        expect(label.length, token).toBeGreaterThan(2)
        expect(about.length, token).toBeGreaterThan(4)
        expect(about.endsWith('.'), `${token}: ${about}`).toBe(false)
      }
    }
  })
})
