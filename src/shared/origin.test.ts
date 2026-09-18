// The one grammar for what an `origin` may be.
//
// It is shared because the panel refuses in the field while somebody is still
// typing and the runtime refuses before git is run, and two spellings of one
// rule is how a user gets told two different things about one URL.
//
// Half of what is below is about paths, and all of that half is about one
// thing: a path is an identity only to the extent that two people spell it the
// same way, so every fold that could quietly merge two directories has to be
// shown not to happen, and every fold that is safe has to be shown to happen.

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
  // The promise, and the whole of it: the same path on both Macs is one
  // project. Everything else in this block is a consequence of it.
  it('is one project when both Macs reach it at the same path', () => {
    expect(normaliseRemote('/Volumes/team/app.git')).toBe('/Volumes/team/app.git')
    expect(normaliseRemote('file:///Volumes/team/app.git')).toBe('/Volumes/team/app.git')
    expect(normaliseRemote('file://localhost/Volumes/team/app.git')).toBe('/Volumes/team/app.git')
  })

  // The limit, stated as a test so that nobody reads the feature as more than
  // it is: these two people are holding one repository and teamree cannot tell.
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

  // A space is a typing mistake in a URL and an ordinary character in the name
  // of a volume, so the rule about them cannot be the same rule.
  it('accepts a space in a path while still refusing one in a URL', () => {
    expect(checkOrigin('/Volumes/team share/app.git').ok).toBe(true)
    expect(checkOrigin('https://example.com/a repo')).toMatchObject({ ok: false, reason: /no spaces/ })
  })

  // On a hosting service `…/app` and `…/app.git` are one repository. On a disk
  // they are two directories, and a bare repository beside a working checkout
  // is exactly how somebody lays this out.
  it('keeps a trailing .git, because on a disk that is a different directory', () => {
    expect(normaliseRemote('/Volumes/team/app.git')).not.toBe(normaliseRemote('/Volumes/team/app'))
  })

  // macOS volumes are usually case-insensitive and are not always. Folding case
  // would merge two repositories on a case-sensitive one, and two teams
  // becoming one is worse than two teammates not meeting.
  it('keeps case, because a case-sensitive volume can hold both spellings', () => {
    expect(normaliseRemote('/Volumes/team/App.git')).toBe('/Volumes/team/App.git')
    expect(normaliseRemote('/Volumes/team/App.git')).not.toBe(normaliseRemote('/Volumes/team/app.git'))
  })

  it('keeps two repositories on one volume apart', () => {
    expect(normaliseRemote('/Volumes/team/app.git')).not.toBe(normaliseRemote('/Volumes/team/other.git'))
  })

  // Resolving it would make the identity a fact about this Mac's disk rather
  // than about the string both people were given — and the teammate's Mac has
  // no such link to resolve.
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
      expect(checkOrigin(spelling), spelling).toMatchObject({ ok: false, reason: /\.\. segment/ })
    }
  })

  it('reads a name that merely begins with dots as a name', () => {
    expect(normaliseRemote('/Volumes/team/..hidden/app.git')).toBe('/Volumes/team/..hidden/app.git')
  })

  it('refuses a relative path, because it names a different directory on each machine', () => {
    for (const spelling of ['./app.git', '../app.git', 'team/app.git']) {
      expect(checkOrigin(spelling), spelling).toMatchObject({ ok: false, reason: /relative path/ })
    }
  })

  it('refuses ~, because it is a different directory for every account', () => {
    expect(checkOrigin('~/shared/app.git')).toMatchObject({ ok: false, reason: /~ is a different directory/ })
    expect(checkOrigin('~ada/shared/app.git').ok).toBe(false)
  })

  it('refuses a file:// URL that names a host, because that is a machine and not a directory', () => {
    expect(checkOrigin('file://fileserver/team/app.git')).toMatchObject({ ok: false, reason: /names a machine/ })
  })

  it('refuses a control character, which nothing on a Mac is named with', () => {
    expect(checkOrigin('/Volumes/team/app\n.git')).toMatchObject({ ok: false, reason: /control character/ })
    expect(checkOrigin('file:///Volumes/team/app%0A.git')).toMatchObject({ ok: false, reason: /control character/ })
  })

  it('refuses the root of the disk, which is not a repository', () => {
    expect(checkOrigin('/')).toMatchObject({ ok: false, reason: /root of the disk/ })
    expect(checkOrigin('file:///')).toMatchObject({ ok: false, reason: /root of the disk/ })
  })

  // A drive letter is not a path on this Mac, and read as a URL it would be a
  // host called `c`. It is refused as the directory it was meant to be.
  it('refuses a drive letter rather than reading it as a host', () => {
    expect(checkOrigin('C:\\team\\app.git').ok).toBe(false)
    expect(checkOrigin('C:/team/app.git').ok).toBe(false)
  })
})

describe('telling a path from a URL', () => {
  // `file:/srv/app` has a scheme and one slash, and `/Volumes/a:b` has a colon
  // in it. Read as URLs they would be identities naming hosts nobody has.
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

  // The namespace, and the reason there is one: a normalised URL is
  // `host/path`, and a host is never empty, so a URL can never begin with the
  // slash every path begins with. No path and no URL can therefore be hashed
  // to the same key, whatever either of them is called.
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
    // Compared as two sets rather than as one list: two of the URLs above are
    // deliberately the same repository, and it is the overlap between the
    // groups that has to be empty.
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

  // git is given the normalised spelling rather than the typed one, so that
  // `git remote -v` and the string teamree hashes are the same characters.
  // There is nothing to fold in a URL that is not somebody's own choice of
  // scheme, so a URL is passed through exactly as it was typed.
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
      reason: 'type the URL you both cloned, or the path the repository is mounted at on both Macs'
    })
  })

  it('refuses something with a space in it before git has to', () => {
    expect(checkOrigin('https://example.com/a repo')).toMatchObject({ ok: false, reason: /no spaces/ })
  })

  it('says what a word that is neither could have been', () => {
    expect(checkOrigin('pager')).toMatchObject({ ok: false, reason: /nor a path starting with \// })
  })
})

describe('the transports teamree hands git', () => {
  // The test this change exists for. `ext::<command>` is git's remote-helper
  // syntax and the helper it names runs what it is given, so a string of that
  // shape is a program and not a place. It used to read as a URL here — host
  // `ext`, path `:bash` — which made it an identity teamree would write into
  // somebody's `.git/config` with `teamwork.setOrigin`.
  //
  // What it was not, and what nothing here should claim, is a hole that ran
  // anything: git refuses the `ext` transport unless `protocol.ext.allow` says
  // otherwise and that is unset on a stock install. The point is that the
  // refusal was somebody else's default, in another program, that nothing in
  // this process can read.
  it('refuses the helper syntax that names a program rather than a place', () => {
    for (const spelling of ['ext::bash', 'ext::sh -c id', 'EXT::bash', 'hg::https://hg.example/api']) {
      expect(checkOrigin(spelling), spelling).toMatchObject({
        ok: false,
        reason: /is not a transport teamree hands git/
      })
    }
    expect(normaliseRemote('ext::bash')).toBeUndefined()
  })

  // Which is a different sentence from "that has a space in it", and the right
  // one: a space in `ext::sh -c id` is the least of what is wrong with it, and
  // a refusal that named the space would send somebody off to delete it.
  it('says the transport is wrong rather than the spacing', () => {
    const checked = checkOrigin('ext::sh -c id')
    expect(checked).toMatchObject({ ok: false, reason: /"ext" is not a transport/ })
    expect(checked.ok === false && checked.reason).not.toMatch(/no spaces/)
  })

  // An allowlist and not a list of the names known to be dangerous, because the
  // next helper is one nobody here has heard of: a scheme git has no transport
  // of its own for sends it looking for `git-remote-<scheme>`.
  it('refuses a scheme it does not mean to hand git, whatever the scheme is', () => {
    for (const spelling of ['ftp://example.com/api.git', 'rsync://example.com/api.git', 'made-up://example.com/api']) {
      expect(checkOrigin(spelling), spelling).toMatchObject({ ok: false, reason: /not a transport teamree hands git/ })
    }
  })

  // `::` is the helper spelling whichever name is in front of it, so a name
  // teamree does allow does not make one safe. `https::x` is not https.
  it('does not let an allowed name in the helper spelling through', () => {
    expect(checkOrigin('https::evil')).toMatchObject({ ok: false, reason: /not a transport teamree hands git/ })
  })

  // The test protecting everybody from the one above. Every one of these is a
  // remote two people cloning one repository really hold, and a transport rule
  // that refused any of them would be a worse bug than the one it closed —
  // `gitlab.example:team/api.git` especially, which is scp-style with no user
  // in it and reads as a scheme called `gitlab.example` to anything matching on
  // the first colon.
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

  // The same question asked on its own, because `checkCloneable` in
  // `src/cli/clone.ts` asks it of a remote read straight out of a checkout's
  // config — which has not been through `checkOrigin` and can be a `file:` URL.
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
