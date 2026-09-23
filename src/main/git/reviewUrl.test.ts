// Every remote URL shape git accepts, against every forge recognised, and the two answers that are nothing.

import { describe, expect, it } from 'vitest'
import { reviewUrl } from './reviewUrl'

const COMPARE = 'https://github.com/o/r/compare/main...work?expand=1'

describe('the review page for a branch that was just pushed', () => {
  // The three spellings of one GitHub repository; scp-like is what the clone button hands out.
  it('reads GitHub out of every URL shape git accepts for a remote', () => {
    for (const remoteUrl of [
      'git@github.com:o/r.git',
      'git@github.com:o/r',
      'https://github.com/o/r.git',
      'https://github.com/o/r',
      'ssh://git@github.com/o/r.git',
      'ssh://git@github.com:22/o/r.git',
      'https://github.com/o/r/'
    ]) {
      expect(reviewUrl({ remoteUrl, branch: 'work', baseRef: 'main' }), remoteUrl).toBe(COMPARE)
    }
  })

  it('opens the form rather than the diff', () => {
    expect(reviewUrl({ remoteUrl: 'git@github.com:o/r.git', branch: 'work', baseRef: 'main' })).toContain('expand=1')
  })

  // The forge has never heard of the name this machine calls the remote by.
  it('strips the remote and refs/heads from the base ref', () => {
    expect(reviewUrl({ remoteUrl: 'git@github.com:o/r.git', branch: 'work', baseRef: 'origin/main' })).toBe(COMPARE)
    expect(reviewUrl({ remoteUrl: 'git@github.com:o/r.git', branch: 'work', baseRef: 'refs/heads/main' })).toBe(COMPARE)
    expect(
      reviewUrl({ remoteUrl: 'git@github.com:o/r.git', branch: 'work', baseRef: 'upstream/main', remote: 'upstream' })
    ).toBe(COMPARE)
    // A remote called something else does not strip origin's name off a branch that begins with it.
    expect(
      reviewUrl({ remoteUrl: 'git@github.com:o/r.git', branch: 'work', baseRef: 'origin/main', remote: 'upstream' })
    ).toBe('https://github.com/o/r/compare/origin%2Fmain...work?expand=1')
  })

  // `feature/#3` is a legal branch name and a URL that ends early.
  it('encodes every ref it puts in a URL', () => {
    expect(reviewUrl({ remoteUrl: 'git@github.com:o/r.git', branch: 'feature/#3 x', baseRef: 'main' })).toBe(
      'https://github.com/o/r/compare/main...feature%2F%233%20x?expand=1'
    )
    expect(reviewUrl({ remoteUrl: 'git@gitlab.com:o/r.git', branch: 'a&b', baseRef: 'main' })).toContain(
      'source_branch]=a%26b'
    )
  })

  it('points GitLab at a new merge request, cloud and self-managed alike', () => {
    expect(reviewUrl({ remoteUrl: 'git@gitlab.com:group/sub/r.git', branch: 'work', baseRef: 'main' })).toBe(
      'https://gitlab.com/group/sub/r/-/merge_requests/new' +
        '?merge_request[source_branch]=work&merge_request[target_branch]=main'
    )
    expect(reviewUrl({ remoteUrl: 'https://gitlab.acme.example/o/r.git', branch: 'work', baseRef: 'main' })).toBe(
      'https://gitlab.acme.example/o/r/-/merge_requests/new' +
        '?merge_request[source_branch]=work&merge_request[target_branch]=main'
    )
  })

  it('points Bitbucket cloud at a new pull request', () => {
    expect(reviewUrl({ remoteUrl: 'git@bitbucket.org:o/r.git', branch: 'work', baseRef: 'main' })).toBe(
      'https://bitbucket.org/o/r/pull-requests/new?source=work&dest=main'
    )
  })

  // A wrong page looks like an answer, which is worse than no button at all.
  it('says nothing about a host it does not recognise', () => {
    for (const remoteUrl of [
      'git@git.acme.example:o/r.git',
      'https://git.acme.example/o/r.git',
      'https://bitbucket.acme.example/scm/o/r.git',
      'https://github.com/r',
      '/srv/git/r.git',
      'file:///srv/git/r.git',
      'not a url at all',
      ''
    ]) {
      expect(reviewUrl({ remoteUrl, branch: 'work', baseRef: 'main' }), remoteUrl).toBeUndefined()
    }
  })

  // There is no review to open for a branch against itself.
  it('says nothing when the branch that was pushed is the base', () => {
    expect(reviewUrl({ remoteUrl: 'git@github.com:o/r.git', branch: 'main', baseRef: 'main' })).toBeUndefined()
    expect(reviewUrl({ remoteUrl: 'git@github.com:o/r.git', branch: 'main', baseRef: 'origin/main' })).toBeUndefined()
    expect(reviewUrl({ remoteUrl: 'git@github.com:o/r.git', branch: 'main', baseRef: '' })).toBeUndefined()
  })
})
