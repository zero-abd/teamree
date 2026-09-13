// Whether a checkout path is free, when the filesystem will not say.
//
// The answer gates `git worktree add`, and a create that fails deletes the
// directory it was pointed at. So the only safe reading of a path that cannot
// be inspected is "something may be there", never "nothing is".

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitServiceError } from './errors'
import { ErrorCode } from '../../shared/protocol'
import { allocateCheckoutPath, checkoutDirName, projectDirName } from './worktreeNaming'

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function worktreesRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'teamree-checkout-path-'))
  created.push(root)
  return root
}

const checkoutOf = (root: string, project: string, branch: string): string =>
  path.join(root, projectDirName(project), checkoutDirName(branch))

describe('allocating a checkout path', () => {
  it('steps over a directory that is already there', async () => {
    const root = await worktreesRoot()
    const taken = checkoutOf(root, 'demo', 'fix-login')
    await mkdir(taken, { recursive: true })
    await writeFile(path.join(taken, 'work.txt'), 'somebody was here\n')

    expect(await allocateCheckoutPath(root, 'demo', 'fix-login')).toBe(`${taken}-2`)
  })

  // Symlinks are a privileged operation on Windows and the loop is a POSIX
  // shape; the rule under test is the same on both.
  const itPosix = process.platform === 'win32' ? it.skip : it

  itPosix('refuses to call a path free when the filesystem would not say', async () => {
    const root = await worktreesRoot()
    const occupied = checkoutOf(root, 'demo', 'fix-login')
    await mkdir(path.dirname(occupied), { recursive: true })
    // Something is at that path. A symlink loop is simply the cheapest way to
    // make the kernel refuse to say what, the way EACCES or an I/O error does.
    await symlink(path.join(path.dirname(occupied), 'loop-b'), occupied)
    await symlink(occupied, path.join(path.dirname(occupied), 'loop-b'))

    const failure = await allocateCheckoutPath(root, 'demo', 'fix-login').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(GitServiceError)
    expect((failure as GitServiceError).code).toBe(ErrorCode.Conflict)
    expect((failure as Error).message).toContain(occupied)
    expect((failure as Error).message).toContain('ELOOP')
  })
})
