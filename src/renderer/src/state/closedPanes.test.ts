// Which pane ⌘⇧T brings back, of the terminals the runtime keeps and the file panes this window keeps.

import { describe, expect, it } from 'vitest'
import type { ClosedPane } from '@shared/entities'
import { fileLeaf } from '@shared/filePane'
import {
  CLOSED_FILES_KEPT,
  nextToReopen,
  readClosedFiles,
  resumableAgent,
  withClosedFile,
  withoutClosedFile,
  writeClosedFiles,
  type ClosedFile
} from './closedPanes'

const pane = (terminalId: string, closedAt: number, extra: Partial<ClosedPane> = {}): ClosedPane => ({
  terminalId,
  worktreeId: 'w1',
  resumable: false,
  closedAt,
  ...extra
})
const file = (path: string, closedAt: number): ClosedFile => ({ leaf: fileLeaf(`file:${path}`, path), closedAt })

describe('the pane to reopen', () => {
  it('is whichever kind was closed last', () => {
    expect(nextToReopen([pane('t1', 5)], [file('a.md', 4)])).toEqual({ kind: 'terminal', terminalId: 't1' })
    expect(nextToReopen([pane('t1', 3)], [file('a.md', 4)])).toEqual({ kind: 'file', file: file('a.md', 4) })
    expect(nextToReopen([], [])).toBeNull()
  })

  it('resumes the last closed agent that can pick its conversation up', () => {
    const shell = pane('t3', 9)
    const stale = pane('t2', 8, { agent: 'codex' })
    const claude = pane('t1', 7, { agent: 'claude', resumable: true })
    expect(resumableAgent([shell, stale, claude])).toBe(claude)
    expect(resumableAgent([shell, stale])).toBeNull()
  })
})

describe('closed file panes', () => {
  it('keeps the last few per worktree, newest first, across a relaunch', () => {
    let files = {}
    for (let index = 0; index < CLOSED_FILES_KEPT + 2; index++)
      files = withClosedFile(files, 'w1', file(`${index}.md`, index))
    const stored = new Map<string, string>()
    writeClosedFiles({ setItem: (key, value) => stored.set(key, value) }, files)
    const read = readClosedFiles({ getItem: (key) => stored.get(key) ?? null })

    expect(read.w1).toHaveLength(CLOSED_FILES_KEPT)
    expect(read.w1?.[0]?.leaf.path).toBe(`${CLOSED_FILES_KEPT + 1}.md`)
    const first = read.w1?.[0] as ClosedFile
    expect(withoutClosedFile(read, 'w1', first).w1?.[0]?.leaf.path).toBe(`${CLOSED_FILES_KEPT}.md`)
  })

  it('reads a record it cannot use as nothing to reopen', () => {
    expect(readClosedFiles({ getItem: () => '{not json' })).toEqual({})
    expect(readClosedFiles({ getItem: () => JSON.stringify({ w1: [{ leaf: { kind: 'leaf' } }] }) })).toEqual({})
  })
})
