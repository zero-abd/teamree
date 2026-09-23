// The preferences that belong to a person at a machine rather than to the work.
//
// Three of them live here: how big the text in a pane is, which ref a new task
// in a given project starts from by default, whether an agent that stops
// while you are elsewhere is allowed to say so, and which editor that
// project's checkouts open in. All are stored the way the
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
// offers first, and anything typed over it still wins. An editor is the same
// kind of fact as the font size: which program is installed on this machine and
// which one this person likes opening a checkout in. A teammate pulling the
// repository has their own answer and it is not this one.
//
// Notifications are the clearest case of the three. Whether a machine is
// allowed to interrupt you is a fact about the machine you are sitting at and
// the room you are sitting in, not about the task; a laptop in a meeting and a
// desktop at home should not have to agree about it, and a teammate pulling
// your workspace must not inherit your sound.
//
// The consequence worth knowing is that no preference here follows you to
// another machine, which is the same bargain the sidebar width already makes.

/** Below this the emulator's own glyphs stop being glyphs; above it a pane holds nothing. */
export const TERMINAL_FONT_MIN_PX = 9
export const TERMINAL_FONT_MAX_PX = 24
/** What xterm was hard-coded to before any of this was settable. */
export const TERMINAL_FONT_DEFAULT_PX = 12

const FONT_SIZE_KEY = 'teamree.terminal.fontSize'
const START_POINTS_KEY = 'teamree.worktree.startPoints'
const AGENT_NOTICES_KEY = 'teamree.agent.notices'

/**
 * What an agent pane going quiet is allowed to do: nothing, raise a
 * notification, or raise one with the OS's sound.
 *
 * Three values rather than two booleans, because a sound with no notification
 * is not a state anybody wants and offering it would be a setting that can be
 * put somewhere meaningless.
 */
export type AgentNoticePreference = 'off' | 'notify' | 'sound'

export const AGENT_NOTICE_PREFERENCES: readonly AgentNoticePreference[] = ['off', 'notify', 'sound']

/**
 * On, silently. The app's whole premise is that you start three agents and go
 * and do something else, and a default of `off` would be shipping that premise
 * turned off — while a default that makes noise is a decision about the room
 * somebody is in that this app is in no position to make.
 */
export const AGENT_NOTICE_DEFAULT: AgentNoticePreference = 'notify'

export function readStoredAgentNotices(storage: Pick<Storage, 'getItem'> | undefined): AgentNoticePreference {
  try {
    const raw = storage?.getItem(AGENT_NOTICES_KEY)
    return AGENT_NOTICE_PREFERENCES.find((value) => value === raw) ?? AGENT_NOTICE_DEFAULT
  } catch {
    return AGENT_NOTICE_DEFAULT
  }
}

export function writeStoredAgentNotices(
  storage: Pick<Storage, 'setItem'> | undefined,
  preference: AgentNoticePreference
): void {
  try {
    storage?.setItem(AGENT_NOTICES_KEY, preference)
  } catch {
    // As with the size above: the choice holds for this window and is forgotten
    // on the next.
  }
}

const EDITOR_COMMANDS_KEY = 'teamree.editor.commands'

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

/**
 * Each project's editor command, by project id.
 *
 * Read exactly as defensively as the start points above, and for a sharper
 * reason: this string names a program the main process will look for on PATH.
 * It is never a command line — the main process resolves it as one program name
 * and spawns it with the checkout as an argument — but a stored value that is
 * not a string has no business getting as far as that decision.
 */
export function readStoredEditorCommands(storage: Pick<Storage, 'getItem'> | undefined): Record<string, string> {
  try {
    const raw = storage?.getItem(EDITOR_COMMANDS_KEY)
    if (raw === null || raw === undefined) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const commands: Record<string, string> = {}
    for (const [projectId, command] of Object.entries(parsed)) {
      if (typeof command === 'string' && command.trim().length > 0) commands[projectId] = command.trim()
    }
    return commands
  } catch {
    return {}
  }
}

export function writeStoredEditorCommands(
  storage: Pick<Storage, 'setItem'> | undefined,
  commands: Record<string, string>
): void {
  try {
    storage?.setItem(EDITOR_COMMANDS_KEY, JSON.stringify(commands))
  } catch {
    // As above: the choice holds for this window and is forgotten on the next.
  }
}

/**
 * The map with one project's editor set, or removed when the command is blank.
 *
 * Clearing removes the entry rather than storing an empty string, because an
 * absent entry is the only spelling of "use whatever is on PATH" that the main
 * process checks for.
 */
export function withEditorCommand(
  commands: Record<string, string>,
  projectId: string,
  command: string | null
): Record<string, string> {
  const trimmed = command?.trim() ?? ''
  if (trimmed.length === 0) {
    const { [projectId]: _removed, ...rest } = commands
    return rest
  }
  return { ...commands, [projectId]: trimmed }
}
