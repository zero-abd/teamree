import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitServiceError } from './errors'
import { checkWorktreesRoot, resolveWorktreesRoot } from './worktreesRoot'

describe('where new worktrees go', () => {
  const home = '/Users/sam'

  it('takes the project folder, then this Mac, then the environment, then the default', () => {
    const all = { project: '/p', global: '/g', env: '/e' }
    expect(resolveWorktreesRoot(all, home)).toBe('/p')
    expect(resolveWorktreesRoot({ ...all, project: undefined }, home)).toBe('/g')
    expect(resolveWorktreesRoot({ env: '/e' }, home)).toBe('/e')
    expect(resolveWorktreesRoot({}, home)).toBe('/Users/sam/.teamree/worktrees')
  })

  it('reads an empty setting as unset', () => {
    expect(resolveWorktreesRoot({ project: '', global: '', env: '' }, home)).toBe('/Users/sam/.teamree/worktrees')
  })
})

describe('checking a worktrees folder', () => {
  let base = ''
  let repo = ''

  beforeEach(async () => {
    base = await mkdtemp(path.join(await realpath(os.tmpdir()), 'teamree-root-'))
    repo = path.join(base, 'app')
    await mkdir(repo)
  })

  afterEach(async () => {
    await chmod(path.join(base, 'locked'), 0o755).catch(() => undefined)
    await rm(base, { recursive: true, force: true })
  })

  const refusal = async (promise: Promise<unknown>): Promise<unknown> => {
    try {
      await promise
    } catch (error) {
      expect(error).toBeInstanceOf(GitServiceError)
      return ((error as GitServiceError).data as { refusal?: string }).refusal
    }
    throw new Error('expected a refusal')
  }

  it('takes a writable folder, and one not made yet under a writable parent', async () => {
    const repos = [{ name: 'app', path: repo }]
    expect(await checkWorktreesRoot(path.join(base, 'wt'), repos)).toBe(path.join(base, 'wt'))
    await mkdir(path.join(base, 'made'))
    expect(await checkWorktreesRoot(`${path.join(base, 'made')}/`, repos)).toBe(path.join(base, 'made'))
  })

  it('expands ~ and refuses a relative path', async () => {
    expect(await checkWorktreesRoot('~/wt', [], false, base)).toBe(path.join(base, 'wt'))
    expect(await refusal(checkWorktreesRoot('wt', []))).toBe('notAbsolute')
  })

  it('refuses a file, and a folder it cannot write', async () => {
    await writeFile(path.join(base, 'file'), '')
    expect(await refusal(checkWorktreesRoot(path.join(base, 'file'), []))).toBe('notFolder')
    if (process.getuid?.() === 0) return
    await mkdir(path.join(base, 'locked'))
    await chmod(path.join(base, 'locked'), 0o555)
    expect(await refusal(checkWorktreesRoot(path.join(base, 'locked', 'wt'), []))).toBe('notWritable')
  })

  it('refuses a folder that would put checkouts inside a repository, unless asked', async () => {
    const repos = [{ name: 'app', path: repo }]
    expect(await refusal(checkWorktreesRoot(path.join(repo, '.worktrees'), repos))).toBe('insideRepository')
    expect(await refusal(checkWorktreesRoot(repo, repos))).toBe('insideRepository')
    // `<root>/<project>` is the repository itself when the root is its parent.
    expect(await refusal(checkWorktreesRoot(base, repos))).toBe('insideRepository')
    expect(await checkWorktreesRoot(path.join(repo, '.worktrees'), repos, true)).toBe(path.join(repo, '.worktrees'))
  })

  it('refuses the home folder and anything holding it', async () => {
    expect(await refusal(checkWorktreesRoot(base, [], false, base))).toBe('holdsHome')
    expect(await refusal(checkWorktreesRoot(path.dirname(base), [], false, base))).toBe('holdsHome')
  })
})
