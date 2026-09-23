// Per-machine preferences: what one person at one screen has chosen.
//
// Several of them live here: how big the text in a pane is, which ref a new
// task in a given project starts from by default, whether an agent that stops
// while you are elsewhere is allowed to say so, which editor that project's
// checkouts open in, whether a patch is read down one column or across two,
// which agent the composer offers first, and what each agent is always
// launched with. All are stored the way the sidebar's width already is — in
// this window's `localStorage`, behind a clamp, with every read and write
// wrapped so that storage being unavailable costs a default rather than a
// render.

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
const DEFAULT_AGENT_KEY = 'teamree.agent.default'
const AGENT_ARGS_KEY = 'teamree.agent.args'

/** The default-agent preference when none has been set: no agent is preferred. */
export const NO_DEFAULT_AGENT = ''
const DIFF_LAYOUT_KEY = 'teamree.diff.layout'

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

/**
 * How a patch is laid out: one column with the removals above the additions,
 * or two columns with the old file beside the new one.
 *
 * Inline is the default because this panel is a side panel — it is beside the
 * terminals, not instead of them — and two columns in three hundred pixels is
 * two columns of nothing. Side by side is what somebody widens the panel for.
 */
export type DiffLayout = 'inline' | 'split'

export const DIFF_LAYOUT_DEFAULT: DiffLayout = 'inline'

export function readStoredDiffLayout(storage: Pick<Storage, 'getItem'> | undefined): DiffLayout {
  try {
    // Checked against the two it can be rather than cast: what is in storage is
    // a string somebody's browser kept, and a third value would reach the panel
    // as a layout with no rules written for it.
    const raw = storage?.getItem(DIFF_LAYOUT_KEY)
    return raw === 'split' || raw === 'inline' ? raw : DIFF_LAYOUT_DEFAULT
  } catch {
    return DIFF_LAYOUT_DEFAULT
  }
}

export function writeStoredDiffLayout(storage: Pick<Storage, 'setItem'> | undefined, layout: DiffLayout): void {
  try {
    storage?.setItem(DIFF_LAYOUT_KEY, layout)
  } catch {
    // As above: the choice holds for this window and is forgotten on the next.
  }
}

/**
 * The agent kind the composer should offer first, or `NO_DEFAULT_AGENT`.
 *
 * Stored as the kind rather than the command, because the command is what the
 * probe found on this machine's PATH today and the kind is what the person
 * meant. Not checked against the catalogue of kinds here: the only readers
 * match it against the agents actually installed, so a kind this build no
 * longer knows about simply never matches and the first-found rule stands.
 */
export function readStoredDefaultAgent(storage: Pick<Storage, 'getItem'> | undefined): string {
  try {
    const raw = storage?.getItem(DEFAULT_AGENT_KEY)
    return typeof raw === 'string' ? raw.trim() : NO_DEFAULT_AGENT
  } catch {
    return NO_DEFAULT_AGENT
  }
}

export function writeStoredDefaultAgent(storage: Pick<Storage, 'setItem'> | undefined, kind: string): void {
  try {
    storage?.setItem(DEFAULT_AGENT_KEY, kind.trim())
  } catch {
    // As with the size above: the choice holds for this window and is forgotten
    // on the next.
  }
}

/**
 * What each agent is always launched with, by agent kind.
 *
 * One string per agent rather than a list of arguments, because that is what
 * the person types and because the string is spliced into a shell command
 * line, where their own quoting is the thing that has to survive. Read as
 * defensively as the start points above and for the same reason: this ends up
 * on a command line, so anything that is not an object of strings is dropped
 * whole rather than in part.
 *
 * Ships empty on purpose. Whether teamree pre-applies an agent's autonomy flag
 * — `--dangerously-skip-permissions` and its cousins — is a product decision
 * about what this app does to a machine by default, and it is not one to take
 * by seeding a preference; anyone who wants one types it here.
 */
export function readStoredAgentArgs(storage: Pick<Storage, 'getItem'> | undefined): Record<string, string> {
  try {
    const raw = storage?.getItem(AGENT_ARGS_KEY)
    if (raw === null || raw === undefined) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const args: Record<string, string> = {}
    for (const [kind, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value.trim().length > 0) args[kind] = value.trim()
    }
    return args
  } catch {
    return {}
  }
}

export function writeStoredAgentArgs(
  storage: Pick<Storage, 'setItem'> | undefined,
  args: Record<string, string>
): void {
  try {
    storage?.setItem(AGENT_ARGS_KEY, JSON.stringify(args))
  } catch {
    // As above: the choice holds for this window and is forgotten on the next.
  }
}

/**
 * The map with one agent's arguments set, or removed when the field is blank.
 *
 * Removed rather than stored empty, for the same reason as `withStartPoint`:
 * an empty string and an absent entry would be two spellings of "launch it
 * plain", and only one of them is checked for anywhere else.
 */
export function withAgentArgs(
  args: Record<string, string>,
  kind: string,
  value: string | null
): Record<string, string> {
  const trimmed = value?.trim() ?? ''
  if (trimmed.length === 0) {
    const { [kind]: _removed, ...rest } = args
    return rest
  }
  return { ...args, [kind]: trimmed }
}
