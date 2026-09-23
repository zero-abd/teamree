/** @vitest-environment jsdom */

// A URL an agent printed, and what a click on it does.
//
// Two halves, and the seam between them is the interesting part. The first is
// that the emulator offers a link at all — a bare `https://…` in the scrollback
// is a run of characters and nothing else until the addon looks at it, and
// whether the addon is loaded is a fact about `TerminalView` that no amount of
// reading the source proves. So this drives a real `XTerm`, writes a URL into
// it, and asks the link provider the addon registered what it can see there.
//
// The second is that activating one ends in `window.open` and nowhere else,
// because that is the single decision the main process already makes — see
// `src/main/windowNavigation.ts`, where the other half of it is tested. A link
// that reached `shell.openExternal` by some other route would be a second
// answer to the same question.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ILink, ILinkProvider } from '@xterm/xterm'
import { Terminal as XTerm } from '@xterm/xterm'
import { openPaneLink, paneLinkAddon, PANE_LINK_HANDLER } from './TerminalView'

const opened: Array<string | undefined> = []

beforeEach(() => {
  opened.length = 0
  vi.stubGlobal(
    'open',
    vi.fn((url?: string | URL) => {
      opened.push(typeof url === 'string' ? url : url?.toString())
      return null
    })
  )
})

/** A pane with the link addon on it, and the provider it registered. */
function pane(): { write: (data: string) => Promise<void>; links: (row: number) => Promise<ILink[]> } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 24 })
  const providers: ILinkProvider[] = []
  const register = term.registerLinkProvider.bind(term)
  term.registerLinkProvider = (provider) => {
    providers.push(provider)
    return register(provider)
  }
  term.open(host)
  term.loadAddon(paneLinkAddon())

  return {
    write: (data) =>
      new Promise<void>((resolve) => {
        term.write(data, () => setTimeout(resolve, 0))
      }),
    links: async (row) => {
      const found = await Promise.all(
        providers.map(
          (provider) => new Promise<ILink[]>((resolve) => provider.provideLinks(row, (links) => resolve(links ?? [])))
        )
      )
      return found.flat()
    }
  }
}

describe('a URL printed in a pane', () => {
  it('is offered as a link by the addon the pane loads', async () => {
    const view = pane()
    await view.write('opened https://github.com/zero-abd/teamree/pull/7 for review\r\n')

    const links = await view.links(1)

    expect(links.map((link) => link.text)).toEqual(['https://github.com/zero-abd/teamree/pull/7'])
  })

  it('goes to the browser when it is activated, and opens no window here', async () => {
    const view = pane()
    await view.write('see https://example.com/x\r\n')

    const [link] = await view.links(1)
    link?.activate(new MouseEvent('click'), link.text)

    expect(opened).toEqual(['https://example.com/x'])
  })

  // The other kind: `gh` and `npm` print these, where the URL is in the escape
  // sequence and what is on screen is a label. xterm finds them itself and
  // activates them through the handler the pane hands it, rather than through
  // its own `confirm()`-then-blank-`window.open()` default.
  it('reaches the same opener when the link was an OSC 8 hyperlink', () => {
    PANE_LINK_HANDLER.activate(new MouseEvent('click'), 'https://example.com/y', {
      start: { x: 1, y: 1 },
      end: { x: 2, y: 1 }
    })

    expect(opened).toEqual(['https://example.com/y'])
  })

  // No scheme check on this side. Whether a URL is something this machine hands
  // to the OS is the main process's one answer, and a second one here would be
  // free to disagree with it.
  it('leaves what may be opened to the process that decides it', () => {
    openPaneLink('file:///etc/hosts')

    expect(opened).toEqual(['file:///etc/hosts'])
  })
})
