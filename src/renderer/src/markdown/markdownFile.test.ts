import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { JSONContent } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { readMarkdownFile, writeMarkdownFile } from './markdownFile'

const root = path.resolve(import.meta.dirname, '../../../..')
const fixtures = path.join(import.meta.dirname, 'fixtures')

function markdownUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return markdownUnder(full)
    return entry.name.endsWith('.md') ? [full] : []
  })
}

const corpus = [
  ...['README.md', 'ROADMAP.md', 'CONTRIBUTING.md', 'brand/BRAND.md'].map((name) => path.join(root, name)),
  ...markdownUnder(path.join(root, 'docs')),
  ...markdownUnder(fixtures)
]

const unchanged = (text: string): string => {
  const file = readMarkdownFile(text)
  return writeMarkdownFile(file.doc, file)
}

/** The document with the first text run holding `from` rewritten to hold `to` instead. */
function edit(doc: JSONContent, from: string, to: string): JSONContent {
  const copy = structuredClone(doc)
  let done = false
  const walk = (node: JSONContent): void => {
    if (done) return
    if (node.type === 'text' && node.text?.includes(from)) {
      node.text = node.text.replace(from, to)
      done = true
      return
    }
    node.content?.forEach(walk)
  }
  walk(copy)
  if (!done) throw new Error(`no text holds ${from}`)
  return copy
}

/** The first node of `type` whose text holds `holding`, changed in place by `change`. */
function editNode(doc: JSONContent, type: string, holding: string, change: (node: JSONContent) => void): JSONContent {
  const copy = structuredClone(doc)
  const text = (node: JSONContent): string => node.text ?? (node.content ?? []).map(text).join('')
  // Innermost first, so a nested item is found before the item holding it.
  const walk = (node: JSONContent): boolean => {
    if ((node.content ?? []).some(walk)) return true
    if (node.type !== type || !text(node).includes(holding)) return false
    change(node)
    return true
  }
  if (!walk(copy)) throw new Error(`no ${type} holds ${holding}`)
  return copy
}

/** The lines only one side has, by a longest common subsequence of lines. */
function changedLines(before: string, after: string): { removed: string[]; added: string[] } {
  const a = before.split('\n')
  const b = after.split('\n')
  const table = Array.from({ length: a.length + 1 }, () => Array.from({ length: b.length + 1 }, () => 0))
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }
  const removed: string[] = []
  const added: string[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i += 1
      j += 1
    } else if (j >= b.length || (i < a.length && table[i + 1]![j]! >= table[i]![j + 1]!)) removed.push(a[i++]!)
    else added.push(b[j++]!)
  }
  return { removed, added }
}

describe('a file opened and left alone', () => {
  it('has a corpus of every construct and the repo’s own documents', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(20)
  })

  it.each(corpus.map((file) => [path.relative(root, file), file]))('%s is written back byte for byte', (_, file) => {
    const text = readFileSync(file, 'utf8')
    expect(unchanged(text)).toBe(text)
  })

  it.each([
    ['CRLF endings', '# Title\r\n\r\n- [x] done\r\n- [ ] open\r\n'],
    ['no final newline', 'para\n\n- [x] done'],
    ['blank lines at both ends', '\n\n\npara\n\n\n\n'],
    ['only whitespace', '  \n\n'],
    ['nothing', ''],
    ['tabs', '-\t[x]\tdone\n\n\tcode\n'],
    ['an empty item', '-\n- [ ]\n-   \n'],
    [
      'a mixed list',
      '- [x] Health endpoint\n- [ ] Metrics\n- Links like [the docs](https://example.com) stay readable.\n'
    ]
  ])('%s are kept', (_, text) => {
    expect(unchanged(text)).toBe(text)
  })
})

describe('an edit', () => {
  it('to one paragraph of the README changes only that paragraph’s lines', () => {
    const text = readFileSync(path.join(root, 'README.md'), 'utf8')
    const file = readMarkdownFile(text)
    const paragraph = text.split('\n').find((line) => /^[A-Z][a-z]+ [a-z]/.test(line))!
    const word = paragraph.split(' ')[0]!
    const written = writeMarkdownFile(edit(file.doc, `${word} `, `${word} really `), file)
    const { removed, added } = changedLines(text, written)
    expect(removed).toEqual([paragraph])
    expect(added).toEqual([paragraph.replace(`${word} `, `${word} really `)])
  })

  it('to a checkbox changes that one line, however deep', () => {
    const text = readFileSync(path.join(fixtures, 'tasks.md'), 'utf8')
    const file = readMarkdownFile(text)
    const check = (holding: string): JSONContent =>
      editNode(file.doc, 'taskItem', holding, (node) => {
        node.attrs = { ...node.attrs, checked: !node.attrs?.checked }
      })
    expect(changedLines(text, writeMarkdownFile(check('Metrics'), file))).toEqual({
      removed: ['- [ ] Metrics'],
      added: ['- [x] Metrics']
    })
    expect(changedLines(text, writeMarkdownFile(check('capital X'), file))).toEqual({
      removed: ['    - [X] capital X, deeper'],
      added: ['    - [ ] capital X, deeper']
    })
    expect(changedLines(text, writeMarkdownFile(check('ordered open'), file))).toEqual({
      removed: ['2. [ ] ordered open'],
      added: ['2. [x] ordered open']
    })
  })

  it('to one list item leaves the others’ markers and text alone', () => {
    const text = readFileSync(path.join(fixtures, 'tasks.md'), 'utf8')
    const file = readMarkdownFile(text)
    const written = writeMarkdownFile(edit(file.doc, 'nested open', 'nested still open'), file)
    expect(changedLines(text, written)).toEqual({
      removed: ['  * [ ] nested open'],
      added: ['  * [ ] nested still open']
    })
  })

  it('to a table cell changes that row and keeps the alignment row', () => {
    const text = readFileSync(path.join(fixtures, 'tables.md'), 'utf8')
    const file = readMarkdownFile(text)
    const written = writeMarkdownFile(edit(file.doc, 'd', 'D'), file)
    const { removed, added } = changedLines(text, written)
    expect(removed).toEqual(['| a    |   b    |     c | d    |'])
    expect(added).toHaveLength(1)
    expect(written).toContain('|:-----|:------:|------:|------|')
  })

  it('to code keeps the fence and its info string', () => {
    const text = readFileSync(path.join(fixtures, 'code.md'), 'utf8')
    const file = readMarkdownFile(text)
    const written = writeMarkdownFile(edit(file.doc, 'const a = 1', 'const a = 2'), file)
    expect(changedLines(text, written)).toEqual({ removed: ['const a = 1'], added: ['const a = 2'] })
    const tilde = writeMarkdownFile(edit(file.doc, 'def f():', 'def g():'), file)
    expect(changedLines(text, tilde)).toEqual({ removed: ['def f():'], added: ['def g():'] })
  })

  it('writes a changed paragraph without escaping what never needed it', () => {
    const text = readFileSync(path.join(fixtures, 'escapes.md'), 'utf8')
    const file = readMarkdownFile(text)
    const literal = text.split('\n').find((line) => line.startsWith('Literal'))!
    const written = writeMarkdownFile(edit(file.doc, 'Literal', 'Plain literal'), file)
    expect(changedLines(text, written)).toEqual({
      removed: [literal],
      added: [literal.replace('Literal', 'Plain literal')]
    })
    const escaped = text.split('\n').find((line) => line.startsWith('Escaped'))!
    const again = writeMarkdownFile(edit(file.doc, 'Escaped', 'Still escaped'), file)
    expect(changedLines(text, again)).toEqual({
      removed: [escaped],
      added: [escaped.replace('Escaped', 'Still escaped')]
    })
  })

  it('adds a new paragraph as added lines only, and a deleted one as removed lines only', () => {
    const text = '# Title\n\nFirst.\n\nSecond.\n\n[ref]: https://example.com\n\nThird.\n'
    const file = readMarkdownFile(text)
    const content = file.doc.content ?? []
    const added = {
      ...file.doc,
      content: [
        ...content.slice(0, 2),
        { type: 'paragraph', content: [{ type: 'text', text: 'New.' }] },
        ...content.slice(2)
      ]
    }
    expect(changedLines(text, writeMarkdownFile(added, file))).toEqual({ removed: [], added: ['New.', ''] })
    const removed = { ...file.doc, content: content.filter((_, index) => index !== 2) }
    const written = writeMarkdownFile(removed, file)
    expect(changedLines(text, written)).toEqual({ removed: ['Second.', ''], added: [] })
    expect(written).toContain('[ref]: https://example.com')
  })

  it('keeps a file’s CRLF endings and its missing final newline', () => {
    const crlf = readMarkdownFile('# Title\r\n\r\nOld.\r\n')
    expect(writeMarkdownFile(edit(crlf.doc, 'Old', 'New'), crlf)).toBe('# Title\r\n\r\nNew.\r\n')
    const bare = readMarkdownFile('# Title\n\nOld.')
    expect(writeMarkdownFile(edit(bare.doc, 'Old', 'New'), bare)).toBe('# Title\n\nNew.')
  })

  it('writes the whole document anew when the pieces would not read back the same', () => {
    const text = '- one\n\npara\n\n* two\n'
    const file = readMarkdownFile(text)
    const content = file.doc.content ?? []
    const joined = {
      ...file.doc,
      content: [
        content[0]!,
        {
          type: 'bulletList',
          content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'mid' }] }] }]
        },
        content[2]!
      ]
    }
    const written = writeMarkdownFile(joined, file)
    const reread = readMarkdownFile(written)
    expect(reread.doc).toEqual(joined)
  })
})
