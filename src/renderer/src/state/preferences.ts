// Per-machine preferences: what one person at one screen has chosen. All live in
// this window's `localStorage` behind a clamp, with every read and write wrapped
// so storage being unavailable costs a default rather than a render.

/** Below this the emulator's own glyphs stop being glyphs; above it a pane holds nothing. */
export const TERMINAL_FONT_MIN_PX = 9
export const TERMINAL_FONT_MAX_PX = 24
/** What xterm was hard-coded to before any of this was settable. */
export const TERMINAL_FONT_DEFAULT_PX = 12

const FONT_SIZE_KEY = 'teamree.terminal.fontSize'
const START_POINTS_KEY = 'teamree.worktree.startPoints'
const AGENT_NOTICES_KEY = 'teamree.agent.notices'

/**
 * What an agent pane going quiet may do. Three values rather than two booleans: a sound with no
 * notification is not a state anybody wants.
 */
export type AgentNoticePreference = 'off' | 'notify' | 'sound'

export const AGENT_NOTICE_PREFERENCES: readonly AgentNoticePreference[] = ['off', 'notify', 'sound']

/** On, silently: `off` ships the premise turned off, and a default that makes noise is a decision about somebody's room. */
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
    // Storage full or blocked: the choice holds for this window and is forgotten on the next.
  }
}

const KEEP_AWAKE_KEY = 'teamree.keepAwake'

/**
 * Whether this Mac may sleep: never while the app runs, not while an agent pane is busy or waiting,
 * or whenever the OS would. Only the main process can hold a power assertion; `useKeepAwake` publishes it.
 */
export type KeepAwakeMode = 'on' | 'agent' | 'off'

export const KEEP_AWAKE_MODES: readonly KeepAwakeMode[] = ['on', 'agent', 'off']

/** Follow the agents: a laptop that sleeps mid-turn stops all three, and `on` would hold the machine up all night for an empty window. */
export const KEEP_AWAKE_DEFAULT: KeepAwakeMode = 'agent'

export function readStoredKeepAwake(storage: Pick<Storage, 'getItem'> | undefined): KeepAwakeMode {
  try {
    const raw = storage?.getItem(KEEP_AWAKE_KEY)
    return KEEP_AWAKE_MODES.find((value) => value === raw) ?? KEEP_AWAKE_DEFAULT
  } catch {
    return KEEP_AWAKE_DEFAULT
  }
}

export function writeStoredKeepAwake(storage: Pick<Storage, 'setItem'> | undefined, mode: KeepAwakeMode): void {
  try {
    storage?.setItem(KEEP_AWAKE_KEY, mode)
  } catch {
    // As above: the choice holds for this window and is forgotten on the next.
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
    // As above: the choice holds for this window and is forgotten on the next.
  }
}

/**
 * Each project's preferred start point, by project id. Anything that is not an object of non-empty
 * strings is dropped whole, so a corrupt entry cannot put `[object Object]` into a git ref field.
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

/** The map with one project's preference set, or removed when blank: absence is the only spelling of "use the base ref" checked for elsewhere. */
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
 * Each project's editor command, by project id. Read as defensively as the start points: this names
 * a program the main process looks for on PATH (one program name, never a command line).
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

/** The map with one project's editor set, or removed when blank: absence is the only spelling of "use PATH" the main process checks. */
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

/** How a patch is laid out. Inline by default: this is a side panel, and two columns in three hundred pixels is two columns of nothing. */
export type DiffLayout = 'inline' | 'split'

export const DIFF_LAYOUT_DEFAULT: DiffLayout = 'inline'

export function readStoredDiffLayout(storage: Pick<Storage, 'getItem'> | undefined): DiffLayout {
  try {
    // Checked rather than cast: a third value would reach the panel as a layout with no rules written for it.
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
 * The agent kind the composer offers first, or `NO_DEFAULT_AGENT`. The kind rather than the command,
 * and unchecked here: readers match it against installed agents, so an unknown kind simply never matches.
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
    // As above: the choice holds for this window and is forgotten on the next.
  }
}

/**
 * What each agent is always launched with, by kind: one string, spliced into a shell command line so
 * the person's own quoting survives. Ships empty on purpose: seeding `--dangerously-skip-permissions`
 * or its cousins is a product decision about what this app does to a machine, not a preference default.
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

/** The map with one agent's arguments set, or removed when blank, for the same reason as `withStartPoint`. */
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
