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
import { paneFileLinks, printedPaths, worktreePath } from './paneFileLinks'

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

// A path an agent printed: `Edited src/math.ts (+2 -0)`, `Read(src/math.ts)`, `src/math.ts:7`.
describe('a path printed in a pane', () => {
  it('finds each path, with the line and column after it', () => {
    const found = (row: string): unknown =>
      printedPaths(row).map(({ path, line, column }) => [path, line, column].filter((part) => part !== undefined))
    expect(found('Added sub to src/math.ts:7, matching add.')).toEqual([['src/math.ts', 7]])
    expect(found('at src/math.ts:7:3')).toEqual([['src/math.ts', 7, 3]])
    expect(found('see ./docs/NOTES.md.')).toEqual([['./docs/NOTES.md']])
    expect(found('⏺ Read(src/math.ts)')).toEqual([['src/math.ts']])
    expect(found('Edited src/math.ts (+2 -0)')).toEqual([['src/math.ts']])
  })

  it('leaves version numbers and URLs alone', () => {
    expect(printedPaths('bumped to 1.2.3')).toEqual([])
    expect(printedPaths('see https://example.com/src/math.ts')).toEqual([])
  })

  it('reads a path from the pane’s directory, never outside the worktree', () => {
    expect(worktreePath('math.ts', '/w/src', '/w')).toBe('src/math.ts')
    expect(worktreePath('./docs/NOTES.md', '/w', '/w')).toBe('docs/NOTES.md')
    expect(worktreePath('/w/src/math.ts', '/w', '/w')).toBe('src/math.ts')
    expect(worktreePath('../../etc/hosts', '/w/src', '/w')).toBeNull()
    expect(worktreePath('/etc/hosts', '/w', '/w')).toBeNull()
  })

  function filePane(): {
    write: (data: string) => Promise<void>
    links: (row: number) => Promise<ILink[]>
    opened: unknown[]
  } {
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
    const opened: unknown[] = []
    paneFileLinks(term, {
      place: () => ({ worktreeId: 'w1', root: '/w', cwd: '/w' }),
      exists: async (_worktreeId, path) => ['src/math.ts', 'docs/NOTES.md'].includes(path),
      open: (...args) => opened.push(args),
      holds: (event) => event.metaKey
    })
    return {
      opened,
      write: (data) => new Promise<void>((resolve) => term.write(data, () => setTimeout(resolve, 0))),
      links: async (row) =>
        (
          await Promise.all(
            providers.map(
              (provider) =>
                new Promise<ILink[]>((resolve) => provider.provideLinks(row, (links) => resolve(links ?? [])))
            )
          )
        ).flat()
    }
  }

  // xterm shows a row's links once every provider has answered; a URL must not wait on a lookup that has nothing to find.
  it('answers at once for a row with no path in it', () => {
    const term = new XTerm({ allowProposedApi: true, cols: 80, rows: 24 })
    let provider: ILinkProvider | undefined
    term.registerLinkProvider = (registered) => {
      provider = registered
      return { dispose: () => {} }
    }
    paneFileLinks(term, {
      place: () => ({ worktreeId: 'w1', root: '/w', cwd: '/w' }),
      exists: async () => true,
      open: () => {},
      holds: () => false
    })
    let answered = false
    provider?.provideLinks(1, () => {
      answered = true
    })
    expect(answered).toBe(true)
  })

  it('links a path that is in the worktree, and opens it at its line on a ⌘-click only', async () => {
    const view = filePane()
    await view.write('Added sub to src/math.ts:7 and a/b, see https://example.com/x\r\n')

    const links = await view.links(1)
    expect(links.map((link) => link.text)).toEqual(['https://example.com/x', 'src/math.ts:7'])

    const path = links[1]
    path?.activate(new MouseEvent('click'), path.text)
    expect(view.opened).toEqual([])
    path?.activate(new MouseEvent('click', { metaKey: true }), path.text)
    expect(view.opened).toEqual([['w1', 'src/math.ts', 7, undefined]])
  })
})
