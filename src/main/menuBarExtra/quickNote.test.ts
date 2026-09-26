import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendNote, noteCheckout, quickNoteContext, readQuickNote, saveQuickNote } from './quickNote'

const AT = new Date(2026, 8, 26, 14, 5)

describe('appendNote', () => {
  it('starts a file with one dated section', () => {
    expect(appendNote('', '  ship the tray  \n', AT)).toBe('## 2026-09-26 14:05\n\nship the tray\n')
  })

  it.each([
    ['no final newline', '# Notes', '# Notes\n\n## 2026-09-26 14:05\n\nnext\n'],
    ['one final newline', '# Notes\n', '# Notes\n\n## 2026-09-26 14:05\n\nnext\n'],
    ['a blank line already', '# Notes\n\n', '# Notes\n\n## 2026-09-26 14:05\n\nnext\n']
  ])('appends after a file with %s, one blank line between', (_case, existing, expected) => {
    expect(appendNote(existing, 'next', AT)).toBe(expected)
  })

  it('keeps a file written with CRLF in CRLF', () => {
    expect(appendNote('# Notes\r\n', 'a\nb', AT)).toBe('# Notes\r\n\r\n## 2026-09-26 14:05\r\n\r\na\r\nb\r\n')
  })
})

describe('noteCheckout', () => {
  const project = { id: 'p1', path: '/repo' }
  it('is the project’s own checkout unless a worktree of that project is attached', () => {
    expect(noteCheckout(project, undefined)).toBe('/repo')
    expect(noteCheckout(project, { projectId: 'p1', path: '/wt/a' })).toBe('/wt/a')
    expect(noteCheckout(project, { projectId: 'p2', path: '/wt/b' })).toBe('/repo')
  })
})

describe('quickNoteContext', () => {
  const projects = [
    { id: 'p1', name: 'teamree', path: '/a' },
    { id: 'p2', name: 'site', path: '/b' }
  ]
  const worktrees = [{ id: 'w1', name: 'login-bug', projectId: 'p2', path: '/wt' }]

  it('defaults to the last project a note went to', () => {
    expect(quickNoteContext({ projects, worktrees, lastProjectId: 'p2', activeWorktreeId: null })).toEqual({
      projects: [
        { id: 'p1', name: 'teamree' },
        { id: 'p2', name: 'site' }
      ],
      projectId: 'p2',
      worktree: null
    })
  })

  it('falls back to the window’s worktree’s project, then the first, and offers that worktree', () => {
    const context = quickNoteContext({ projects, worktrees, lastProjectId: 'gone', activeWorktreeId: 'w1' })
    expect(context.projectId).toBe('p2')
    expect(context.worktree).toEqual({ id: 'w1', name: 'login-bug', projectId: 'p2' })
    expect(quickNoteContext({ projects, worktrees, lastProjectId: undefined, activeWorktreeId: null }).projectId).toBe(
      'p1'
    )
    expect(quickNoteContext({ projects: [], worktrees: [], activeWorktreeId: null }).projectId).toBeNull()
  })
})

describe('readQuickNote', () => {
  it('rebuilds a note field by field and refuses anything else', () => {
    expect(readQuickNote({ projectId: 'p1', worktreeId: null, text: 'hi', extra: 1 })).toEqual({
      projectId: 'p1',
      worktreeId: null,
      text: 'hi'
    })
    expect(readQuickNote({ projectId: 'p1', worktreeId: 'w1', text: 'hi' })?.worktreeId).toBe('w1')
    expect(readQuickNote({ projectId: 'p1', worktreeId: null, text: '   ' })).toBeNull()
    expect(readQuickNote({ projectId: '', worktreeId: null, text: 'hi' })).toBeNull()
    expect(readQuickNote({ projectId: 'p1', worktreeId: 3, text: 'hi' })).toBeNull()
    expect(readQuickNote('hi')).toBeNull()
  })
})

describe('saveQuickNote', () => {
  let checkout = ''
  beforeEach(async () => {
    checkout = await mkdtemp(join(tmpdir(), 'teamree-quick-note-'))
  })
  afterEach(async () => {
    await rm(checkout, { recursive: true, force: true })
  })

  it('writes NOTES.md at the checkout’s root, where New Markdown puts it, and appends the next note', async () => {
    const first = await saveQuickNote({ checkout, text: 'one', at: AT })
    expect(first).toBe(join(checkout, 'NOTES.md'))
    await saveQuickNote({ checkout, text: 'two', at: AT })
    expect(await readFile(first, 'utf8')).toBe('## 2026-09-26 14:05\n\none\n\n## 2026-09-26 14:05\n\ntwo\n')
  })

  it('appends to a NOTES.md somebody already wrote', async () => {
    await writeFile(join(checkout, 'NOTES.md'), '# Plans\n')
    await saveQuickNote({ checkout, text: 'three', at: AT })
    expect(await readFile(join(checkout, 'NOTES.md'), 'utf8')).toBe('# Plans\n\n## 2026-09-26 14:05\n\nthree\n')
  })
})
