/** @vitest-environment jsdom */
import { Editor } from '@tiptap/core'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runSlashItem } from './MarkdownEditor'
import { serializeMarkdown } from './markdownDocument'
import { markdownExtensions } from './markdownExtensions'
import { readMarkdownFile, writeMarkdownFile } from './markdownFile'
import { slashItems } from './slashCommands'

let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
})

function page(): Editor {
  editor = new Editor({ element: document.createElement('div'), extensions: markdownExtensions() })
  return editor
}

/** Types `/query` into an empty page and picks the first row, as Enter would. */
function slash(query: string): string {
  const target = page()
  target.commands.insertContent(`/${query}`)
  const [item] = slashItems(query)
  if (item === undefined) throw new Error(`no row for ${query}`)
  runSlashItem(target, { from: 1, to: target.state.doc.content.size - 1 }, item)
  return serializeMarkdown(target.getJSON())
}

/** Types text one keystroke at a time, so the input rules see it. */
function type(target: Editor, text: string): void {
  for (const char of text) {
    const { from, to } = target.state.selection
    const handled = target.view.someProp('handleTextInput', (handler) =>
      handler(target.view, from, to, char, () => target.state.tr)
    )
    if (!handled) target.view.dispatch(target.state.tr.insertText(char, from, to))
  }
}

describe('the / menu', () => {
  it('turns the line into the block it names, and the file says so', () => {
    expect(slash('heading 1')).toBe('#\n')
    expect(slash('bulleted')).toBe('-\n')
    expect(slash('to-do')).toBe('- [ ]\n')
    expect(slash('divider')).toBe('---\n')
    expect(slash('table')).toMatch(/^\|\s+\|\s+\|\s+\|\n\| --- \| --- \| --- \|\n/)
  })

  it('inserts an artifact card that is written as a link', () => {
    expect(slash('artifact https://claude.ai/public/artifacts/abc')).toBe(
      '[abc](https://claude.ai/public/artifacts/abc)\n'
    )
  })
})

describe('markdown typed as markdown', () => {
  it.each([
    ['# Title', '# Title\n'],
    ['- item', '- item\n'],
    ['[ ] task', '- [ ] task\n'],
    ['> quoted', '> quoted\n'],
    ['```ts ', '```ts\n\n```\n']
  ])('%s becomes the block it spells', (typed, written) => {
    const target = page()
    type(target, typed)
    expect(serializeMarkdown(target.getJSON())).toBe(written)
  })
})

it('wraps `[ ] ` typed on a line in a task list', () => {
  const target = page()
  type(target, '[ ] task')
  expect(target.getJSON().content?.[0]?.type).toBe('taskList')
})

describe('a page opened on a file', () => {
  const root = path.resolve(import.meta.dirname, '../../../..')
  it.each([
    'README.md',
    'ROADMAP.md',
    ...['tasks', 'tables', 'code', 'misc', 'html'].map((name) => `src/renderer/src/markdown/fixtures/${name}.md`)
  ])('%s is written back unchanged after the page takes focus', (name) => {
    const text = readFileSync(path.join(root, name), 'utf8')
    const file = readMarkdownFile(text)
    editor = new Editor({ element: document.createElement('div'), extensions: markdownExtensions(), content: file.doc })
    expect(editor.getJSON()).toEqual(file.doc)
    editor.commands.focus('end')
    editor.commands.focus('start')
    expect(writeMarkdownFile(editor.getJSON(), file)).toBe(text)
  })
})
