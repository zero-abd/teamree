// The preferences that belong to a person at a machine rather than to the work.
//
// Two of them live here: how big the text in a pane is, and which ref a new
// task in a given project starts from by default. Both are stored the way the
// sidebar's width already is — in this window's `localStorage`, behind a
// clamp, with every read and write wrapped so that storage being unavailable
// costs a default rather than a render.
//
// They are not in the workspace file, and that is a decision rather than an
// oversight. The workspace file is the runtime's, reachable only through the
// method contract in `src/shared/methods.ts`, and everything in it is a fact
// about the work that a second window, a teammate's pull or the CLI has to be
// able to read: a project, a worktree, a layout, a mute. Neither of these is
// that. A font size is about the eyes in front of this screen, and a preferred
// start point is a habit — "I always branch from develop" — that belongs to the
// person holding the habit and not to the repository they hold it about. The
// repository's own answer to "where do branches start" is its base ref, and
// that stays exactly where it is; this only decides which ref the composer
// offers first, and anything typed over it still wins.
//
// The consequence worth knowing is that neither preference follows you to
// another machine, which is the same bargain the sidebar width already makes.

/** Below this the emulator's own glyphs stop being glyphs; above it a pane holds nothing. */
export const TERMINAL_FONT_MIN_PX = 9
export const TERMINAL_FONT_MAX_PX = 24
/** What xterm was hard-coded to before any of this was settable. */
export const TERMINAL_FONT_DEFAULT_PX = 12

const FONT_SIZE_KEY = 'teamree.terminal.fontSize'
const START_POINTS_KEY = 'teamree.worktree.startPoints'

export function clampTerminalFontSize(size: number): number {
  if (!Number.isFinite(size)) return TERMINAL_FONT_DEFAULT_PX
  return Math.min(Math.max(Math.round(size), TERMINAL_FONT_MIN_PX), TERMINAL_FONT_MAX_PX)
}

export function readStoredTerminalFontSize(storage: Pick<Storage, 'getItem'> | undefined): number {
  try {
    const raw = storage?.getItem(FONT_SIZE_KEY)
    return raw === null || raw === undefined
      ? TERMINAL_FONT_DEFAULT_PX
      : clampTerminalFontSize(Number.parseInt(raw, 10))
  } catch {
    return TERMINAL_FONT_DEFAULT_PX
  }
}

export function writeStoredTerminalFontSize(storage: Pick<Storage, 'setItem'> | undefined, size: number): void {
  try {
    storage?.setItem(FONT_SIZE_KEY, String(clampTerminalFontSize(size)))
  } catch {
    // A blocked storage quota is not worth failing a preference over; the size
    // still applies to this window, it simply does not survive the next launch.
  }
}

/**
 * Each project's preferred start point, by project id.
 *
 * Read defensively rather than trusted, because the only thing standing between
 * this and the composer's start-point box is a string somebody's browser kept:
 * anything that is not an object of non-empty strings is dropped entirely
 * rather than partly, so a corrupted entry cannot put a `[object Object]` into
 * the field that names a git ref.
 */
export function readStoredStartPoints(storage: Pick<Storage, 'getItem'> | undefined): Record<string, string> {
  try {
    const raw = storage?.getItem(START_POINTS_KEY)
    if (raw === null || raw === undefined) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const refs: Record<string, string> = {}
    for (const [projectId, ref] of Object.entries(parsed)) {
      if (typeof ref === 'string' && ref.trim().length > 0) refs[projectId] = ref.trim()
    }
    return refs
  } catch {
    return {}
  }
}

export function writeStoredStartPoints(
  storage: Pick<Storage, 'setItem'> | undefined,
  refs: Record<string, string>
): void {
  try {
    storage?.setItem(START_POINTS_KEY, JSON.stringify(refs))
  } catch {
    // As above: the choice holds for this window and is forgotten on the next.
  }
}

/**
 * The map with one project's preference set, or removed when the ref is blank.
 *
 * Clearing writes no empty string, because an empty string and an absent entry
 * would be two spellings of "use the base ref" and only one of them is checked
 * for anywhere else.
 */
export function withStartPoint(
  refs: Record<string, string>,
  projectId: string,
  ref: string | null
): Record<string, string> {
  const trimmed = ref?.trim() ?? ''
  if (trimmed.length === 0) {
    const { [projectId]: _removed, ...rest } = refs
    return rest
  }
  return { ...refs, [projectId]: trimmed }
}
