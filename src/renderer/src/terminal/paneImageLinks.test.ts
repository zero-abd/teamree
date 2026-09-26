/** @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest'
import type { ILink, ILinkProvider } from '@xterm/xterm'
import { Terminal as XTerm } from '@xterm/xterm'
import {
  paneImageLinks,
  pastedImageLookup,
  printedImages,
  type ImageLinkHost,
  type PastedImage
} from './paneImageLinks'

const IMAGE: PastedImage = { url: 'teamree-file://grant/t/2.png?v=1', path: '/tmp/claude-501/x/s/images/2.png' }

/** A real emulator with the image links on it, and what its provider offers for a row. */
function pane(host: Partial<ImageLinkHost>) {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 24 })
  let provider: ILinkProvider | undefined
  const register = term.registerLinkProvider.bind(term)
  term.registerLinkProvider = (registered) => {
    provider = registered
    return register(registered)
  }
  term.open(element)
  const full: ImageLinkHost = {
    find: async () => null,
    hover: () => {},
    leave: () => {},
    open: () => {},
    ...host
  }
  paneImageLinks(term, full)
  return {
    write: (data: string) => new Promise<void>((resolve) => term.write(data, () => setTimeout(resolve, 0))),
    links: (row: number) =>
      new Promise<ILink[]>((resolve) => provider?.provideLinks(row, (links) => resolve(links ?? [])))
  }
}

describe('printedImages', () => {
  it('finds every placeholder on a row, with its number and columns', () => {
    expect(printedImages('> [Image #2] and [Image #13] look')).toEqual([
      { index: 2, start: 2, end: 12 },
      { index: 13, start: 17, end: 28 }
    ])
  })

  it('ignores what only looks like one', () => {
    expect(printedImages('[Image] [Image #] [image #2] [Image #x] Image #2')).toEqual([])
  })
})

describe('pastedImageLookup', () => {
  it('asks once per number while the answer is fresh, then again', async () => {
    let clock = 0
    const ask = vi.fn(async () => IMAGE)
    const lookup = pastedImageLookup(ask, () => clock)
    await lookup(2)
    await lookup(2)
    expect(ask).toHaveBeenCalledTimes(1)
    clock = 10_000
    await lookup(2)
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('reads a failed ask as no image', async () => {
    const lookup = pastedImageLookup(async () => {
      throw new Error('runtime gone')
    })
    expect(await lookup(1)).toBeNull()
  })
})

describe('an [Image #N] printed in a pane', () => {
  it('is a link when the image is on disk, and plain text when it is not', async () => {
    const view = pane({ find: async (index) => (index === 2 ? IMAGE : null) })
    await view.write('> [Image #1] [Image #2] compare\r\n')

    const links = await view.links(1)

    expect(links.map((link) => [link.text, link.range.start.x, link.range.end.x])).toEqual([['[Image #2]', 14, 23]])
  })

  it('offers nothing on a row without a placeholder, without asking', async () => {
    const find = vi.fn(async () => IMAGE)
    const view = pane({ find })
    await view.write('no images here\r\n')

    expect(await view.links(1)).toEqual([])
    expect(find).not.toHaveBeenCalled()
  })

  it('opens the image on a click and peeks at it on hover', async () => {
    const open = vi.fn()
    const hover = vi.fn()
    const leave = vi.fn()
    const view = pane({ find: async () => IMAGE, open, hover, leave })
    await view.write('[Image #2]\r\n')

    const [link] = await view.links(1)
    const event = new MouseEvent('mousemove', { clientX: 5, clientY: 6 })
    link?.hover?.(event, link.text)
    link?.leave?.(event, link.text)
    link?.activate(new MouseEvent('click'), link.text)

    expect(hover).toHaveBeenCalledWith({ ...IMAGE, index: 2 }, event)
    expect(leave).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith({ ...IMAGE, index: 2 })
  })
})
