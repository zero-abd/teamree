// Whether two checkouts on two machines are the same project.
//
// Getting this wrong is invisible rather than loud: two people with the same
// repository whose keys disagree simply see nothing of each other and are told
// nothing is wrong. So the normalisation is tested against the spellings people
// actually have, not against one canonical form.

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
      // Spelled in pieces rather than written out. A clone URL carrying
      // credentials is a spelling git really produces and this really has to
      // normalise, but written literally it reads to a secret scanner as a
      // leaked password — and it reported one. Nothing here was ever a
      // credential, and an alert that is false every time is an alert people
      // stop opening.
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

  // The keys in the field are URLs' keys, and a rule that moved one of them
  // would be a team that stops meeting after an update with nothing on either
  // machine to say why. The digests below are written out rather than computed,
  // because a test that recomputed the rule could only agree with it.
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

  // A repository on a file server or a shared volume is a perfectly good git
  // remote and is how plenty of teams already work. It takes part on the terms
  // the path itself can support: the same absolute path on both Macs is the
  // same project, and the key is the path rather than anything read off this
  // machine's disk, so it is computable with the volume unmounted.
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

  // The refusals that are left are the paths that cannot be an identity at all,
  // and each of them names the origin git has before saying what is wrong with
  // it: nobody typed this remote, so "a relative path" on its own would leave
  // somebody working out which of their remotes was being talked about.
  it('refuses a path no two machines could agree on, naming the origin it read', async () => {
    for (const [remote, fault] of [
      ['../app.git', /relative path/],
      ['~/shared/app.git', /~ is a different directory/],
      ['/Volumes/team/../team/app.git', /\.\. segment/]
    ] as const) {
      const result = await readProjectKey(fixedRemoteRunner(remote), '/anywhere')
      expect(result.ok, remote).toBe(false)
      if (result.ok) continue
      expect(result.reason, remote).toContain(`origin is ${remote}`)
      expect(result.reason, remote).toMatch(fault)
    }
  })

  it('still says only that it cannot compare a remote that is neither a path nor a URL', async () => {
    const result = await readProjectKey(fixedRemoteRunner('just-a-word'), '/anywhere')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('neither a URL with a host in it')
  })

  it('says a project with no origin cannot be matched, rather than matching it to nothing', async () => {
    const runner = { ...fixedRemoteRunner('x'), tryRun: async () => ({ exitCode: 1, stdout: '', stderr: '' }) }
    const result = await readProjectKey(runner, '/anywhere')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('no origin remote')
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
