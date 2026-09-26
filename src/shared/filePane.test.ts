import { describe, expect, it } from 'vitest'
import type { PaneNode } from './entities'
import {
  commitLeaf,
  compareLeaf,
  reviewLeaf,
  isReviewLeaf,
  sharedNoteLeaf,
  isSharedNoteLeaf,
  fileLeaf,
  fileLeavesIn,
  filePaneName,
  fileTabName,
  isCommitLeaf,
  isCompareLeaf,
  isWorktreeFileLeaf,
  fileViewerFor,
  isFileLeaf,
  isFilePaneId,
  isMarkdownPath,
  mediaTypeFor,
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

  it('keeps a commit as a file-column tab named by its title, apart from the files', () => {
    const commit = commitLeaf('file:c', 'a'.repeat(40), '5bb16ed Fix src/math.ts')
    const file = fileLeaf('file:f', 'src/math.ts')
    expect(isFileLeaf(commit)).toBe(true)
    expect(isCommitLeaf(commit)).toBe(true)
    expect(isCommitLeaf(file)).toBe(false)
    expect(fileTabName(commit)).toBe('5bb16ed Fix src/math.ts')
    expect(fileTabName(file)).toBe('math.ts')
  })

  it('keeps a compare as a file-column tab named by its whole title, apart from files and commits', () => {
    const compare = compareLeaf('file:x', 'wt-codex', 'claude vs codex/2')
    const commit = commitLeaf('file:c', 'a'.repeat(40), 'aaaaaaa Add sub')
    const file = fileLeaf('file:f', 'src/math.ts')
    expect(isFileLeaf(compare)).toBe(true)
    expect(isCompareLeaf(compare)).toBe(true)
    expect(isCompareLeaf(commit)).toBe(false)
    expect(isCommitLeaf(compare)).toBe(false)
    expect([compare, commit, file].map(isWorktreeFileLeaf)).toEqual([false, false, true])
    expect(fileTabName(compare)).toBe('claude vs codex/2')
  })

  it('keeps a review as a file-column tab named by its title, apart from files', () => {
    const review = reviewLeaf('file:r', 'Review')
    expect(isFileLeaf(review)).toBe(true)
    expect(isReviewLeaf(review)).toBe(true)
    expect(isReviewLeaf(fileLeaf('file:f', 'src/math.ts'))).toBe(false)
    expect(isWorktreeFileLeaf(review)).toBe(false)
    expect(fileTabName(review)).toBe('Review')
  })

  it('keeps a shared note as a file-column tab named by its title, apart from files', () => {
    const note = sharedNoteLeaf('file:n', 'share-1', 'Plan.md')
    expect(isFileLeaf(note)).toBe(true)
    expect(isSharedNoteLeaf(note)).toBe(true)
    expect(isSharedNoteLeaf(fileLeaf('file:f', 'Plan.md'))).toBe(false)
    expect(isWorktreeFileLeaf(note)).toBe(false)
    expect(fileTabName(note)).toBe('Plan.md')
  })

  it('prefixes the id and names the pane after the file', () => {
    expect(newFilePaneId(() => 'abc')).toBe('file:abc')
    expect(isFilePaneId('file:abc')).toBe(true)
    expect(isFilePaneId('t_0001')).toBe(false)
    expect(filePaneName('docs/notes/Plan.md')).toBe('Plan.md')
    expect(filePaneName('NOTES.md')).toBe('NOTES.md')
  })

  it('picks a viewer by extension, case-blind, with code as the fallback', () => {
    expect(isMarkdownPath('README.md')).toBe(true)
    expect(fileViewerFor('docs/Guide.MARKDOWN')).toBe('markdown')
    expect(fileViewerFor('src/app.ts')).toBe('code')
    expect(fileViewerFor('md')).toBe('code')
    expect(fileViewerFor('Makefile')).toBe('code')
    expect(fileViewerFor('.env')).toBe('code')
    expect(fileViewerFor('brand/Logo.PNG')).toBe('image')
    expect(fileViewerFor('icon.svg')).toBe('image')
    expect(fileViewerFor('spec.pdf')).toBe('pdf')
    expect(fileViewerFor('a.mp3')).toBe('audio')
    expect(fileViewerFor('b.mov')).toBe('video')
  })

  it('serves media with its MIME type and nothing else', () => {
    expect(mediaTypeFor('a.jpg')).toBe('image/jpeg')
    expect(mediaTypeFor('a.webm')).toBe('video/webm')
    expect(mediaTypeFor('a.ts')).toBeNull()
    expect(mediaTypeFor('a.md')).toBeNull()
  })
})
