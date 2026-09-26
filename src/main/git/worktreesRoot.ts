// Where new worktrees go, and whether a folder chosen for them will do.

import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ErrorCode } from '../../shared/protocol'
import { GitServiceError } from './errors'
import { isInside, samePath } from './pathIdentity'
import { projectDirName } from './worktreeNaming'

export function defaultWorktreesRoot(home = os.homedir()): string {
  return path.join(home, '.teamree', 'worktrees')
}

/** The project's folder, else this Mac's, else the launch's `TEAMREE_WORKTREES_ROOT`, else the default. */
export function resolveWorktreesRoot(
  levels: { project?: string | undefined; global?: string | undefined; env?: string | undefined },
  home = os.homedir()
): string {
  return levels.project || levels.global || levels.env || defaultWorktreesRoot(home)
}

export type WorktreesRootRefusal = 'notAbsolute' | 'notFolder' | 'notWritable' | 'insideRepository' | 'holdsHome'

/**
 * The folder as it will be stored, or a refusal carrying `{ refusal }`. A folder not made yet is judged by
 * the nearest one that is; `<root>/<project>` inside a repository is refused unless `allowInsideRepository`.
 */
export async function checkWorktreesRoot(
  input: string,
  repositories: readonly { name: string; path: string }[],
  allowInsideRepository = false,
  home = os.homedir()
): Promise<string> {
  const typed = input.trim()
  const expanded = typed === '~' ? home : typed.startsWith('~/') ? path.join(home, typed.slice(2)) : typed
  if (!path.isAbsolute(expanded)) throw refuse('notAbsolute', `${typed} is not an absolute path`)
  const root = path.resolve(expanded)
  // Every checkout under it would count as this app's to delete.
  if (samePath(root, home) || isInside(root, home)) throw refuse('holdsHome', `${root} holds the home folder`)

  let nearest = root
  for (;;) {
    const found = await stat(nearest).catch(() => null)
    if (found !== null) {
      if (!found.isDirectory()) throw refuse('notFolder', `${nearest} is not a folder`)
      break
    }
    const parent = path.dirname(nearest)
    if (parent === nearest) break
    nearest = parent
  }
  const writable = await access(nearest, constants.W_OK).then(
    () => true,
    () => false
  )
  if (!writable) throw refuse('notWritable', `${nearest} is not writable`)

  if (!allowInsideRepository) {
    for (const repository of repositories) {
      const projectDir = path.join(root, projectDirName(repository.name))
      if (samePath(projectDir, repository.path) || isInside(repository.path, projectDir)) {
        throw refuse('insideRepository', `${root} is inside ${repository.name}`, repository.name)
      }
    }
  }
  return root
}

function refuse(refusal: WorktreesRootRefusal, message: string, repository?: string): GitServiceError {
  return new GitServiceError(ErrorCode.InvalidParams, message, {
    refusal,
    ...(repository === undefined ? {} : { repository })
  })
}
