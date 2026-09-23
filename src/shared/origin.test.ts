// The one grammar for what an `origin` may be. Half of this is paths: every
// fold that could merge two directories is shown not to happen.

import { mkdtemp, rm, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkOrigin, checkTransport, normaliseRemote, pathIdentityNote } from './origin'

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

describe('a repository shared over a path', () => {
  // The promise, and the whole of it.
  it('is one project when both Macs reach it at the same path', () => {
    expect(normaliseRemote('/Volumes/team/app.git')).toBe('/Volumes/team/app.git')
    expect(normaliseRemote('file:///Volumes/team/app.git')).toBe('/Volumes/team/app.git')
    expect(normaliseRemote('file://localhost/Volumes/team/app.git')).toBe('/Volumes/team/app.git')
  })

  // The limit: these two hold one repository and teamree cannot tell.
  it('is two projects when the same volume is mounted at two paths', () => {
    expect(normaliseRemote('/Volumes/team/app.git')).not.toBe(normaliseRemote('/Users/ada/mnt/team/app.git'))
  })

  it('folds the spellings that name the same directory on every filesystem', () => {
    for (const spelling of [
      '/Volumes/team/app.git/',
      '/Volumes/team/app.git///',
      '//Volumes//team/app.git',
      '/Volumes/./team/app.git'
    ]) {
      expect(normaliseRemote(spelling), spelling).toBe('/Volumes/team/app.git')
    }
  })

  it('reads the escapes in a file:// URL, so a volume with a space in its name works', () => {
    expect(normaliseRemote('file:///Volumes/team%20share/app.git')).toBe('/Volumes/team share/app.git')
    expect(normaliseRemote('/Volumes/team share/app.git')).toBe('/Volumes/team share/app.git')
  })

  it('accepts a space in a path while still refusing one in a URL', () => {
    expect(checkOrigin('/Volumes/team share/app.git').ok).toBe(true)
    expect(checkOrigin('https://example.com/a repo')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no spaces/)
    })
  })

  it('keeps a trailing .git, because on a disk that is a different directory', () => {
    expect(normaliseRemote('/Volumes/team/app.git')).not.toBe(normaliseRemote('/Volumes/team/app'))
  })

  // Two teams becoming one is worse than two teammates not meeting.
  it('keeps case, because a case-sensitive volume can hold both spellings', () => {
    expect(normaliseRemote('/Volumes/team/App.git')).toBe('/Volumes/team/App.git')
    expect(normaliseRemote('/Volumes/team/App.git')).not.toBe(normaliseRemote('/Volumes/team/app.git'))
  })

  it('keeps two repositories on one volume apart', () => {
    expect(normaliseRemote('/Volumes/team/app.git')).not.toBe(normaliseRemote('/Volumes/team/other.git'))
  })

  // The teammate's Mac has no such link to resolve.
  it('does not follow a symlink, so a link and its target are two spellings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'teamree-origin-'))
    try {
      await mkdir(join(root, 'repo.git'))
      await symlink(join(root, 'repo.git'), join(root, 'link.git'))
      expect(normaliseRemote(join(root, 'link.git'))).toBe(join(root, 'link.git'))
      expect(normaliseRemote(join(root, 'link.git'))).not.toBe(normaliseRemote(join(root, 'repo.git')))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a .. segment rather than folding one, however it is written', () => {
    for (const spelling of [
      '/Volumes/team/../team/app.git',
      'file:///Volumes/team/../team/app.git',
      'file:///Volumes/team/%2e%2e/team/app.git'
    ]) {
      expect(checkOrigin(spelling), spelling).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/\.\. segment/)
      })
    }
  })

  it('reads a name that merely begins with dots as a name', () => {
    expect(normaliseRemote('/Volumes/team/..hidden/app.git')).toBe('/Volumes/team/..hidden/app.git')
  })

  it('refuses a relative path, because it names a different directory on each machine', () => {
    for (const spelling of ['./app.git', '../app.git', 'team/app.git']) {
      expect(checkOrigin(spelling), spelling).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/relative path/)
      })
    }
  })

  it('refuses ~, because it is a different directory for every account', () => {
    expect(checkOrigin('~/shared/app.git')).toMatchObject({ ok: false, reason: expect.stringMatching(/not ~$/) })
    expect(checkOrigin('~ada/shared/app.git').ok).toBe(false)
  })

  it('refuses a file:// URL that names a host, because that is a machine and not a directory', () => {
    expect(checkOrigin('file://fileserver/team/app.git')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/names host fileserver/)
    })
  })

  it('refuses a control character, which nothing on a Mac is named with', () => {
    expect(checkOrigin('/Volumes/team/app\n.git')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/control character/)
    })
    expect(checkOrigin('file:///Volumes/team/app%0A.git')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/control character/)
    })
  })

  it('refuses the root of the disk, which is not a repository', () => {
    expect(checkOrigin('/')).toMatchObject({ ok: false, reason: expect.stringMatching(/root of the disk/) })
    expect(checkOrigin('file:///')).toMatchObject({ ok: false, reason: expect.stringMatching(/root of the disk/) })
  })

  it('refuses a drive letter rather than reading it as a host', () => {
    expect(checkOrigin('C:\\team\\app.git').ok).toBe(false)
    expect(checkOrigin('C:/team/app.git').ok).toBe(false)
  })
})

describe('telling a path from a URL', () => {
  it('reads a path that is shaped like a URL as a path', () => {
    expect(normaliseRemote('file:/Volumes/team/app.git')).toBe('/Volumes/team/app.git')
    expect(normaliseRemote('/Volumes/a:b/app.git')).toBe('/Volumes/a:b/app.git')
    expect(normaliseRemote('/Volumes/https:/github.com/ada/pager')).toBe('/Volumes/https:/github.com/ada/pager')
  })

  it('reads a URL that is shaped like a path as a URL', () => {
    expect(normaliseRemote('git@github.com:ada/pager.git')).toBe('github.com/ada/pager')
    expect(normaliseRemote('ssh://git@github.com/ada/pager.git')).toBe('github.com/ada/pager')
    expect(normaliseRemote('https://github.com/ada/pager.git')).toBe('github.com/ada/pager')
  })

  // A normalised URL is `host/path` with a non-empty host, so it never begins
  // with the slash every path begins with.
  it('puts every path in a namespace no URL can reach', () => {
    const urls = [
      'https://github.com/ada/pager.git',
      'git@github.com:ada/pager.git',
      'ssh://git@github.com:22/Volumes/team/app.git',
      'git://example.com//Volumes/team/app.git',
      'https://localhost/Volumes/team/app.git'
    ].map((remote) => normaliseRemote(remote))
    const paths = [
      '/Volumes/team/app.git',
      '/github.com/ada/pager.git',
      'file:///github.com/ada/pager',
      '/Volumes/team/app'
    ].map((remote) => normaliseRemote(remote))

    for (const url of urls) {
      expect(url, String(url)).toBeDefined()
      expect(url!.startsWith('/'), String(url)).toBe(false)
    }
    for (const path of paths) {
      expect(path, String(path)).toBeDefined()
      expect(path!.startsWith('/'), String(path)).toBe(true)
    }
    // Two sets, not one list: two of the URLs above are deliberately one repository.
    const fromUrls = new Set(urls)
    expect(paths.filter((path) => fromUrls.has(path))).toEqual([])
  })
})

describe('whether a typed origin can be used', () => {
  it('accepts the forms people actually clone with', () => {
    expect(checkOrigin(' https://github.com/ada/pager.git ')).toEqual({
      ok: true,
      kind: 'url',
      remote: 'https://github.com/ada/pager.git',
      normalised: 'github.com/ada/pager'
    })
    expect(checkOrigin('git@gitlab.example:team/pager.git').ok).toBe(true)
  })

  // So `git remote -v` and the hashed string are the same characters.
  it('hands git the normalised path, and a URL exactly as it was typed', () => {
    expect(checkOrigin(' file:///Volumes/team/app.git/ ')).toEqual({
      ok: true,
      kind: 'path',
      remote: '/Volumes/team/app.git',
      normalised: '/Volumes/team/app.git'
    })
    expect(checkOrigin('ssh://git@github.com:22/ada/pager/')).toMatchObject({
      remote: 'ssh://git@github.com:22/ada/pager/'
    })
  })

  it('refuses an empty field by asking for the URL rather than scolding', () => {
    expect(checkOrigin('  ')).toEqual({
      ok: false,
      reason: 'no URL or path'
    })
  })

  it('refuses something with a space in it before git has to', () => {
    expect(checkOrigin('https://example.com/a repo')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no spaces/)
    })
  })

  it('says what a word that is neither could have been', () => {
    expect(checkOrigin('pager')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/or a path starting with \//)
    })
  })
})

describe('the transports teamree hands git', () => {
  // `ext::<command>` runs what it is given. Not a hole that ran anything (git
  // refuses `ext` unless `protocol.ext.allow` says otherwise), but that refusal
  // is another program's default that nothing here can read.
  it('refuses the helper syntax that names a program rather than a place', () => {
    for (const spelling of ['ext::bash', 'ext::sh -c id', 'EXT::bash', 'hg::https://hg.example/api']) {
      expect(checkOrigin(spelling), spelling).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/not [\w+.-]+(::|:\/\/)$/i)
      })
    }
    expect(normaliseRemote('ext::bash')).toBeUndefined()
  })

  // A refusal that named the space would send somebody off to delete it.
  it('says the transport is wrong rather than the spacing', () => {
    const checked = checkOrigin('ext::sh -c id')
    expect(checked).toMatchObject({ ok: false, reason: expect.stringMatching(/not ext::$/) })
    expect(checked.ok === false && checked.reason).not.toMatch(/no spaces/)
  })

  // An allowlist: an unknown scheme sends git looking for `git-remote-<scheme>`.
  it('refuses a scheme it does not mean to hand git, whatever the scheme is', () => {
    for (const spelling of ['ftp://example.com/api.git', 'rsync://example.com/api.git', 'made-up://example.com/api']) {
      expect(checkOrigin(spelling), spelling).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/not [\w+.-]+(::|:\/\/)$/i)
      })
    }
  })

  // `https::x` is not https.
  it('does not let an allowed name in the helper spelling through', () => {
    expect(checkOrigin('https::evil')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not [\w+.-]+(::|:\/\/)$/i)
    })
  })

  // Protects against the one above: `gitlab.example:team/api.git` is scp-style
  // with no user and reads as a scheme to anything matching on the first colon.
  it('still accepts every form people actually clone with', () => {
    for (const remote of [
      'https://github.com/acme/api.git',
      'https://ada@github.com/acme/api.git',
      'HTTPS://GitHub.com/acme/api.git',
      'http://git.internal/acme/api.git',
      'ssh://git@github.com/acme/api.git',
      'ssh://git@github.com:22/acme/api/',
      'git://example.com/acme/api.git',
      'git@github.com:acme/api.git',
      'gitlab.example:team/api.git',
      '/Volumes/team/api.git',
      '/Volumes/team share/api.git',
      '/Volumes/a:b/api.git',
      'file:///Volumes/team/api.git',
      'file:/Volumes/team/api.git'
    ]) {
      expect(checkOrigin(remote), remote).toMatchObject({ ok: true })
    }
  })

  // `checkCloneable` asks this of a raw config remote, which can be a `file:` URL.
  it('answers for a remote nothing has read as an origin first', () => {
    expect(checkTransport('file:///Volumes/team/api.git')).toEqual({ ok: true })
    expect(checkTransport('  git@github.com:acme/api.git  ')).toEqual({ ok: true })
    expect(checkTransport('ext::bash')).toMatchObject({ ok: false })
  })
})

describe('the sentence a path team is given', () => {
  it('names the exact path and says what cannot be done for them', () => {
    const note = pathIdentityNote('/Volumes/team/app.git')
    expect(note).toContain('/Volumes/team/app.git')
    expect(note).toMatch(/character for character/)
    expect(note).toMatch(/two different paths is one repository/)
  })
})
