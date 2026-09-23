import { describe, expect, it } from 'vitest'
import { ErrorCode } from '../../shared/protocol'
import { GitCommandError, GitServiceError, isTransient } from './errors'

const failedGit = (input: Partial<ConstructorParameters<typeof GitCommandError>[0]>): GitCommandError =>
  new GitCommandError({ args: ['worktree', 'add'], cwd: '/repo', exitCode: 128, stderr: '', ...input })

describe('GitCommandError', () => {
  it('leads with git’s own error line rather than the progress printed before it', () => {
    const error = failedGit({
      stderr:
        "Preparing worktree (new branch 'flaky')\nfatal: Unable to create '/repo/.git/refs/heads/flaky.lock': File exists.\n"
    })
    expect(error.message).toMatch(/: fatal: Unable to create .*flaky\.lock': File exists\.$/)
  })
})

describe('isTransient', () => {
  it('holds for a timeout, a cancel, a held lock and a name taken meanwhile', () => {
    expect(isTransient(failedGit({ exitCode: null, timedOut: true }))).toBe(true)
    expect(isTransient(failedGit({ exitCode: null, cancelled: true }))).toBe(true)
    expect(isTransient(failedGit({ stderr: "fatal: Unable to create '/repo/.git/index.lock': File exists." }))).toBe(
      true
    )
    expect(isTransient(new GitServiceError(ErrorCode.Conflict, 'branch "x" already exists'))).toBe(true)
  })

  it('does not hold for a cause that will be there next time', () => {
    expect(isTransient(failedGit({ stderr: 'fatal: invalid reference: origin/nope' }))).toBe(false)
    expect(isTransient(new GitServiceError(ErrorCode.NotFound, 'start point "x" is not a ref'))).toBe(false)
    expect(isTransient(new Error('EACCES: permission denied'))).toBe(false)
  })
})
