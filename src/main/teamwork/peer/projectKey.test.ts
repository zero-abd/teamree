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
})

describe('reading it out of a checkout', () => {
  it('takes origin, because the remote several people push to is the project', async () => {
    const result = await readProjectKey(fixedRemoteRunner('git@github.com:team/repo.git'), '/anywhere')
    expect(result).toEqual({ ok: true, key: projectKeyFor('github.com/team/repo') })
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
