// The pasted images in the prompt Claude Code is still composing, read off the screen: its
// input sits between two rules at the bottom. A sent prompt moves up into the transcript.

import type { IDisposable, Terminal as XTerm } from '@xterm/xterm'
import { printedImages, type PastedImage, type ShownImage } from './paneImageLinks'

const RULE = /^[╭╰]?─{8,}[╮╯]?$/u
const INPUT_START = /^│?\s*[❯>]/u
/** Below the input only the footer and a suggestion list; a rule further up is some other box. */
const BOTTOM_REACH = 16

/** The screen's rows, right-trimmed, ignoring where the viewport is scrolled to. */
export function screenOf(term: Pick<XTerm, 'buffer' | 'rows'>): string[] {
  const buffer = term.buffer.active
  const rows: string[] = []
  for (let row = buffer.baseY; row < buffer.baseY + term.rows; row++) {
    rows.push(buffer.getLine(row)?.translateToString(true) ?? '')
  }
  return rows
}

/** The image numbers in the input box, in order; null when no input box is showing. */
export function promptImageIndices(rows: readonly string[]): number[] | null {
  const isRule = (row: string | undefined): boolean => RULE.test(row?.trim() ?? '')
  // Drawn inline, the input can sit high on a screen with nothing under it yet.
  let end = rows.length - 1
  while (end > 0 && rows[end]!.trim() === '') end--
  let bottom = end
  while (bottom >= Math.max(1, end - BOTTOM_REACH) && !isRule(rows[bottom])) bottom--
  if (!isRule(rows[bottom])) return null
  let top = bottom - 1
  while (top >= 0 && !isRule(rows[top])) top--
  const input = rows.slice(top + 1, bottom)
  if (top < 0 || input.length === 0 || !INPUT_START.test(input[0]!)) return null
  // Joined with a space so a placeholder the input wrapped at its space reads whole.
  const text = input
    .map((row) =>
      row
        .replace(/^\s*│?\s*[❯>]?/u, '')
        .replace(/│\s*$/u, '')
        .trim()
    )
    .join(' ')
  return [...new Set(printedImages(text).map((image) => image.index))]
}

/** The prompt's images less the ones taken off, by file: a new session reuses the numbers. */
export function stripImages(images: readonly ShownImage[], removed: ReadonlySet<string>): ShownImage[] {
  return images.filter((image) => !removed.has(image.path))
}

const SCAN_MS = 150

/**
 * Reports the prompt's images whenever they change. While a dialog hides the input it keeps
 * quiet; the strip shows what it last knew.
 */
export function watchPromptImages(
  term: Pick<XTerm, 'buffer' | 'rows' | 'onWriteParsed'>,
  find: (index: number) => Promise<PastedImage | null>,
  onChange: (images: ShownImage[]) => void,
  schedule: (run: () => void) => void = (run) => setTimeout(run, SCAN_MS)
): IDisposable {
  let alive = true
  let queued = false
  let asked = 0
  let last = ''

  const scan = (): void => {
    queued = false
    if (!alive) return
    const indices = promptImageIndices(screenOf(term))
    if (indices === null) return
    const ask = ++asked
    void Promise.all(indices.map((index) => find(index))).then((found) => {
      if (!alive || ask !== asked) return
      const images = found.flatMap((image, at) => (image === null ? [] : [{ ...image, index: indices[at]! }]))
      const key = images.map((image) => `${image.index} ${image.url}`).join('\n')
      if (key === last) return
      last = key
      onChange(images)
    })
  }
  const queue = (): void => {
    if (queued) return
    queued = true
    schedule(scan)
  }

  const parsed = term.onWriteParsed(queue)
  queue()
  return {
    dispose: () => {
      alive = false
      parsed.dispose()
    }
  }
}
