import { describe, expect, it } from 'vitest'
import type { PaneNode } from './entities'
import {
  fileLeaf,
  fileLeavesIn,
  filePaneName,
  fileViewerFor,
  isFileLeaf,
  isFilePaneId,
  isMarkdownPath,
  newFilePaneId
} from './filePane'

describe('file leaves', () => {
  it('tells a file leaf from a terminal leaf, with and without the field', () => {
    const legacy: PaneNode = { kind: 'leaf', terminalId: 't1' }
    const terminal: PaneNode = { kind: 'leaf', terminalId: 't2', pane: 'terminal' }
    expect(isFileLeaf(legacy)).toBe(false)
    expect(isFileLeaf(terminal)).toBe(false)
    expect(isFileLeaf(fileLeaf('file:1', 'NOTES.md'))).toBe(true)
    expect(isFileLeaf({ kind: 'leaf', terminalId: 'file:2', pane: 'file' })).toBe(false)
  })

  it('finds every file leaf of a tree in reading order', () => {
    const root: PaneNode = {
      kind: 'split',
      direction: 'row',
      sizes: [0.5, 0.5],
      children: [
        fileLeaf('file:a', 'docs/a.md'),
        {
          kind: 'split',
          direction: 'column',
          sizes: [0.5, 0.5],
          children: [{ kind: 'leaf', terminalId: 't1' }, fileLeaf('file:b', 'b.md')]
        }
      ]
    }
    expect(fileLeavesIn(root).map((leaf) => leaf.path)).toEqual(['docs/a.md', 'b.md'])
    expect(fileLeavesIn(null)).toEqual([])
  })

  it('prefixes the id and names the pane after the file', () => {
    expect(newFilePaneId(() => 'abc')).toBe('file:abc')
    expect(isFilePaneId('file:abc')).toBe(true)
    expect(isFilePaneId('t_0001')).toBe(false)
    expect(filePaneName('docs/notes/Plan.md')).toBe('Plan.md')
    expect(filePaneName('NOTES.md')).toBe('NOTES.md')
  })

  it('picks the markdown viewer for .md and .markdown, and none for anything else', () => {
    expect(isMarkdownPath('README.md')).toBe(true)
    expect(fileViewerFor('docs/Guide.MARKDOWN')).toBe('markdown')
    expect(fileViewerFor('src/app.ts')).toBeNull()
    expect(fileViewerFor('md')).toBeNull()
  })
})
