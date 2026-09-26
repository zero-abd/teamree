// Which pasted images belong to the prompt still being written, read off Claude Code's screen.
// The draft and sent screens are the recorded 2.1.280 frame with its prompt rows rewritten.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Terminal as XTerm } from '@xterm/xterm'
import { promptImageIndices, screenOf, stripImages, watchPromptImages } from './promptImages'
import type { PastedImage, ShownImage } from './paneImageLinks'

const fixture = (name: string): string =>
  readFileSync(path.join(import.meta.dirname, '../../../main/terminals/fixtures', name), 'utf8')

const DRAFT = fixture('claude-images-draft.txt')
const SENT = fixture('claude-images-sent.txt')
const PERMISSION = fixture('claude-permission.txt')

const RULE = '─'.repeat(60)

function emulator(): XTerm {
  return new XTerm({ cols: 100, rows: 30, allowProposedApi: true })
}

function write(term: XTerm, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

async function rowsOf(data: string): Promise<string[]> {
  const term = emulator()
  await write(term, data)
  return screenOf(term)
}

describe('promptImageIndices', () => {
  it('reads the placeholders in the input box of a draft', async () => {
    expect(promptImageIndices(await rowsOf(DRAFT))).toEqual([1, 2])
  })

  it('finds none once the prompt is sent, though the placeholders are still on screen', async () => {
    const rows = await rowsOf(SENT)
    expect(rows.join('\n')).toContain('[Image #1] [Image #2]')
    expect(promptImageIndices(rows)).toEqual([])
  })

  it('does not know while a dialog covers the input', async () => {
    expect(promptImageIndices(await rowsOf(PERMISSION))).toBeNull()
  })

  it('does not know on a screen with no input box', () => {
    expect(promptImageIndices(['% cat notes', 'see [Image #3]', '% '])).toBeNull()
  })

  it('reads a placeholder the input wrapped across two rows', () => {
    const rows = [
      '⏺ Done.',
      RULE,
      '❯ compare the header in [Image #4] with the one in [Image',
      '  #5] please',
      RULE,
      ''
    ]
    expect(promptImageIndices(rows)).toEqual([4, 5])
  })

  it('reads the boxed input of older versions', () => {
    const rows = [`╭${RULE}╮`, '│ > [Image #2] and [Image #2] again │', `╰${RULE}╯`, '  ? for shortcuts']
    expect(promptImageIndices(rows)).toEqual([2])
  })

  it('reads an input drawn inline, high on a screen with nothing under it', () => {
    const rows = [
      '▐▛███▜▌ Claude Code',
      '',
      RULE,
      '❯ [Image #1] look',
      RULE,
      '  ? for shortcuts',
      ...Array.from({ length: 30 }, () => '')
    ]
    expect(promptImageIndices(rows)).toEqual([1])
  })

  it('ignores a pair of rules far above the bottom of the screen', () => {
    const rows = [RULE, '❯ [Image #1]', RULE, ...Array.from({ length: 20 }, () => 'output')]
    expect(promptImageIndices(rows)).toBeNull()
  })
})

describe('stripImages', () => {
  const one = { index: 1, url: 'teamree-file://a/1', path: '/t/a/images/1.png' }
  const two = { index: 2, url: 'teamree-file://a/2', path: '/t/a/images/2.png' }

  it('leaves out what was taken off, by file', () => {
    expect(stripImages([one, two], new Set([two.path]))).toEqual([one])
  })

  it('shows a new session’s image under a number that was taken off before', () => {
    const fresh = { index: 2, url: 'teamree-file://b/2', path: '/t/b/images/2.png' }
    expect(stripImages([fresh], new Set([two.path]))).toEqual([fresh])
  })
})

describe('watchPromptImages', () => {
  const files: Record<number, PastedImage> = {
    1: { url: 'teamree-file://s/1', path: '/t/s/images/1.png' },
    2: { url: 'teamree-file://s/2', path: '/t/s/images/2.png' }
  }

  async function watched(find: (index: number) => Promise<PastedImage | null> = async (index) => files[index] ?? null) {
    const term = emulator()
    const seen: ShownImage[][] = []
    const watch = watchPromptImages(
      term,
      find,
      (images) => seen.push(images),
      (run) => queueMicrotask(run)
    )
    const settle = async (): Promise<void> => {
      for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setTimeout(resolve, 0))
    }
    return { term, seen, watch, settle }
  }

  it('shows a draft’s images and clears them when it is sent', async () => {
    const { term, seen, settle } = await watched()
    await write(term, DRAFT)
    await settle()
    expect(seen.at(-1)?.map((image) => image.index)).toEqual([1, 2])
    await write(term, '\x1b[H\x1b[2J' + SENT)
    await settle()
    expect(seen.at(-1)).toEqual([])
  })

  it('clears on /clear, which leaves an empty input', async () => {
    const { term, seen, settle } = await watched()
    await write(term, DRAFT)
    await settle()
    await write(term, `\x1b[H\x1b[2J\x1b[26;1H${'─'.repeat(100)}\r\n❯ \r\n${'─'.repeat(100)}`)
    await settle()
    expect(seen.at(-1)).toEqual([])
  })

  it('keeps what it showed while a dialog hides the input', async () => {
    const { term, seen, settle } = await watched()
    await write(term, DRAFT)
    await settle()
    const shown = seen.length
    await write(term, '\x1b[H\x1b[2J' + PERMISSION)
    await settle()
    expect(seen).toHaveLength(shown)
  })

  it('leaves out a placeholder whose file is not there', async () => {
    const { term, seen, settle } = await watched(async (index) => (index === 2 ? files[2]! : null))
    await write(term, DRAFT)
    await settle()
    expect(seen.at(-1)?.map((image) => image.index)).toEqual([2])
  })

  it('stops reading once disposed', async () => {
    const { term, seen, watch, settle } = await watched()
    watch.dispose()
    await write(term, DRAFT)
    await settle()
    expect(seen).toEqual([])
  })
})
