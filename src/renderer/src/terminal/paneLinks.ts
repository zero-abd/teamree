// Every link a pane shows — URLs, OSC 8 hyperlinks, file paths with a line and column — underlined on
// hover and followed on a ⌘-click that is taken before xterm, so a program reporting the mouse never
// sees it and a repaint between press and release cannot lose it. A plain click still selects.

import type { IBuffer, IBufferRange, IDisposable, ILink, Terminal as XTerm } from '@xterm/xterm'
import type { Pointed } from './terminalMenu'

/** A link as printed on one logical line: offsets into its text, end exclusive. */
export type PrintedLink =
  | { kind: 'url'; uri: string; start: number; end: number }
  | { kind: 'path'; path: string; line?: number; column?: number; start: number; end: number }

type PrintedPath = Extract<PrintedLink, { kind: 'path' }>

const URL_SPAN = /\b(?:https?|file):\/\/[^\s<>"'`│┃║]+/giu
// A segment may start with one dot (`.github`) but not two, so an ellipsis is never a name.
const PATH_SPAN =
  /(?<![\w/.:@~$%+-])((?:~\/|\.{1,2}\/|\/)?(?:\.?[\w@+-][\w.@+-]*\/)*\.?[\w@+-][\w.@+-]*)(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s?(\d+))?\))?/gu
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{', '>': '<' }

/** The URLs and file-like paths in `text`: a path needs a slash or a lettered extension and is never inside a URL. */
export function printedLinks(text: string): PrintedLink[] {
  const found: PrintedLink[] = []
  for (const match of text.matchAll(URL_SPAN)) {
    const uri = trimUrl(match[0])
    if (!/:\/\/./u.test(uri)) continue
    found.push({ kind: 'url', uri, start: match.index, end: match.index + uri.length })
  }
  const urls = [...found]
  for (const match of text.matchAll(PATH_SPAN)) {
    const start = match.index
    if (urls.some((url) => start >= url.start && start < url.end)) continue
    const raw = match[1] ?? ''
    // A sentence's full stop is not part of the name.
    const path = raw.replace(/\.+$/u, '')
    const name = path.slice(path.lastIndexOf('/') + 1)
    if (name === '' || name === '.' || name === '..') continue
    if (!path.includes('/') && !/\.[A-Za-z]\w*$/u.test(name)) continue
    const whole = path === raw
    const line = whole ? number(match[2] ?? match[4]) : undefined
    const column = line === undefined ? undefined : number(match[3] ?? match[5])
    found.push({
      kind: 'path',
      path,
      start,
      end: whole ? start + match[0].length : start + path.length,
      ...(line === undefined ? {} : { line }),
      ...(column === undefined ? {} : { column })
    })
  }
  return found.sort((a, b) => a.start - b.start)
}

function number(digits: string | undefined): number | undefined {
  return digits === undefined ? undefined : Number(digits)
}

/** Trailing punctuation belongs to the sentence, and a closing bracket only when the URL opened one. */
function trimUrl(raw: string): string {
  let url = raw
  for (;;) {
    const last = url.at(-1) ?? ''
    const opener = CLOSERS[last]
    if (/[.,;:!?'"*]/u.test(last)) url = url.slice(0, -1)
    else if (opener !== undefined && url.split(opener).length < url.split(last).length) url = url.slice(0, -1)
    else return url
  }
}

/** One character's cell: 0-based column and buffer row, and how many columns it covers. */
type Cell = { x: number; y: number; width: number }

/** The logical line through buffer row `y` (0-based), wrapped rows joined, with each UTF-16 unit's cell. */
export function lineAt(buffer: IBuffer, y: number, cols: number): { text: string; cells: Cell[] } | null {
  if (buffer.getLine(y) === undefined) return null
  let first = y
  while (first > 0 && y - first < 50 && buffer.getLine(first)?.isWrapped) first -= 1
  let last = y
  while (last - y < 50 && buffer.getLine(last + 1)?.isWrapped) last += 1
  let text = ''
  const cells: Cell[] = []
  const reuse = buffer.getNullCell()
  for (let row = first; row <= last; row += 1) {
    const line = buffer.getLine(row)
    if (line === undefined) break
    for (let x = 0; x < cols; x += 1) {
      const cell = line.getCell(x, reuse)
      const width = cell?.getWidth() ?? 1
      // The right half of a wide character.
      if (width === 0) continue
      const chars = cell?.getChars() || ' '
      text += chars
      for (let unit = 0; unit < chars.length; unit += 1) cells.push({ x, y: row, width })
    }
  }
  const kept = text.trimEnd().length
  return { text: text.slice(0, kept), cells: cells.slice(0, kept) }
}

/** xterm's 1-based, end-inclusive range for text offsets `start`..`end`. */
function rangeOf(cells: Cell[], start: number, end: number): IBufferRange {
  const first = cells[start]!
  const last = cells[end - 1]!
  return { start: { x: first.x + 1, y: first.y + 1 }, end: { x: last.x + last.width, y: last.y + 1 } }
}

/** The directory an OSC 7 report names, or null for one that names none. */
export function reportedDirectory(data: string): string | null {
  const match = /^file:\/\/[^/]*(\/.*)$/u.exec(data)
  if (match === null) return null
  try {
    return decodeURIComponent(match[1]!)
  } catch {
    return match[1]!
  }
}

/** `path` made absolute and normalised against `from`; `..` past the root stays at the root. */
export function absolutePath(path: string, from: string): string {
  const parts: string[] = []
  for (const part of (path.startsWith('/') ? path : `${from}/${path}`).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

export type LinkWorktree = { id: string; path: string }

/** The worktree that holds `absolute` (the innermost, when they nest) and the path inside it. */
export function worktreeOf(
  absolute: string,
  worktrees: readonly LinkWorktree[]
): { worktreeId: string; path: string } | null {
  let best: LinkWorktree | null = null
  for (const worktree of worktrees) {
    const inside = absolute.startsWith(`${worktree.path}/`)
    if (inside && (best === null || worktree.path.length > best.path.length)) best = worktree
  }
  return best === null ? null : { worktreeId: best.id, path: absolute.slice(best.path.length + 1) }
}

/** A file a printed path names: its worktree, its path there, and where it is on disk. */
export type LinkedFile = { worktreeId: string; path: string; absolute: string }

/** Names of the files in one directory of a worktree, remembered briefly; `peek` answers only from memory. */
export type FileListings = {
  get: (worktreeId: string, dir: string) => Promise<ReadonlySet<string> | null>
  peek: (worktreeId: string, dir: string) => ReadonlySet<string> | null | undefined
}

/** How long one listing stands: a hover asks for every row the pointer crosses. */
const LISTED_FOR_MS = 5_000

export function fileListings(
  list: (worktreeId: string, dir: string) => Promise<ReadonlySet<string> | null>,
  now: () => number = Date.now
): FileListings {
  type Listing = { at: number; answer: Promise<ReadonlySet<string> | null>; value?: ReadonlySet<string> | null }
  const known = new Map<string, Listing>()
  const fresh = (key: string): Listing | undefined => {
    const hit = known.get(key)
    return hit !== undefined && now() - hit.at < LISTED_FOR_MS ? hit : undefined
  }
  return {
    get: (worktreeId, dir) => {
      const key = `${worktreeId}\u0000${dir}`
      const hit = fresh(key)
      if (hit !== undefined) return hit.answer
      if (known.size > 500) known.clear()
      const entry: Listing = { at: now(), answer: Promise.resolve(null) }
      entry.answer = list(worktreeId, dir)
        .catch(() => null)
        .then((value) => (entry.value = value))
      known.set(key, entry)
      return entry.answer
    },
    peek: (worktreeId, dir) => fresh(`${worktreeId}\u0000${dir}`)?.value
  }
}

/** Where a pane reads its paths from, what it may open, and how it says so. */
export type PaneLinkHost = {
  /** The pane's worktree and starting directory; null where paths are never links (a teammate's pane). */
  place: () => { worktreeId: string; cwd: string } | null
  worktrees: () => readonly LinkWorktree[]
  /** What `~/` stands for; without it such paths are never links. */
  home?: string
  files: FileListings
  openUrl: (uri: string) => void
  openFile: (file: LinkedFile, line?: number, column?: number) => void
  /** Whether this event holds the modifier that follows a link, ⌘ on a Mac. */
  holds: (event: MouseEvent) => boolean
  /** Shows a tip at the pointer for a hovered link, or hides it; `uri` is an OSC 8 link's hidden address. */
  tip?: (at: { x: number; y: number; uri?: string } | null) => void
}

export type PaneLinks = IDisposable & {
  /** The link under the pointer, at once; a path counts only while its folder's listing is remembered. */
  at: (event: MouseEvent) => Pointed | null
  /** The link under the pointer for the right-click menu, reading the folder a path names when it must. */
  resolveAt: (event: MouseEvent) => Promise<Pointed | null>
}

type Found = { kind: 'url'; uri: string } | { kind: 'path'; printed: PrintedPath }

/** Puts the link layer on `term`, which must already be open. */
export function paneLinks(term: XTerm, host: PaneLinkHost): PaneLinks {
  // Where `cd` took the shell, once it says (OSC 7); until then the pane's starting directory.
  let reported: string | null = null
  let osc: { uri: string; range: IBufferRange } | null = null

  const resolveNow = (printed: PrintedPath): LinkedFile | null | undefined => {
    for (const file of candidates(printed.path)) {
      const listing = host.files.peek(file.worktreeId, dirOf(file.path))
      if (listing === undefined) return undefined
      if (listing?.has(nameOf(file.path))) return file
    }
    return null
  }
  const resolve = async (printed: PrintedPath): Promise<LinkedFile | null> => {
    for (const file of candidates(printed.path)) {
      const listing = await host.files.get(file.worktreeId, dirOf(file.path))
      if (listing?.has(nameOf(file.path))) return file
    }
    return null
  }
  // The pane's directory first, then its worktree's root, which is where agents print paths from.
  const candidates = (printed: string): LinkedFile[] => {
    const place = host.place()
    const path = place === null ? null : expandHome(printed, host.home)
    if (place === null || path === null) return []
    const worktrees = host.worktrees()
    const root = worktrees.find((worktree) => worktree.id === place.worktreeId)?.path
    const files: LinkedFile[] = []
    for (const base of [reported ?? place.cwd, ...(root === undefined ? [] : [root])]) {
      const absolute = absolutePath(path, base)
      const inside = worktreeOf(absolute, worktrees)
      if (inside !== null && !files.some((file) => file.absolute === absolute)) files.push({ ...inside, absolute })
    }
    return files
  }

  const pointedFor = (found: Found): Pointed | null | undefined => {
    if (found.kind === 'url') return { kind: 'link', uri: found.uri }
    const file = resolveNow(found.printed)
    if (file === null || file === undefined) return file
    return { kind: 'path', ...file, ...position(found.printed) }
  }

  const follow = (found: Found): void => {
    if (found.kind === 'url') return host.openUrl(found.uri)
    const printed = found.printed
    void resolve(printed).then((file) => {
      if (file !== null) host.openFile(file, printed.line, printed.column)
    })
  }

  /** What is printed under the pointer: the OSC 8 link it is on, else a URL or path in the text. */
  const foundAt = (event: MouseEvent): Found | null => {
    const cell = cellAt(term, event)
    if (cell === null) return null
    if (osc !== null && within(osc.range, cell)) return linkTo(osc.uri)
    const line = lineAt(term.buffer.active, cell.y, term.cols)
    if (line === null) return null
    for (const printed of printedLinks(line.text)) {
      const hit = line.cells
        .slice(printed.start, printed.end)
        .some((at) => at.y === cell.y && cell.x >= at.x && cell.x < at.x + at.width)
      if (hit) return printed.kind === 'url' ? linkTo(printed.uri) : { kind: 'path', printed }
    }
    return null
  }

  const press = (event: MouseEvent): void => {
    if (event.button !== 0 || !host.holds(event)) return
    const found = foundAt(event)
    // A path known not to exist is text, and the click is the program's or the selection's.
    if (found === null || pointedFor(found) === null) return
    event.preventDefault()
    event.stopImmediatePropagation()
    host.tip?.(null)
    follow(found)
  }

  const link = (range: IBufferRange, text: string): ILink => ({
    range,
    text,
    decorations: { underline: true, pointerCursor: true },
    // Followed in `press`, before xterm and the program see the click.
    activate: () => {},
    hover: (event) => host.tip?.({ x: event.clientX, y: event.clientY }),
    leave: () => host.tip?.(null)
  })

  const provider = term.registerLinkProvider({
    provideLinks(y, callback) {
      const line = lineAt(term.buffer.active, y - 1, term.cols)
      const onRow = (line === null ? [] : printedLinks(line.text)).filter((printed) =>
        line!.cells.slice(printed.start, printed.end).some((cell) => cell.y === y - 1)
      )
      const urls = onRow.flatMap((printed) =>
        printed.kind === 'url' ? [link(rangeOf(line!.cells, printed.start, printed.end), printed.uri)] : []
      )
      const paths = onRow.filter((printed): printed is PrintedPath => printed.kind === 'path')
      // Answered at once when there is nothing to look up: xterm waits for every provider before it shows any link.
      if (paths.length === 0 || host.place() === null) return callback(urls.length === 0 ? undefined : urls)
      void Promise.all(paths.map(resolve)).then((files) => {
        const linked = paths.flatMap((printed, index) =>
          files[index] === null
            ? []
            : [link(rangeOf(line!.cells, printed.start, printed.end), line!.text.slice(printed.start, printed.end))]
        )
        const all = [...urls, ...linked]
        callback(all.length === 0 ? undefined : all)
      })
    }
  })

  // OSC 8: file:// ones included, which open in a file pane rather than the browser.
  term.options.linkHandler = {
    allowNonHttpProtocols: true,
    activate: () => {},
    hover: (event, uri, range) => {
      osc = { uri, range }
      const shown = labelOf(term, range)
      host.tip?.({ x: event.clientX, y: event.clientY, ...(shown === uri ? {} : { uri }) })
    },
    leave: () => {
      osc = null
      host.tip?.(null)
    }
  }

  const directory = term.parser.registerOscHandler(7, (data) => {
    reported = reportedDirectory(data) ?? reported
    return true
  })

  // Capture on the terminal's element runs before xterm's own listeners inside it.
  const element = term.element
  element?.addEventListener('mousedown', press, true)

  return {
    at: (event) => {
      const found = foundAt(event)
      return found === null ? null : (pointedFor(found) ?? null)
    },
    resolveAt: async (event) => {
      const found = foundAt(event)
      if (found?.kind !== 'path') return found === null ? null : { kind: 'link', uri: found.uri }
      const file = await resolve(found.printed)
      return file === null ? null : { kind: 'path', ...file, ...position(found.printed) }
    },
    dispose: () => {
      element?.removeEventListener('mousedown', press, true)
      provider.dispose()
      directory.dispose()
      term.options.linkHandler = null
    }
  }
}

/** `~/…` under `home`; null for a `~` path it cannot expand, such as `~user/…`. */
function expandHome(path: string, home: string | undefined): string | null {
  if (!path.startsWith('~')) return path
  return path.startsWith('~/') && home ? `${home}${path.slice(1)}` : null
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function position(printed: PrintedPath): { line?: number; column?: number } {
  return {
    ...(printed.line === undefined ? {} : { line: printed.line }),
    ...(printed.column === undefined ? {} : { column: printed.column })
  }
}

/** A URL, or the path a `file://` one names. */
function linkTo(uri: string): Found {
  const path = /^file:\/\//iu.test(uri) ? reportedDirectory(uri) : null
  return path === null ? { kind: 'url', uri } : { kind: 'path', printed: { kind: 'path', path, start: 0, end: 0 } }
}

/** The cell under the pointer, in buffer rows; measured off the screen so a scaled (watched) pane agrees. */
function cellAt(term: XTerm, event: MouseEvent): { x: number; y: number } | null {
  const screen = term.element?.querySelector('.xterm-screen')
  if (!screen) return null
  const box = screen.getBoundingClientRect()
  if (box.width === 0 || box.height === 0) return null
  const x = Math.floor(((event.clientX - box.left) / box.width) * term.cols)
  const row = Math.floor(((event.clientY - box.top) / box.height) * term.rows)
  if (x < 0 || x >= term.cols || row < 0 || row >= term.rows) return null
  return { x, y: row + term.buffer.active.viewportY }
}

function within(range: IBufferRange, cell: { x: number; y: number }): boolean {
  const at = (cell.y + 1) * 1e5 + cell.x + 1
  return at >= range.start.y * 1e5 + range.start.x && at <= range.end.y * 1e5 + range.end.x
}

/** What an OSC 8 link shows on screen, to tell a label from its own address. */
function labelOf(term: XTerm, range: IBufferRange): string {
  let text = ''
  for (let y = range.start.y; y <= range.end.y; y += 1) {
    const from = y === range.start.y ? range.start.x - 1 : 0
    const to = y === range.end.y ? range.end.x : term.cols
    text += term.buffer.active.getLine(y - 1)?.translateToString(true, from, to) ?? ''
  }
  return text.trim()
}

/** "⌘-click to open", on the first few link hovers there have ever been. */
export function firstTips(storage: Pick<Storage, 'getItem' | 'setItem'> | undefined, limit = 5): () => boolean {
  const KEY = 'teamree.linkTips'
  return () => {
    try {
      const shown = Number(storage?.getItem(KEY) ?? 0)
      if (!(shown < limit)) return false
      storage?.setItem(KEY, String(shown + 1))
      return true
    } catch {
      return false
    }
  }
}
