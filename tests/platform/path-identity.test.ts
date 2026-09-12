// Path identity across the three filesystems we ship to.
//
// The pure helpers take a platform and a `node:path` flavour, so every case is
// exercised for win32, darwin and linux from whichever machine is running. The
// last block pins the behaviour of the real filesystem underneath, because the
// symlink and case rules are the part no amount of pure logic can assert.

import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  canonicalPath,
  isCaseInsensitivePlatform,
  isInside,
  isInsideKeys,
  pathKey,
  pathKeyOf,
  resolveThroughAncestors,
  samePath
} from '../../src/main/git/pathIdentity'

/** A filesystem that only knows which paths exist and where symlinks point. */
function fakeRealpath(links: Record<string, string>, existing: readonly string[]) {
  const known = new Set(existing)
  return (target: string): string => {
    const link = links[target]
    if (link !== undefined) return link
    if (!known.has(target)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return target
  }
}

const POSIX_PLATFORMS: NodeJS.Platform[] = ['darwin', 'linux']

describe('case sensitivity per platform', () => {
  it('folds case on Windows and macOS but not on Linux', () => {
    expect(isCaseInsensitivePlatform('win32')).toBe(true)
    expect(isCaseInsensitivePlatform('darwin')).toBe(true)
    expect(isCaseInsensitivePlatform('linux')).toBe(false)
  })

  it('makes a differently cased path the same key on Windows and macOS', () => {
    expect(pathKeyOf('C:\\Users\\Abd\\Work', 'win32', path.win32)).toBe(
      pathKeyOf('c:\\users\\abd\\work', 'win32', path.win32)
    )
    expect(pathKeyOf('/Users/Abd/Work', 'darwin', path.posix)).toBe(pathKeyOf('/users/abd/work', 'darwin', path.posix))
  })

  it('keeps two Linux paths that differ only in case apart', () => {
    expect(pathKeyOf('/home/abd/Work', 'linux', path.posix)).not.toBe(pathKeyOf('/home/abd/work', 'linux', path.posix))
  })

  it('normalizes separators and drops a trailing one without eating the root', () => {
    expect(pathKeyOf('C:\\work\\repo\\', 'win32', path.win32)).toBe('c:\\work\\repo')
    expect(pathKeyOf('C:/work/repo', 'win32', path.win32)).toBe('c:\\work\\repo')
    expect(pathKeyOf('C:\\', 'win32', path.win32)).toBe('c:\\')
    expect(pathKeyOf('/', 'linux', path.posix)).toBe('/')
    expect(pathKeyOf('/work/repo//', 'linux', path.posix)).toBe('/work/repo')
  })

  it('keeps a UNC share addressable', () => {
    expect(pathKeyOf('\\\\Server\\Share\\Repo', 'win32', path.win32)).toBe('\\\\server\\share\\repo')
    expect(isInsideKeys('\\\\server\\share\\repo', '\\\\server\\share\\repo\\wt', path.win32)).toBe(true)
    expect(isInsideKeys('\\\\server\\share\\repo', '\\\\other\\share\\repo\\wt', path.win32)).toBe(false)
  })
})

describe('resolveThroughAncestors', () => {
  // The defect: realpath fails outright on a leaf that is not on disk, so a
  // checkout we are about to create kept its unresolved spelling and compared
  // unequal to the very same path once git had made it.
  it('resolves a symlinked ancestor of a path that does not exist yet', () => {
    const realpath = fakeRealpath({ '/var': '/private/var' }, ['/', '/private/var'])
    expect(resolveThroughAncestors('/var/teamree/worktrees/proj/login', realpath, path.posix)).toBe(
      '/private/var/teamree/worktrees/proj/login'
    )
  })

  it('returns the resolved path untouched when every segment exists', () => {
    const realpath = fakeRealpath({ '/var/data': '/private/var/data' }, ['/'])
    expect(resolveThroughAncestors('/var/data', realpath, path.posix)).toBe('/private/var/data')
  })

  it('gives back the input when nothing on the way up can be resolved', () => {
    const realpath = fakeRealpath({}, [])
    expect(resolveThroughAncestors('/nowhere/at/all', realpath, path.posix)).toBe('/nowhere/at/all')
  })

  it('follows a junction under a Windows drive', () => {
    const realpath = fakeRealpath({ 'C:\\link': 'D:\\real' }, ['C:\\'])
    expect(resolveThroughAncestors('C:\\link\\proj\\wt', realpath, path.win32)).toBe('D:\\real\\proj\\wt')
  })
})

describe('isInsideKeys', () => {
  for (const [label, api, parent, inside, outside] of [
    ['posix', path.posix, '/root/worktrees', '/root/worktrees/proj/login', '/root/worktrees-other/proj'],
    ['win32', path.win32, 'c:\\root\\worktrees', 'c:\\root\\worktrees\\proj\\login', 'c:\\root\\other\\proj']
  ] as const) {
    it(`recognizes containment on ${label}`, () => {
      expect(isInsideKeys(parent, inside, api)).toBe(true)
      expect(isInsideKeys(parent, outside, api)).toBe(false)
      expect(isInsideKeys(parent, parent, api)).toBe(false)
      expect(isInsideKeys(parent, api.dirname(parent), api)).toBe(false)
    })
  }

  it('does not mistake a sibling starting with ".." for an escape', () => {
    expect(isInsideKeys('/root', '/root/..hidden', path.posix)).toBe(true)
  })
})

describe('the real filesystem underneath', () => {
  // Left in the OS temp dir: unlinking a tree that contains symlinks is riskier
  // than the few kilobytes it costs.
  const make = (prefix: string): string => mkdtempSync(path.join(tmpdir(), prefix))

  it('agrees with itself about a checkout that is not on disk yet', () => {
    const root = make('teamree-root-')
    const pending = path.join(root, 'project', 'branch')

    // On macOS `root` is under /var, which realpath moves to /private/var.
    expect(canonicalPath(pending).startsWith(canonicalPath(root))).toBe(true)
    expect(isInside(root, pending)).toBe(true)
    expect(isInside(root, path.join(path.dirname(root), 'elsewhere', 'branch'))).toBe(false)
  })

  it('resolves a symlinked worktrees root the same way for present and absent children', () => {
    const real = make('teamree-real-')
    const linkHome = make('teamree-link-')
    const link = path.join(linkHome, 'worktrees')
    // A directory junction is what Windows grants without elevation.
    symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir')

    const present = path.join(link, 'already-there')
    mkdirSync(present)
    const absent = path.join(link, 'not-yet')

    expect(samePath(present, path.join(real, 'already-there'))).toBe(true)
    expect(samePath(absent, path.join(real, 'not-yet'))).toBe(true)
    expect(isInside(real, absent)).toBe(true)
  })

  it('matches a differently cased path exactly when the filesystem does', () => {
    const root = make('teamree-case-')
    mkdirSync(path.join(root, 'MixedCase'))
    const shouted = path.join(root, 'MIXEDCASE')

    let filesystemIsCaseInsensitive = true
    try {
      realpathSync.native(shouted)
    } catch {
      filesystemIsCaseInsensitive = false
    }

    expect(samePath(shouted, path.join(root, 'MixedCase'))).toBe(filesystemIsCaseInsensitive)
    expect(isInside(root, shouted)).toBe(true)
  })

  it('keys a path the running platform would fold', () => {
    const root = make('teamree-key-')
    const key = pathKey(root)
    expect(key).toBe(pathKeyOf(canonicalPath(root), process.platform))
    if (POSIX_PLATFORMS.includes(process.platform)) expect(key.startsWith('/')).toBe(true)
  })
})
