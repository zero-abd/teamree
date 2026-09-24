/** @vitest-environment jsdom */
import { Editor } from '@tiptap/core'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Slice } from '@tiptap/pm/model'
import { serializeMarkdown } from './markdownDocument'
import { markdownExtensions } from './markdownExtensions'
import { readMarkdownFile, writeMarkdownFile } from './markdownFile'
import { MarkdownPaste } from './markdownPaste'
import { runSlashItem, slashItems } from './slashCommands'

let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
})

function page(content?: string): Editor {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: [...markdownExtensions(), MarkdownPaste],
    ...(content === undefined ? {} : { content: readMarkdownFile(content).doc })
  })
  return editor
}

const written = (target: Editor): string => serializeMarkdown(target.getJSON())

/** Presses a key as the keyboard would, through the editor's own shortcuts. */
function press(target: Editor, key: string, shiftKey = false): boolean {
  const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })
  return target.view.someProp('handleKeyDown', (handler) => handler(target.view, event)) ?? false
}

/** Pastes as the clipboard would; true when the page took the paste itself. */
function paste(target: Editor, text: string, html = ''): boolean {
  const data = {
    types: html ? ['text/plain', 'text/html'] : ['text/plain'],
    getData: (type: string) => ({ 'text/plain': text, 'text/html': html })[type] ?? ''
  }
  const event = Object.assign(new Event('paste'), { clipboardData: data }) as unknown as ClipboardEvent
  return target.view.someProp('handlePaste', (handler) => handler(target.view, event, Slice.empty)) ?? false
}

/** Puts the caret at the end of the first text holding `text`. */
function caretAfter(target: Editor, text: string): void {
  let at = -1
  target.state.doc.descendants((node, pos) => {
    if (at === -1 && node.isText && node.text?.includes(text)) at = pos + node.text.indexOf(text) + text.length
  })
  target.commands.setTextSelection(at)
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
    expect(slash('callout')).toBe('> [!NOTE]\n')
    expect(slash('quote')).toBe('>\n')
    expect(slash('code')).toBe('```\n\n```\n')
  })

  it('asks for the path of an image, and the link of an artifact, before inserting either', () => {
    for (const [query, typed] of [
      ['image', '/image '],
      ['artifact', '/artifact ']
    ] as const) {
      const target = page()
      target.commands.insertContent(`/${query}`)
      const [item] = slashItems(query)
      runSlashItem(target, { from: 1, to: target.state.doc.content.size - 1 }, item!)
      expect(target.state.doc.textContent).toBe(typed)
    }
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
    ['```ts ', '```ts\n\n```\n'],
    ['## Section', '## Section\n'],
    ['### Small', '### Small\n'],
    ['1. first', '1. first\n'],
    ['* star', '- star\n'],
    ['[] task', '- [ ] task\n'],
    ['---', '---\n']
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

describe('lists', () => {
  it('nest under the item above with Tab and come back out with Shift-Tab', () => {
    const target = page('- one\n- two\n')
    caretAfter(target, 'two')
    expect(press(target, 'Tab')).toBe(true)
    expect(written(target)).toBe('- one\n  - two\n')
    expect(press(target, 'Tab', true)).toBe(true)
    expect(written(target)).toBe('- one\n- two\n')
  })

  it('nest to-dos the same way', () => {
    const target = page('- [ ] one\n- [x] two\n')
    caretAfter(target, 'two')
    press(target, 'Tab')
    expect(written(target)).toBe('- [ ] one\n  - [x] two\n')
  })
})

describe('pasting markdown', () => {
  it('turns pasted markdown into the blocks it spells', () => {
    const target = page()
    expect(paste(target, '# Plan\n\n- one\n- [ ] two\n\n> [!TIP]\n> Go.\n')).toBe(true)
    expect(written(target)).toBe('# Plan\n\n- one\n- [ ] two\n\n> [!TIP]\n> Go.\n')
  })

  it('pastes inline markdown into the line the caret is on', () => {
    const target = page('(here)\n')
    caretAfter(target, '(')
    expect(paste(target, 'a **bold** [link](https://example.com) ')).toBe(true)
    expect(written(target)).toBe('(a **bold** [link](https://example.com)here)\n')
  })

  it('leaves plain words, rich copies and code blocks to the default paste', () => {
    expect(paste(page(), 'just words')).toBe(false)
    expect(paste(page(), '# Plan', '<h1>Plan</h1>')).toBe(false)
    const code = page('```\nx\n```\n')
    caretAfter(code, 'x')
    expect(paste(code, '# not a heading')).toBe(false)
  })
})

describe('a page opened on a file', () => {
  const root = path.resolve(import.meta.dirname, '../../../..')
  it.each([
    'README.md',
    'ROADMAP.md',
    ...['tasks', 'tables', 'code', 'misc', 'html', 'callouts'].map(
      (name) => `src/renderer/src/markdown/fixtures/${name}.md`
    )
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
