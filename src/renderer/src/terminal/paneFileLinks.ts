// `src/math.ts:7` in a pane's output, as a link to the file: matched here, checked against the
// worktree's own file list, and opened on a ⌘-click, so a plain click still selects text.

import type { IBufferLine, IDisposable, ILink, ILinkProvider, Terminal as XTerm } from '@xterm/xterm'

/** A path as printed: where it sits on the row (0-based, end exclusive) and the line and column after it. */
export type PrintedPath = { path: string; start: number; end: number; line?: number; column?: number }

const PATH = /(?<![\w/.:@~-])((?:\.{1,2}\/)?(?:[\w@+-][\w.@+-]*\/)*[\w@+-][\w.@+-]*)(?::(\d+))?(?::(\d+))?/gu
const URL_SPAN = /\b[a-z][\w+.-]*:\/\/\S+/giu

/** Every token on a row that could be a file path: one with a slash or a lettered extension, never inside a URL. */
export function printedPaths(row: string): PrintedPath[] {
  const urls = [...row.matchAll(URL_SPAN)].map((match) => [match.index, match.index + match[0].length] as const)
  const found: PrintedPath[] = []
  for (const match of row.matchAll(PATH)) {
    const raw = match[1] ?? ''
    // A sentence's full stop is not part of the name.
    const path = raw.replace(/\.+$/u, '')
    const start = match.index
    const name = path.split('/').pop() ?? ''
    if (urls.some(([from, to]) => start >= from && start < to)) continue
    if (!path.includes('/') && !/\.[A-Za-z]\w*$/u.test(name)) continue
    if (name === '' || /^\.{1,2}$/u.test(name)) continue
    const line = path === raw && match[2] !== undefined ? Number(match[2]) : undefined
    const column = line !== undefined && match[3] !== undefined ? Number(match[3]) : undefined
    const suffix = line === undefined ? '' : `:${line}${column === undefined ? '' : `:${column}`}`
    found.push({
      path,
      start,
      end: start + path.length + suffix.length,
      ...(line === undefined ? {} : { line }),
      ...(column === undefined ? {} : { column })
    })
  }
  return found
}

/** `path` as the worktree names it, read from `cwd`; null when it leads outside the worktree. */
export function worktreePath(path: string, cwd: string, root: string): string | null {
  const base = cwd === root || cwd.startsWith(`${root}/`) ? cwd.slice(root.length + 1) : ''
  const joined = path.startsWith('/')
    ? path.startsWith(`${root}/`)
      ? path.slice(root.length + 1)
      : null
    : `${base}/${path}`
  if (joined === null) return null
  const parts: string[] = []
  for (const part of joined.split('/')) {
    if (part === '' || part === '.') continue
    if (part !== '..') parts.push(part)
    else if (parts.pop() === undefined) return null
  }
  return parts.length === 0 ? null : parts.join('/')
}

/** Where a pane's paths are read from, and what a ⌘-click does with one that exists. */
export type FileLinkHost = {
  /** The pane's worktree and working directory, or null for a pane with neither. */
  place: () => { worktreeId: string; root: string; cwd: string } | null
  exists: (worktreeId: string, path: string) => Promise<boolean>
  open: (worktreeId: string, path: string, line?: number, column?: number) => void
  /** Whether this event holds the modifier that follows a link, ⌘ on a Mac. */
  holds: (event: MouseEvent | KeyboardEvent) => boolean
}

/** Registers the provider on `term`; its links are underlined only while the modifier is held. */
export function paneFileLinks(term: Pick<XTerm, 'registerLinkProvider' | 'buffer'>, host: FileLinkHost): IDisposable {
  let held = false
  let shown: ILink[] = []
  const track = (event: KeyboardEvent | MouseEvent): void => {
    if (host.holds(event) === held) return
    held = host.holds(event)
    for (const link of shown) {
      if (link.decorations) Object.assign(link.decorations, { underline: held, pointerCursor: held })
    }
  }
  const provider: ILinkProvider = {
    provideLinks(y, callback) {
      const place = host.place()
      const row = rowText(term.buffer.active.getLine(y - 1))
      if (place === null || row === null) return callback(undefined)
      const candidates = printedPaths(row).flatMap((printed) => {
        const path = worktreePath(printed.path, place.cwd, place.root)
        return path === null ? [] : [{ printed, path }]
      })
      // Answered at once when there is nothing to look up: xterm waits for every provider before it shows any link.
      if (candidates.length === 0) return callback(undefined)
      void Promise.all(candidates.map(({ path }) => host.exists(place.worktreeId, path).catch(() => false))).then(
        (exists) => {
          shown = candidates
            .filter((_candidate, index) => exists[index])
            .map(({ printed, path }) => ({
              range: { start: { x: printed.start + 1, y }, end: { x: printed.end, y } },
              text: row.slice(printed.start, printed.end),
              decorations: { underline: held, pointerCursor: held },
              activate: (event) => {
                if (host.holds(event)) host.open(place.worktreeId, path, printed.line, printed.column)
              }
            }))
          callback(shown.length === 0 ? undefined : shown)
        }
      )
    }
  }
  const registered = term.registerLinkProvider(provider)
  window.addEventListener('keydown', track, true)
  window.addEventListener('keyup', track, true)
  window.addEventListener('mousemove', track, true)
  return {
    dispose: () => {
      registered.dispose()
      window.removeEventListener('keydown', track, true)
      window.removeEventListener('keyup', track, true)
      window.removeEventListener('mousemove', track, true)
    }
  }
}

function rowText(line: IBufferLine | undefined): string | null {
  return line === undefined ? null : line.translateToString(true)
}
