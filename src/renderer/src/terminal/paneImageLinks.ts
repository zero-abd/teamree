// `[Image #N]` in a pane, as a link to the image Claude Code stored for it. Offered only once
// the file is found, so a placeholder whose file is gone stays plain text.

import type { IDisposable, ILink, ILinkProvider, Terminal as XTerm } from '@xterm/xterm'

/** A placeholder as printed: its number and where it sits on the row (0-based, end exclusive). */
export type PrintedImage = { index: number; start: number; end: number }

/** What the runtime answers for one: a URL to draw and the path to reveal. */
export type PastedImage = { url: string; path: string }

/** One the pane can show, with the number it was printed under. */
export type ShownImage = PastedImage & { index: number }

const PLACEHOLDER = /\[Image #(\d{1,7})\]/gu

export function printedImages(row: string): PrintedImage[] {
  return [...row.matchAll(PLACEHOLDER)].map((match) => ({
    index: Number(match[1]),
    start: match.index,
    end: match.index + match[0].length
  }))
}

/** How long one answer stands: a hover asks for every row the pointer crosses. */
const FRESH_MS = 5_000

/** `ask`, remembered per number for a few seconds; a failure is no image. */
export function pastedImageLookup(
  ask: (index: number) => Promise<PastedImage | null>,
  now: () => number = Date.now
): (index: number) => Promise<PastedImage | null> {
  const known = new Map<number, { at: number; answer: Promise<PastedImage | null> }>()
  return (index) => {
    const hit = known.get(index)
    if (hit !== undefined && now() - hit.at < FRESH_MS) return hit.answer
    const answer = ask(index).catch(() => null)
    known.set(index, { at: now(), answer })
    return answer
  }
}

export type ImageLinkHost = {
  find: (index: number) => Promise<PastedImage | null>
  hover: (image: ShownImage, event: MouseEvent) => void
  leave: () => void
  open: (image: ShownImage) => void
}

export function paneImageLinks(term: Pick<XTerm, 'registerLinkProvider' | 'buffer'>, host: ImageLinkHost): IDisposable {
  const provider: ILinkProvider = {
    provideLinks(y, callback) {
      const row = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? ''
      const printed = printedImages(row)
      // Answered at once when there is nothing to look up: xterm waits for every provider.
      if (printed.length === 0) return callback(undefined)
      void Promise.all(printed.map((entry) => host.find(entry.index))).then((found) => {
        const links = printed.flatMap((entry, at): ILink[] => {
          const image = found[at]
          if (image === null || image === undefined) return []
          const shown = { ...image, index: entry.index }
          return [
            {
              range: { start: { x: entry.start + 1, y }, end: { x: entry.end, y } },
              text: row.slice(entry.start, entry.end),
              decorations: { underline: true, pointerCursor: true },
              activate: () => host.open(shown),
              hover: (event) => host.hover(shown, event),
              leave: () => host.leave()
            }
          ]
        })
        callback(links.length === 0 ? undefined : links)
      })
    }
  }
  return term.registerLinkProvider(provider)
}
