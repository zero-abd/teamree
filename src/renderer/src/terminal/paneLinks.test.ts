/** @vitest-environment jsdom */

// Links in a pane: what is printed as one, where a path is read from, and what a click does in a real
// emulator — including one whose program reports the mouse, the case where clicks used to be lost.

import { describe, expect, it, vi } from 'vitest'
import type { ILink, ILinkProvider } from '@xterm/xterm'
import { Terminal as XTerm } from '@xterm/xterm'
import { resolvePlatformModifier } from '../keyboard/platformModifier'
import { linkTips } from './LinkTip'
import {
  absolutePath,
  fileListings,
  firstTips,
  paneLinks,
  printedLinks,
  reportedDirectory,
  worktreeOf,
  type LinkedFile,
  type PaneLinkHost,
  type PaneLinks
} from './paneLinks'

const shown = (text: string): unknown[] =>
  printedLinks(text).map((link) =>
    link.kind === 'url' ? link.uri : [link.path, link.line, link.column].filter((part) => part !== undefined).join(' ')
  )

describe('what is printed as a link', () => {
  it('a URL, without the sentence or bracket around it', () => {
    expect(shown('see https://github.com/zero-abd/teamree/issues/495.')).toEqual([
      'https://github.com/zero-abd/teamree/issues/495'
    ])
    expect(shown('(docs: https://example.com/a_(b)), then')).toEqual(['https://example.com/a_(b)'])
    expect(shown('│ https://docs.example.com/guide │')).toEqual(['https://docs.example.com/guide'])
    expect(shown('open file:///w/src/math.ts')).toEqual(['file:///w/src/math.ts'])
  })

  it('an absolute path, one relative to the pane, and ./ and ../ ones', () => {
    expect(shown('absolute: /w/src/math.ts')).toEqual(['/w/src/math.ts'])
    expect(shown('Edited src/math.ts (+2 -0)')).toEqual(['src/math.ts'])
    expect(shown('see ./docs/NOTES.md.')).toEqual(['./docs/NOTES.md'])
    expect(shown('from ../shared/a.ts')).toEqual(['../shared/a.ts'])
  })

  it('path:line, path:line:col and path(line,col)', () => {
    expect(shown('Added sub to src/math.ts:7, matching add.')).toEqual(['src/math.ts 7'])
    expect(shown('at src/math.ts:7:3')).toEqual(['src/math.ts 7 3'])
    expect(shown('src/math.ts(12,5): error TS2345')).toEqual(['src/math.ts 12 5'])
    expect(shown('README.md(3)')).toEqual(['README.md 3'])
  })

  it('what Claude Code and Codex print around a path', () => {
    expect(shown('⏺ Read(src/math.ts)')).toEqual(['src/math.ts'])
    expect(shown('  ⎿  Updated src/components/Button.tsx with 1 addition')).toEqual(['src/components/Button.tsx'])
    expect(shown('│ ./src/components/Button.tsx:2      │')).toEqual(['./src/components/Button.tsx 2'])
    expect(shown('• Edited src/math.ts (+2 -1)')).toEqual(['src/math.ts'])
  })

  it('a path through dot folders, without the full stop after it', () => {
    expect(shown('failed at .github/workflows/ci.yml:12')).toEqual(['.github/workflows/ci.yml 12'])
    expect(shown('copy ./.env.example first')).toEqual(['./.env.example'])
    expect(shown('in ~/.config/x and src/.eslintrc.json.')).toEqual(['~/.config/x', 'src/.eslintrc.json'])
    expect(shown('see .github/workflows/ci.yml.')).toEqual(['.github/workflows/ci.yml'])
    expect(shown('from ../.github/a.yml')).toEqual(['../.github/a.yml'])
  })

  it('leaves the full stops of a sentence alone', () => {
    expect(shown('That is the end.')).toEqual([])
    expect(shown('...')).toEqual([])
    expect(shown('wait... then .../x and ../')).toEqual([])
    expect(shown('Done. Next up')).toEqual([])
  })

  it('leaves version numbers, bare words and a URL’s own path alone', () => {
    expect(shown('bumped to 1.2.3 and then some')).toEqual([])
    expect(shown('see https://example.com/src/math.ts')).toEqual(['https://example.com/src/math.ts'])
    expect(shown('https://')).toEqual([])
  })
})

describe('where a path is read from', () => {
  it('the directory, made absolute', () => {
    expect(absolutePath('math.ts', '/w/src')).toBe('/w/src/math.ts')
    expect(absolutePath('../docs/a.md', '/w/src')).toBe('/w/docs/a.md')
    expect(absolutePath('/etc/hosts', '/w')).toBe('/etc/hosts')
  })

  it('the innermost worktree that holds it, never one it only looks like', () => {
    const worktrees = [
      { id: 'parent', path: '/w' },
      { id: 'child', path: '/w/kids/a' }
    ]
    expect(worktreeOf('/w/src/a.ts', worktrees)).toEqual({ worktreeId: 'parent', path: 'src/a.ts' })
    expect(worktreeOf('/w/kids/a/b.ts', worktrees)).toEqual({ worktreeId: 'child', path: 'b.ts' })
    expect(worktreeOf('/wx/a.ts', worktrees)).toBeNull()
  })

  it('the directory a shell reports with OSC 7', () => {
    expect(reportedDirectory('file://mac.local/w/my%20dir')).toBe('/w/my dir')
    expect(reportedDirectory('file:///w/src')).toBe('/w/src')
    expect(reportedDirectory('not a url')).toBeNull()
  })
})

describe('the tip', () => {
  it('says the gesture on the first five looks at a link, however often a repaint hovers it again', () => {
    localStorage.clear()
    const said: unknown[] = []
    const tip = linkTips(resolvePlatformModifier('darwin'), (shown) => said.push(shown?.text ?? null))!
    for (let repaint = 0; repaint < 8; repaint += 1) tip({ x: 10, y: 10 })
    for (let x = 20; x <= 70; x += 10) tip({ x, y: 10 })
    expect(said).toEqual([...Array(12).fill('⌘-click to open'), null, null])
    tip({ x: 80, y: 10, uri: 'https://example.com/hidden' })
    expect(said.at(-1)).toBe('https://example.com/hidden')
  })

  it('is offered on the first few hovers there have ever been', () => {
    const kept = new Map<string, string>()
    const storage = {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => void kept.set(key, value)
    }
    const take = firstTips(storage, 2)
    expect([take(), take(), take()]).toEqual([true, true, false])
    expect(firstTips(storage, 2)()).toBe(false)
  })
})

const COLS = 40
const ROWS = 8
const CELL = { width: 10, height: 20 }

type Pane = {
  term: XTerm
  layer: PaneLinks
  urls: string[]
  files: Array<[LinkedFile, number | undefined, number | undefined]>
  /** Whatever reached xterm's own mouse handling. */
  reached: MouseEvent[]
  write: (data: string) => Promise<void>
  links: (row: number) => Promise<ILink[]>
  press: (col: number, row: number, init?: MouseEventInit) => MouseEvent
}

/** A real emulator with the layer on it, laid out on a 10×20 cell grid; `/w` holds src/math.ts and friends. */
function pane(
  listed: Record<string, string[]> = { src: ['math.ts', 'b.ts'], 'src/deep/er': ['handler.ts'] },
  overrides: Partial<PaneLinkHost> = {}
): Pane {
  const host = document.body.appendChild(document.createElement('div'))
  const term = new XTerm({ allowProposedApi: true, cols: COLS, rows: ROWS })
  const providers: ILinkProvider[] = []
  const register = term.registerLinkProvider.bind(term)
  term.registerLinkProvider = (provider) => {
    providers.push(provider)
    return register(provider)
  }
  term.open(host)
  const screen = term.element!.querySelector('.xterm-screen') as HTMLElement
  screen.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: COLS * CELL.width, height: ROWS * CELL.height }) as DOMRect
  const reached: MouseEvent[] = []
  term.element!.addEventListener('mousedown', (event) => reached.push(event))

  const urls: string[] = []
  const files: Pane['files'] = []
  const layer = paneLinks(term, {
    place: () => ({ worktreeId: 'w1', cwd: '/w' }),
    worktrees: () => [{ id: 'w1', path: '/w' }],
    files: fileListings(async (_worktreeId, dir) => new Set(listed[dir] ?? [])),
    openUrl: (uri) => urls.push(uri),
    openFile: (file, line, column) => files.push([file, line, column]),
    holds: (event) => event.metaKey,
    ...overrides
  })
  return {
    term,
    layer,
    urls,
    files,
    reached,
    write: (data) => new Promise<void>((resolve) => term.write(data, () => setTimeout(resolve, 0))),
    links: async (row) =>
      (
        await Promise.all(
          providers.map(
            (provider) => new Promise<ILink[]>((resolve) => provider.provideLinks(row, (links) => resolve(links ?? [])))
          )
        )
      ).flat(),
    press: (col, row, init = {}) => {
      const event = new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: col * CELL.width + CELL.width / 2,
        clientY: row * CELL.height + CELL.height / 2,
        ...init
      })
      screen.dispatchEvent(event)
      return event
    }
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('a pane with links in it', () => {
  it('underlines a URL and a file that exists, and not one that does not', async () => {
    const view = pane()
    await view.write('see https://example.com/x src/math.ts:7\r\nnot src/nope.ts\r\n')
    const links = [...(await view.links(1)), ...(await view.links(2))]
    expect(links.map((link) => link.text)).toEqual(['https://example.com/x', 'src/math.ts:7'])
    expect(links.every((link) => link.decorations?.underline === true && link.decorations.pointerCursor)).toBe(true)
  })

  it('opens a URL on a ⌘-click, and leaves a plain click to the selection', async () => {
    const view = pane()
    await view.write('see https://example.com/x\r\n')
    view.press(6, 0)
    expect(view.urls).toEqual([])
    expect(view.reached).toHaveLength(1)
    const taken = view.press(6, 0, { metaKey: true })
    expect(view.urls).toEqual(['https://example.com/x'])
    expect(taken.defaultPrevented).toBe(true)
    expect(view.reached).toHaveLength(1)
  })

  it('opens a file at its line and column, read from where OSC 7 says the shell went', async () => {
    const view = pane()
    await view.write('\x1b]7;file://mac/w/src\x07at math.ts(12,5) and b.ts:3:4\r\n')
    view.press(4, 0, { metaKey: true })
    view.press(21, 0, { metaKey: true })
    await settle()
    expect(view.files).toEqual([
      [{ worktreeId: 'w1', path: 'src/math.ts', absolute: '/w/src/math.ts' }, 12, 5],
      [{ worktreeId: 'w1', path: 'src/b.ts', absolute: '/w/src/b.ts' }, 3, 4]
    ])
  })

  it('underlines and opens a path through a dot folder', async () => {
    const view = pane({ '.github/workflows': ['ci.yml'] })
    await view.write('at .github/workflows/ci.yml:12.\r\n')
    expect((await view.links(1)).map((link) => link.text)).toEqual(['.github/workflows/ci.yml:12'])
    view.press(5, 0, { metaKey: true })
    await settle()
    expect(view.files).toEqual([
      [{ worktreeId: 'w1', path: '.github/workflows/ci.yml', absolute: '/w/.github/workflows/ci.yml' }, 12, undefined]
    ])
  })

  it('reads a path an agent printed from the worktree’s root when the pane is elsewhere', async () => {
    const view = pane()
    await view.write('\x1b]7;file:///w/docs\x07Edited src/math.ts\r\n')
    view.press(8, 0, { metaKey: true })
    await settle()
    expect(view.files.map(([file]) => file.path)).toEqual(['src/math.ts'])
  })

  it('reads ~/ as the home folder, and links no path in a pane with no place', async () => {
    const home = { home: '/u', worktrees: () => [{ id: 'w1', path: '/u/w' }] }
    const view = pane(undefined, home)
    await view.write('~/w/src/math.ts:7 ~/src/b.ts ~x/src/b.ts\r\n')
    expect((await view.links(1)).map((link) => link.text)).toEqual(['~/w/src/math.ts:7'])
    view.press(2, 0, { metaKey: true })
    await settle()
    expect(view.files).toEqual([
      [{ worktreeId: 'w1', path: 'src/math.ts', absolute: '/u/w/src/math.ts' }, 7, undefined]
    ])

    const watched = pane(undefined, { ...home, place: () => null })
    await watched.write('~/w/src/math.ts\r\n')
    expect(await watched.links(1)).toEqual([])
  })

  it('joins a path wrapped onto the next row', async () => {
    const view = pane()
    const path = 'src/deep/er/handler.ts:12:4'
    await view.write(`${' '.repeat(COLS - 10)}${path}\r\n`)
    view.press(3, 1, { metaKey: true })
    await settle()
    expect(view.files).toEqual([
      [{ worktreeId: 'w1', path: 'src/deep/er/handler.ts', absolute: '/w/src/deep/er/handler.ts' }, 12, 4]
    ])
    expect((await view.links(2)).map((link) => link.text)).toEqual([path])
  })

  it('finds a path in colour and inside a box', async () => {
    const view = pane()
    await view.write('\x1b[36msrc/math.ts:7:3\x1b[0m\r\n│ ./src/b.ts:2 │\r\n')
    view.press(2, 0, { metaKey: true })
    view.press(5, 1, { metaKey: true })
    await settle()
    expect(view.files.map(([file, line, column]) => [file.path, line, column])).toEqual([
      ['src/math.ts', 7, 3],
      ['src/b.ts', 2, undefined]
    ])
  })

  it('skips a file that does not exist and leaves its click alone', async () => {
    const view = pane()
    await view.write('missing: src/nope.ts:3\r\n')
    await view.links(1)
    view.press(12, 0, { metaKey: true })
    await settle()
    expect(view.files).toEqual([])
    expect(view.reached).toHaveLength(1)
  })

  it('takes the ⌘-click from a program reporting the mouse, whose repaint cannot lose it', async () => {
    const view = pane()
    await view.write('\x1b[?1049h\x1b[?1003h\x1b[?1006hsee https://example.com/x\r\n')
    const data = vi.fn()
    view.term.onData(data)
    view.press(6, 0, { metaKey: true })
    // What an agent that owns the mouse does on a press: paint the whole frame again.
    await view.write('\x1b[2J\x1b[Hsee https://example.com/x\r\n')
    view.term.element!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 65, clientY: 10 }))
    expect(view.urls).toEqual(['https://example.com/x'])
    expect(view.reached).toHaveLength(0)
    expect(data).not.toHaveBeenCalled()
  })

  it('follows an OSC 8 link by its address, a file:// one into a file pane', async () => {
    const view = pane()
    await view.write(
      '\x1b]8;;https://example.com/pr\x1b\\the PR\x1b]8;;\x1b\\ \x1b]8;;file:///w/src/math.ts\x1b\\math\x1b]8;;\x1b\\\r\n'
    )
    const handler = view.term.options.linkHandler!
    const move = new MouseEvent('mousemove')
    const label = { start: { x: 1, y: 1 }, end: { x: 6, y: 1 } }
    handler.hover?.(move, 'https://example.com/pr', label)
    view.press(2, 0, { metaKey: true })
    handler.leave?.(move, 'https://example.com/pr', label)
    await view.links(1)
    handler.hover?.(move, 'file:///w/src/math.ts', { start: { x: 8, y: 1 }, end: { x: 11, y: 1 } })
    view.press(9, 0, { metaKey: true })
    await settle()
    expect(view.urls).toEqual(['https://example.com/pr'])
    expect(view.files.map(([file]) => file.absolute)).toEqual(['/w/src/math.ts'])
  })

  it('says what is under the pointer for the right-click menu', async () => {
    const view = pane()
    await view.write('see https://example.com/x src/math.ts:7\r\n')
    await view.links(1)
    const at = (col: number): unknown =>
      view.layer.at(new MouseEvent('contextmenu', { clientX: col * CELL.width + 5, clientY: 10 }))
    expect(at(6)).toEqual({ kind: 'link', uri: 'https://example.com/x' })
    expect(at(28)).toEqual({ kind: 'path', worktreeId: 'w1', path: 'src/math.ts', absolute: '/w/src/math.ts', line: 7 })
    expect(at(1)).toBeNull()
  })
})
