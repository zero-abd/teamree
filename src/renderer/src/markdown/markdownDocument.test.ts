import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseMarkdown, serializeMarkdown } from './markdownDocument'

const root = path.resolve(import.meta.dirname, '../../../..')
const pass = (text: string): string => serializeMarkdown(parseMarkdown(text))

describe('the app’s own documents', () => {
  it.each(['README.md', 'ROADMAP.md'])('%s settles after one pass', (name) => {
    const source = readFileSync(path.join(root, name), 'utf8')
    const once = pass(source)
    expect(pass(once)).toBe(once)
  })

  it('keeps the README’s raw HTML, its fences and its tables', () => {
    const source = readFileSync(path.join(root, 'README.md'), 'utf8')
    const once = pass(source)
    for (const line of source.split('\n')) {
      if (line.startsWith('<') || line.startsWith('```') || line.startsWith('| ')) expect(once).toContain(line.trim())
    }
    expect(once).not.toContain('&lt;')
  })

  it('keeps the ROADMAP’s task lists, checked and unchecked, and its nested lists', () => {
    const source = readFileSync(path.join(root, 'ROADMAP.md'), 'utf8')
    const once = pass(source)
    const count = (text: string, marker: string): number => text.split(marker).length - 1
    expect(count(once, '- [x] ')).toBe(count(source, '- [x] '))
    expect(count(once, '- [ ] ')).toBe(count(source, '- [ ] '))
    expect(count(once, '\n  - ')).toBe(count(source, '\n  - '))
    expect(once).not.toContain('```\n  ```')
  })
})

describe('constructs', () => {
  it('round-trips every block the slash menu can insert', () => {
    const source = [
      '# Title',
      '',
      '## Second',
      '',
      '### Third',
      '',
      'Plain **bold** *italic* ~~gone~~ `code` [link](https://example.com/a) <https://example.com/b>',
      '',
      '- one',
      '- two',
      '  - nested',
      '    1. deep',
      '',
      '1. first',
      '2. second',
      '',
      '- [ ] todo',
      '- [x] done',
      '',
      '> quoted',
      '',
      '```ts',
      'const x = 1',
      '```',
      '',
      '---',
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 \\| 3 |',
      '',
      '![alt](docs/shot.png)',
      '',
      'line one\\',
      'line two',
      ''
    ].join('\n')
    expect(pass(source)).toBe(source)
  })

  it('reads a lone link to claude.ai as an artifact card and writes it back as the link', () => {
    const doc = parseMarkdown('[abc123](https://claude.ai/code/artifacts/abc123)\n')
    expect(doc.content?.[0]).toEqual({
      type: 'artifactCard',
      attrs: { url: 'https://claude.ai/code/artifacts/abc123', title: 'abc123' }
    })
    expect(serializeMarkdown(doc)).toBe('[abc123](https://claude.ai/code/artifacts/abc123)\n')
    // Any other link, or a link with words beside it, stays a paragraph.
    expect(parseMarkdown('[x](https://example.com/x)\n').content?.[0]?.type).toBe('paragraph')
    expect(parseMarkdown('see [x](https://claude.ai/code/artifacts/x)\n').content?.[0]?.type).toBe('paragraph')
  })

  it('keeps inline HTML and block HTML as written', () => {
    const source = '<p align="center"><b>x</b></p>\n\nline with <br/> inside\n'
    expect(pass(source)).toBe(source)
  })

  it('reads a heading deeper than three as a third-level one', () => {
    expect(pass('#### four\n')).toBe('### four\n')
  })

  it('writes an empty document as nothing', () => {
    expect(serializeMarkdown({ type: 'doc', content: [{ type: 'paragraph' }] })).toBe('')
    expect(parseMarkdown('').type).toBe('doc')
  })
})

describe('lists side by side', () => {
  it('keeps a bullet list and the task list after it apart', () => {
    const text = '- one\n- two\n\n* [ ] task\n'
    const doc = parseMarkdown(text)
    expect(doc.content?.map((node) => node.type)).toEqual(['bulletList', 'taskList'])
    expect(pass(text)).toBe(text)
  })

  it('keeps two numbered lists apart', () => {
    const text = '1. one\n\n1) again\n'
    expect(parseMarkdown(text).content?.map((node) => node.type)).toEqual(['orderedList', 'orderedList'])
    expect(pass(text)).toBe(text)
  })
})
