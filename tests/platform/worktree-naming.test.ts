// Names teamree invents have to survive three filesystems at once: they become
// a directory on disk and, unchanged, a loose ref file under .git/refs/heads.
// Windows forbids a set of names outright, and two of the three platforms match
// filenames case-insensitively, so "Fix Login" and "fix login" must not race.

import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  allocateBranchName,
  allocateCheckoutPath,
  branchCollides,
  checkoutDirName,
  isWindowsDeviceName,
  projectDirName,
  slugify
} from '../../src/main/git/worktreeNaming'
import { pathKey } from '../../src/main/git/pathIdentity'

/** Everything Windows rejects in a path component, plus the POSIX separator. */
const WINDOWS_RESERVED_CHARACTERS = new Set('<>:"/\\|?*')

function isLegalWindowsComponent(value: string): boolean {
  for (const character of value) {
    if (WINDOWS_RESERVED_CHARACTERS.has(character)) return false
    if ((character.codePointAt(0) ?? 0) < 0x20) return false
  }
  return true
}

const makeTempDir = (): string => realpathSync.native(mkdtempSync(path.join(tmpdir(), 'teamree-naming-')))

describe('Windows device names', () => {
  it('knows the whole reserved set', () => {
    for (const name of ['con', 'PRN', 'Aux', 'nul', 'com1', 'COM9', 'lpt1', 'LPT0', 'com0']) {
      expect(isWindowsDeviceName(name)).toBe(true)
    }
    for (const name of ['console', 'aux2', 'com', 'lpt', 'com10', 'nullable', 'prnt']) {
      expect(isWindowsDeviceName(name)).toBe(false)
    }
  })

  // The defect: a task called "CON" slugged to `con`, which Windows refuses to
  // create either as the checkout directory or as .git/refs/heads/con, so the
  // worktree failed at the last step with an errno and no explanation.
  it('never leaves a slug that Windows would refuse to create', () => {
    expect(slugify('CON')).toBe('con-1')
    expect(slugify('nul')).toBe('nul-1')
    expect(slugify('Com1')).toBe('com1-1')
    expect(isWindowsDeviceName(slugify('aux'))).toBe(false)
  })

  it('leaves a name that merely contains a device name alone', () => {
    expect(slugify('console log')).toBe('console-log')
    expect(slugify('fix the CON case')).toBe('fix-the-con-case')
  })

  it('carries the guard into every derived name', () => {
    expect(isWindowsDeviceName(checkoutDirName('nul'))).toBe(false)
    expect(isWindowsDeviceName(projectDirName('AUX'))).toBe(false)
    expect(isWindowsDeviceName(allocateBranchName('prn', []))).toBe(false)
  })
})

describe('slugs are legal path components everywhere', () => {
  const inputs = [
    'Fix the login page!',
    'refactor: pane/tree — split',
    'crème brûlée ☕',
    '  leading and trailing  ',
    '../../escape',
    'C:\\Windows\\System32',
    'a'.repeat(200),
    '???',
    'branch.lock',
    'ends with a dot.',
    'tab\there'
  ]

  for (const input of inputs) {
    it(`turns ${JSON.stringify(input.slice(0, 24))} into something all three accept`, () => {
      const slug = slugify(input)
      expect(isLegalWindowsComponent(slug)).toBe(true)
      expect(slug).not.toMatch(/^[.\s]|[.\s]$/) // Windows strips a trailing dot or space
      expect(slug.length).toBeGreaterThan(0)
      expect(slug).toBe(slug.toLowerCase())
      expect(isWindowsDeviceName(slug)).toBe(false)
      // git's own ref rules, the ones a slug could otherwise still break.
      expect(slug.endsWith('.lock')).toBe(false)
      expect(slug.startsWith('-')).toBe(false)
      expect(slug).not.toContain('..')
    })
  }

  it('falls back rather than producing an empty component', () => {
    expect(slugify('???')).toBe('worktree')
    expect(slugify('')).toBe('worktree')
  })
})

describe('branch allocation is case-insensitive', () => {
  it('treats a differently cased existing branch as taken', () => {
    expect(branchCollides('fix-login', new Set(['fix-login']))).toBe(true)
    expect(allocateBranchName('Fix Login', ['Fix-Login'])).toBe('fix-login-2')
    expect(allocateBranchName('Fix Login', ['FIX-LOGIN', 'fix-login-2'])).toBe('fix-login-3')
  })

  it('honours git refusing a branch that is a prefix of another', () => {
    expect(branchCollides('feature', new Set(['feature/login']))).toBe(true)
    expect(branchCollides('feature/login/deep', new Set(['feature/login']))).toBe(true)
    expect(allocateBranchName('feature', ['Feature/login'])).toBe('feature-2')
  })

  it('gives two identically spelled tasks two branches', () => {
    const first = allocateBranchName('Fix Login', [])
    const second = allocateBranchName('fix login', [first])
    expect(second).not.toBe(first)
  })
})

describe('allocateCheckoutPath', () => {
  it('puts a checkout under the project directory, one level deep', async () => {
    const root = makeTempDir()
    const checkout = await allocateCheckoutPath(root, 'My App', 'feature/login')
    expect(checkout).toBe(path.join(root, 'my-app', 'feature-login'))
    expect(isLegalWindowsComponent(path.basename(checkout))).toBe(true)
  })

  it('does not hand out a directory that is already on disk', async () => {
    const root = makeTempDir()
    mkdirSync(path.join(root, 'app', 'login'), { recursive: true })
    expect(await allocateCheckoutPath(root, 'app', 'login')).toBe(path.join(root, 'app', 'login-2'))
  })

  it('does not hand out a path another create has already claimed', async () => {
    const root = makeTempDir()
    const claimed = new Set([pathKey(path.join(root, 'app', 'login'))])
    expect(await allocateCheckoutPath(root, 'app', 'login', claimed)).toBe(path.join(root, 'app', 'login-2'))
  })

  it('respects a directory this filesystem considers the same name', async () => {
    const root = makeTempDir()
    mkdirSync(path.join(root, 'app', 'LOGIN'), { recursive: true })
    const checkout = await allocateCheckoutPath(root, 'app', 'login')

    // On Windows and macOS `LOGIN` already occupies `login`; on Linux it does not.
    const filesystemIsCaseInsensitive = pathKey(path.join(root, 'app', 'LOGIN')) === pathKey(path.join(root, 'app', 'login'))
    expect(path.basename(checkout)).toBe(filesystemIsCaseInsensitive ? 'login-2' : 'login')
  })

  it('never returns a device name as the leaf, whatever the branch was called', async () => {
    const root = makeTempDir()
    const checkout = await allocateCheckoutPath(root, 'app', 'nul')
    expect(isWindowsDeviceName(path.basename(checkout))).toBe(false)
  })
})
