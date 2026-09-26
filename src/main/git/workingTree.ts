// A worktree's files as a tree object, untracked ones included, written through a
// private copy of the index so the real one is never locked or changed.

import { randomUUID } from 'node:crypto'
import { copyFile, rm, stat, utimes } from 'node:fs/promises'
import path from 'node:path'
import type { GitRunner } from './gitProcess'

/** With `paths`, only those are taken from disk; the rest of the tree is the index. Throws when git does. */
export async function writeWorkingTree(
  runner: GitRunner,
  options: { cwd: string; timeoutMs: number; paths?: readonly string[]; readOnly?: boolean }
): Promise<string> {
  const { cwd } = options
  const git = async (args: string[], env?: NodeJS.ProcessEnv): Promise<string> =>
    (
      await runner.run({
        args,
        cwd,
        timeoutMs: options.timeoutMs,
        ...(options.readOnly === true ? { readOnly: true } : {}),
        ...(env === undefined ? {} : { env })
      })
    ).stdout.trim()

  const [gitDir = '', index = ''] = (await git(['rev-parse', '--git-dir', '--git-path', 'index'])).split('\n')
  const realIndex = path.resolve(cwd, index)
  const scratch = path.join(path.resolve(cwd, gitDir), `teamree-tree-${randomUUID()}.index`)
  try {
    const copied = await copyFile(realIndex, scratch).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return false
      }
    )
    // A copy newer than its entries hides same-size edits from git's racy-clean check, so it is
    // dated a second before the real index: every entry that could be racy gets its content read.
    if (copied) {
      const { mtimeMs } = await stat(realIndex)
      const earlier = (mtimeMs - 1000) / 1000
      await utimes(scratch, earlier, earlier)
    }
    const env = { GIT_INDEX_FILE: scratch }
    const pathspec = options.paths === undefined ? [] : ['--', ...options.paths]
    await git(['--literal-pathspecs', 'add', '-A', ...pathspec], env)
    return await git(['write-tree'], env)
  } finally {
    await rm(scratch, { force: true })
  }
}
