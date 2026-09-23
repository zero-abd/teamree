import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCode } from '../../shared/protocol'
import { RuntimeError } from '../runtime/runtimeError'
import { readWorktreeFile, writeWorktreeFile } from './worktreeFile'

let root: string
let outside: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'teamree-files-'))
  outside = await mkdtemp(path.join(tmpdir(), 'teamree-outside-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

async function refused(promise: Promise<unknown>): Promise<ErrorCode> {
  try {
    await promise
  } catch (error) {
    if (error instanceof RuntimeError) return error.code
    throw error
  }
  throw new Error('was not refused')
}

describe('readWorktreeFile', () => {
  it('reads a text file relative to the worktree, with its size and mtime', async () => {
    await mkdir(path.join(root, 'docs'))
    await writeFile(path.join(root, 'docs', 'a.md'), '# hi\n')
    const read = await readWorktreeFile({ worktreeId: 'w1', worktreePath: root, path: 'docs/a.md' })
    expect(read).toMatchObject({ worktreeId: 'w1', path: 'docs/a.md', content: '# hi\n', exists: true, size: 5 })
    expect(read.modifiedAt).toBeGreaterThan(0)
  })

  it('answers empty for a file that is not there yet, so a new page can open on it', async () => {
    const read = await readWorktreeFile({ worktreeId: 'w1', worktreePath: root, path: 'NOTES.md' })
    expect(read).toEqual({ worktreeId: 'w1', path: 'NOTES.md', content: '', exists: false, modifiedAt: 0, size: 0 })
  })

  it('refuses a path that leaves the worktree, spelled any way', async () => {
    await writeFile(path.join(outside, 'secret.md'), 'no')
    for (const escape of ['../secret.md', path.join(outside, 'secret.md'), 'docs/../../secret.md', '/etc/hosts']) {
      expect(await refused(readWorktreeFile({ worktreeId: 'w1', worktreePath: root, path: escape }))).toBe(
        ErrorCode.InvalidParams
      )
    }
  })

  it('refuses a symlink, wherever it points', async () => {
    await writeFile(path.join(outside, 'secret.md'), 'no')
    await symlink(path.join(outside, 'secret.md'), path.join(root, 'link.md'))
    expect(await refused(readWorktreeFile({ worktreeId: 'w1', worktreePath: root, path: 'link.md' }))).toBe(
      ErrorCode.InvalidParams
    )
  })

  it('refuses a directory, a binary file and an oversize file', async () => {
    await mkdir(path.join(root, 'dir'))
    await writeFile(path.join(root, 'blob.md'), Buffer.from([0x23, 0x00, 0x01, 0xff]))
    await writeFile(path.join(root, 'big.md'), 'x'.repeat(65))
    expect(await refused(readWorktreeFile({ worktreeId: 'w1', worktreePath: root, path: 'dir' }))).toBe(
      ErrorCode.InvalidParams
    )
    expect(await refused(readWorktreeFile({ worktreeId: 'w1', worktreePath: root, path: 'blob.md' }))).toBe(
      ErrorCode.BadRequest
    )
    expect(
      await refused(readWorktreeFile({ worktreeId: 'w1', worktreePath: root, path: 'big.md', maxBytes: 64 }))
    ).toBe(ErrorCode.BadRequest)
  })
})

describe('writeWorktreeFile', () => {
  it('writes the file, making its directories, and answers with the mtime a later read shows', async () => {
    const written = await writeWorktreeFile({
      worktreeId: 'w1',
      worktreePath: root,
      path: 'docs/notes/plan.md',
      content: '# plan\n'
    })
    expect(await readFile(path.join(root, 'docs', 'notes', 'plan.md'), 'utf8')).toBe('# plan\n')
    const read = await readWorktreeFile({ worktreeId: 'w1', worktreePath: root, path: 'docs/notes/plan.md' })
    expect(written).toEqual({ worktreeId: 'w1', path: 'docs/notes/plan.md', modifiedAt: read.modifiedAt, size: 7 })
  })

  it('refuses to write outside the worktree, over a symlink, or more than the cap', async () => {
    await symlink(path.join(outside, 'x.md'), path.join(root, 'link.md'))
    const write = (relative: string, content = 'x'): Promise<unknown> =>
      writeWorktreeFile({ worktreeId: 'w1', worktreePath: root, path: relative, content, maxBytes: 8 })
    expect(await refused(write('../x.md'))).toBe(ErrorCode.InvalidParams)
    expect(await refused(write('link.md'))).toBe(ErrorCode.InvalidParams)
    expect(await refused(write('a.md', 'x'.repeat(9)))).toBe(ErrorCode.BadRequest)
    // Multi-byte text is counted in bytes, the unit the cap is written in.
    expect(await refused(write('a.md', 'ééééé'))).toBe(ErrorCode.BadRequest)
  })
})
