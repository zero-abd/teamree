// The one grammar for what an `origin` may be.
//
// It is shared because the panel refuses in the field while somebody is still
// typing and the runtime refuses before git is run, and two spellings of one
// rule is how a user gets told two different things about one URL.

import { describe, expect, it } from 'vitest'
import { checkOriginUrl, normaliseRemote } from './originUrl'

describe('normalising a remote', () => {
  it('makes ssh and https spellings of one repository agree', () => {
    expect(normaliseRemote('https://github.com/Ada/Pager.git')).toBe('github.com/ada/pager')
    expect(normaliseRemote('git@github.com:ada/pager.git')).toBe('github.com/ada/pager')
    expect(normaliseRemote('ssh://git@github.com:22/ada/pager/')).toBe('github.com/ada/pager')
  })

  it('has no answer for something with no host or no path', () => {
    expect(normaliseRemote('')).toBeUndefined()
    expect(normaliseRemote('https://github.com')).toBeUndefined()
    expect(normaliseRemote('pager')).toBeUndefined()
  })
})

describe('whether a typed origin can be used', () => {
  it('accepts the forms people actually clone with', () => {
    expect(checkOriginUrl(' https://github.com/ada/pager.git ')).toEqual({
      ok: true,
      url: 'https://github.com/ada/pager.git',
      normalised: 'github.com/ada/pager'
    })
    expect(checkOriginUrl('git@gitlab.example:team/pager.git').ok).toBe(true)
  })

  // The mistake somebody will actually make, and the reason it gets its own
  // sentence: a path is a perfectly good git remote and a useless project
  // identity, because nobody else can clone it.
  it('names a path as a path rather than as "not a URL"', () => {
    for (const path of ['/Users/ada/code/pager', './pager', '../pager', '~/code/pager', 'file:///srv/pager']) {
      const refused = checkOriginUrl(path)
      expect(refused.ok, path).toBe(false)
      expect(refused).toMatchObject({ reason: expect.stringMatching(/path on this disk/) })
    }
  })

  it('refuses an empty field by asking for the URL rather than scolding', () => {
    expect(checkOriginUrl('  ')).toEqual({ ok: false, reason: 'type the URL you and your teammates both cloned' })
  })

  it('refuses something with a space in it before git has to', () => {
    expect(checkOriginUrl('https://example.com/a repo')).toMatchObject({ ok: false, reason: /no spaces/ })
  })
})
