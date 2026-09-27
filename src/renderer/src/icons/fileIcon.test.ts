import { describe, expect, it } from 'vitest'
import { fileIconFor } from './fileIcon'

describe('the icon a file row draws', () => {
  it.each([
    ['totals.ts', 'file-code'],
    ['App.TSX', 'file-code'],
    ['main.py', 'file-code'],
    ['styles.css', 'file-code'],
    ['README.md', 'file-text'],
    ['LICENSE', 'file-text'],
    ['notes.txt', 'file-text'],
    ['package.json', 'file-data'],
    ['config.yml', 'file-data'],
    ['.gitignore', 'file-data'],
    ['Cargo.lock', 'file-data'],
    ['logo.png', 'file-image'],
    ['mark.svg', 'file-image'],
    ['Makefile', 'file'],
    ['archive.tar.gz', 'file']
  ])('draws %s as %s', (name, icon) => {
    expect(fileIconFor(name)).toBe(icon)
  })
})
