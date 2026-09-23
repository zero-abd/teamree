import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCode } from '../../shared/protocol'
import { RuntimeError } from '../runtime/runtimeError'
import type { FileGrant } from './fileProtocol'
import { decodeText, readWorktreeFile, writeWorktreeFile } from './worktreeFile'

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

  it('refuses a symlink that leads out, file or directory, and follows one that stays in', async () => {
    await writeFile(path.join(outside, 'secret.md'), 'no')
    await symlink(path.join(outside, 'secret.md'), path.join(root, 'link.md'))
    await symlink(outside, path.join(root, 'out'))
    await writeFile(path.join(root, 'real.md'), 'yes')
    await symlink(path.join(root, 'real.md'), path.join(root, 'alias.md'))
    const read = (relative: string) => readWorktreeFile({ worktreeId: 'w1', worktreePath: root, path: relative })
    expect(await refused(read('link.md'))).toBe(ErrorCode.InvalidParams)
    expect(await refused(read('out/secret.md'))).toBe(ErrorCode.InvalidParams)
    expect(await read('alias.md')).toMatchObject({ content: 'yes', path: 'alias.md' })
  })

  it('says how text was encoded and which line ending it uses, BOM taken off', async () => {
    await writeFile(path.join(root, 'crlf.ts'), 'a\r\nb\r\n')
    await writeFile(path.join(root, 'bom.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi\n')]))
    const read = (relative: string) => readWorktreeFile({ worktreeId: 'w1', worktreePath: root, path: relative })
    expect(await read('crlf.ts')).toMatchObject({ content: 'a\r\nb\r\n', encoding: 'utf-8', lineEnding: '\r\n' })
    expect(await read('bom.txt')).toMatchObject({ content: 'hi\n', encoding: 'utf-8-bom', lineEnding: '\n' })
  })

  it('calls NUL bytes and invalid UTF-8 binary', async () => {
    await writeFile(path.join(root, 'latin1.md'), Buffer.from([0x63, 0x61, 0x66, 0xe9]))
    expect(await refused(readWorktreeFile({ worktreeId: 'w1', worktreePath: root, path: 'latin1.md' }))).toBe(
      ErrorCode.BadRequest
    )
    expect(decodeText(Buffer.from([0x41, 0x00]))).toBeNull()
    expect(decodeText(Buffer.from('plain'))).toEqual({ text: 'plain', bom: false })
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

describe('a viewer read', () => {
  const granted: FileGrant[] = []
  const view = (relative: string, maxBytes?: number) =>
    readWorktreeFile({
      worktreeId: 'w1',
      worktreePath: root,
      path: relative,
      viewer: true,
      ...(maxBytes === undefined ? {} : { maxBytes }),
      grant: (grant) => {
        granted.push(grant)
        return `teamree-file://grant/t${granted.length}/x`
      }
    })

  it('answers binary and oversize files with a view rather than refusing them', async () => {
    await writeFile(path.join(root, 'blob.dat'), Buffer.from([0x41, 0x00, 0x42]))
    await writeFile(path.join(root, 'big.log'), 'x'.repeat(65))
    expect(await view('blob.dat')).toMatchObject({ content: '', size: 3, view: { kind: 'binary' } })
    expect(await view('big.log', 64)).toMatchObject({ content: '', size: 65, view: { kind: 'tooLarge', limit: 64 } })
    expect(await view('big.log', 65)).toMatchObject({ content: 'x'.repeat(65) })
    expect((await view('big.log', 65)).view).toBeUndefined()
  })

  it('grants a URL for images, PDFs and media by extension, whatever their size', async () => {
    for (const name of ['shot.png', 'doc.pdf', 'clip.mp4', 'song.mp3']) {
      await writeFile(path.join(root, name), 'x'.repeat(100))
    }
    expect(await view('shot.png', 10)).toMatchObject({ view: { kind: 'image', mime: 'image/png' } })
    expect(await view('doc.pdf', 10)).toMatchObject({ view: { kind: 'pdf', mime: 'application/pdf' } })
    expect(await view('clip.mp4', 10)).toMatchObject({ view: { kind: 'media', mime: 'video/mp4' } })
    expect(await view('song.mp3', 10)).toMatchObject({ view: { kind: 'media', mime: 'audio/mpeg' } })
    expect(path.basename(granted.at(-4)?.absolute ?? '')).toBe('shot.png')
  })

  it('still refuses a link out', async () => {
    await writeFile(path.join(outside, 'secret.png'), 'no')
    await symlink(path.join(outside, 'secret.png'), path.join(root, 'link.png'))
    expect(await refused(view('link.png'))).toBe(ErrorCode.InvalidParams)
  })
})

describe('writeWorktreeFile', () => {
  it('round-trips a save against the version it read, keeping BOM and mode', async () => {
    await writeFile(path.join(root, 'run.sh'), 'echo\n', { mode: 0o755 })
    const before = await readWorktreeFile({ worktreeId: 'w1', worktreePath: root, path: 'run.sh' })
    const written = await writeWorktreeFile({
      worktreeId: 'w1',
      worktreePath: root,
      path: 'run.sh',
      content: 'echo hi\r\n',
      encoding: 'utf-8-bom',
      expectedModifiedAt: before.modifiedAt
    })
    const after = await readWorktreeFile({ worktreeId: 'w1', worktreePath: root, path: 'run.sh' })
    expect(after).toMatchObject({ content: 'echo hi\r\n', encoding: 'utf-8-bom', lineEnding: '\r\n' })
    expect(written.modifiedAt).toBe(after.modifiedAt)
    expect((await stat(path.join(root, 'run.sh'))).mode & 0o777).toBe(0o755)
  })

  it('refuses a stale save', async () => {
    await writeFile(path.join(root, 'a.ts'), 'old\n')
    const stale = writeWorktreeFile({
      worktreeId: 'w1',
      worktreePath: root,
      path: 'a.ts',
      content: 'mine',
      expectedModifiedAt: 1
    })
    expect(await refused(stale)).toBe(ErrorCode.Conflict)
    expect(await readFile(path.join(root, 'a.ts'), 'utf8')).toBe('old\n')
  })

  it('refuses to write through a directory link out, even into a folder not there yet', async () => {
    await symlink(outside, path.join(root, 'out'))
    const write = (relative: string) =>
      writeWorktreeFile({ worktreeId: 'w1', worktreePath: root, path: relative, content: 'x' })
    expect(await refused(write('out/x.md'))).toBe(ErrorCode.InvalidParams)
    expect(await refused(write('out/deep/x.md'))).toBe(ErrorCode.InvalidParams)
    await expect(readFile(path.join(outside, 'x.md'))).rejects.toThrow()
  })

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
