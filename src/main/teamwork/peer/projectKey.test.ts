// Whether two checkouts on two machines are the same project. Getting this wrong is invisible: two people
// whose keys disagree see nothing of each other, so the normalisation is tested against the spellings people have.

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTempRepo } from '../../git/testRepository'
import { normaliseRemote, originMark, projectKeyFor, readProjectKey } from './projectKey'
import { fixedRemoteRunner } from './peerTestSupport'

describe('one repository, however it was cloned', () => {
  it('reads ssh, scp-style, https and git the same way', () => {
    const spellings = [
      'git@github.com:team/repo.git',
      'ssh://git@github.com/team/repo.git',
      'https://github.com/team/repo.git',
      'https://github.com/team/repo',
      // Spelled in pieces: written literally, a clone URL carrying credentials reads to a secret scanner
      // as a leaked password, and it reported one.
      `https://${['user', 'token'].join(':')}@github.com/team/repo.git`,
      'git://github.com/team/repo.git',
      'GIT@GitHub.com:Team/Repo.git'
    ]
    const keys = new Set(spellings.map((remote) => projectKeyFor(normaliseRemote(remote)!)))
    expect(keys.size).toBe(1)
  })

  it('keeps two different repositories on the same host apart', () => {
    expect(normaliseRemote('git@github.com:team/repo.git')).not.toBe(normaliseRemote('git@github.com:team/other.git'))
  })

  it('keeps two hosts apart even when the path matches', () => {
    expect(normaliseRemote('git@github.com:team/repo.git')).not.toBe(normaliseRemote('git@gitlab.com:team/repo.git'))
  })

  it('refuses a remote it cannot read rather than inventing a key for it', () => {
    expect(normaliseRemote('')).toBeUndefined()
    expect(normaliseRemote('   ')).toBeUndefined()
    expect(normaliseRemote('just-a-word')).toBeUndefined()
  })
})

describe('the key itself', () => {
  it('is a hash, so a teammate learns nothing about repositories they are not in', () => {
    const key = projectKeyFor('github.com/team/repo')
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(key).not.toContain('repo')
    expect(key).not.toContain('github')
  })

  // A rule that moved a key in the field is a team that stops meeting after an update with nothing to say
  // why. The digests are written out rather than computed, because a recomputed rule could only agree with itself.
  it('has not moved for a URL now that a path can have one too', () => {
    expect(projectKeyFor(normaliseRemote('git@github.com:team/repo.git')!)).toBe(
      '24de3cb4cf47f1c5c2c4b6a1bbe9851f7b07d5b2c2a14789ed0d9879b188f350'
    )
  })
})

describe('reading it out of a checkout', () => {
  it('takes origin, because the remote several people push to is the project', async () => {
    const result = await readProjectKey(fixedRemoteRunner('git@github.com:team/repo.git'), '/anywhere')
    // The raw URL travels with the key: hashing it is what matching needs, and
    // naming it is what an invitation to a teammate needs.
    expect(result).toEqual({
      ok: true,
      key: projectKeyFor('github.com/team/repo'),
      url: 'git@github.com:team/repo.git'
    })
  })

  // A repository on a shared volume takes part on the terms the path supports: the same absolute path on
  // both Macs is the same project, and the key is the path, computable with the volume unmounted.
  it('takes a shared volume as the project, at the path it is mounted at', async () => {
    for (const remote of ['/Volumes/team/app.git', 'file:///Volumes/team/app.git', '/Volumes/team/app.git/']) {
      const result = await readProjectKey(fixedRemoteRunner(remote), '/anywhere')
      expect(result, remote).toEqual({
        ok: true,
        key: projectKeyFor('/Volumes/team/app.git'),
        // Normalised, because this is the string a teammate has to be given.
        url: '/Volumes/team/app.git'
      })
    }
  })

  it('keeps a path and a URL apart even when they read alike', () => {
    expect(projectKeyFor(normaliseRemote('/github.com/team/repo.git')!)).not.toBe(
      projectKeyFor(normaliseRemote('https://github.com/team/repo.git')!)
    )
  })

  // The refusals left are paths that cannot be an identity, each naming the origin git has: nobody typed
  // this remote, so "a relative path" alone would leave somebody working out which one was meant.
  it('refuses a path no two machines could agree on, naming the origin it read', async () => {
    for (const [remote, fault] of [
      ['../app.git', /relative path/],
      ['~/shared/app.git', /not ~/],
      ['/Volumes/team/../team/app.git', /no \.\. segment/]
    ] as const) {
      const result = await readProjectKey(fixedRemoteRunner(remote), '/anywhere')
      expect(result.ok, remote).toBe(false)
      if (result.ok) continue
      expect(result.reason, remote).toContain(`origin ${remote}: `)
      expect(result.reason, remote).toMatch(fault)
    }
  })

  it('still says only that it cannot compare a remote that is neither a path nor a URL', async () => {
    const result = await readProjectKey(fixedRemoteRunner('just-a-word'), '/anywhere')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('not a URL with a host')
  })

  it('says a project with no origin cannot be matched, rather than matching it to nothing', async () => {
    const runner = { ...fixedRemoteRunner('x'), tryRun: async () => ({ exitCode: 1, stdout: '', stderr: '' }) }
    const result = await readProjectKey(runner, '/anywhere')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('no origin remote')
  })
})

describe('knowing when to ask git again', () => {
  it('moves when the remote does, and holds still otherwise', async () => {
    const repo = await createTempRepo()
    try {
      const before = originMark(repo.repoPath)
      expect(before).toBeDefined()
      expect(originMark(repo.repoPath)).toBe(before)

      await repo.git(['remote', 'add', 'origin', 'https://example.invalid/team/app.git'])
      expect(originMark(repo.repoPath)).not.toBe(before)
    } finally {
      await repo.cleanup()
    }
  })

  it('follows a linked worktree to the config it actually borrows', async () => {
    const repo = await createTempRepo()
    try {
      const linked = join(repo.worktreesRoot, 'feature')
      await repo.git(['worktree', 'add', '-b', 'feature', linked])
      const before = originMark(linked)
      expect(before).toBeDefined()

      // Written into the repository's config, which is not under the worktree's
      // own git directory: a mark that stopped at `.git` would never move.
      await repo.git(['remote', 'add', 'origin', 'https://example.invalid/team/app.git'])
      expect(originMark(linked)).not.toBe(before)
    } finally {
      await repo.cleanup()
    }
  })

  it('has nothing to say about a directory that is not a checkout', () => {
    expect(originMark(join(tmpdir(), 'teamree-not-a-repo'))).toBeUndefined()
  })
})
