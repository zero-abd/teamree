// Per-machine preferences: what one person at one screen has chosen. All live in
// this window's `localStorage` behind a clamp, with every read and write wrapped
// so storage being unavailable costs a default rather than a render.

import { isPermissionMode, type PermissionMode } from '@shared/permissionMode'
import { DEFAULT_SCROLLBACK_LINES, SCROLLBACK_LINES_MAX, SCROLLBACK_LINES_MIN } from '@shared/settings'

/** Below this the emulator's own glyphs stop being glyphs; above it a pane holds nothing. */
export const TERMINAL_FONT_MIN_PX = 9
export const TERMINAL_FONT_MAX_PX = 24
/** What xterm was hard-coded to before any of this was settable. */
export const TERMINAL_FONT_DEFAULT_PX = 12

const FONT_SIZE_KEY = 'teamree.terminal.fontSize'
const START_POINTS_KEY = 'teamree.worktree.startPoints'
const PUSH_ON_MERGE_KEY = 'teamree.merge.push'
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
const PERMISSION_MODES_KEY = 'teamree.agent.permissionModes'

/** The default-agent preference when none has been set: no agent is preferred. */
export const NO_DEFAULT_AGENT = ''
const DIFF_LAYOUT_KEY = 'teamree.diff.layout'
const DIFF_OPTIONS_KEY = 'teamree.diff.options'

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

const TERMINAL_OPTIONS_KEY = 'teamree.terminal.options'

export type TerminalCursorStyle = 'bar' | 'block' | 'underline'

export const TERMINAL_CURSOR_STYLES: readonly TerminalCursorStyle[] = ['bar', 'block', 'underline']

export const TERMINAL_SCROLLBACK_MIN = SCROLLBACK_LINES_MIN
export const TERMINAL_SCROLLBACK_MAX = SCROLLBACK_LINES_MAX
export const TERMINAL_LINE_HEIGHT_MIN = 1
export const TERMINAL_LINE_HEIGHT_MAX = 2

/** How every pane draws and reads keys, apart from its text size. */
export type TerminalOptions = {
  /** A CSS font stack. */
  fontFamily: string
  cursorStyle: TerminalCursorStyle
  cursorBlink: boolean
  /** Option sends ESC-prefixed keys (word motion in shells and agent TUIs) instead of composing characters. */
  optionIsMeta: boolean
  copyOnSelect: boolean
  scrollback: number
  /** A multiple of the font's own line, in steps of 0.05. */
  lineHeight: number
}

export const TERMINAL_OPTIONS_DEFAULT: TerminalOptions = {
  fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace',
  cursorStyle: 'bar',
  cursorBlink: true,
  optionIsMeta: false,
  copyOnSelect: false,
  scrollback: DEFAULT_SCROLLBACK_LINES,
  lineHeight: 1.25
}

/** Each field checked on its own, so one bad value costs that field its default and no other. */
export function sanitizeTerminalOptions(raw: unknown): TerminalOptions {
  const value = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const fallback = TERMINAL_OPTIONS_DEFAULT
  const flag = (key: 'cursorBlink' | 'optionIsMeta' | 'copyOnSelect'): boolean => {
    const stored = value[key]
    return typeof stored === 'boolean' ? stored : fallback[key]
  }
  const font = typeof value.fontFamily === 'string' ? value.fontFamily.trim() : ''
  const { scrollback, lineHeight } = value
  return {
    fontFamily: font.length > 0 ? font : fallback.fontFamily,
    cursorStyle: TERMINAL_CURSOR_STYLES.find((style) => style === value.cursorStyle) ?? fallback.cursorStyle,
    cursorBlink: flag('cursorBlink'),
    optionIsMeta: flag('optionIsMeta'),
    copyOnSelect: flag('copyOnSelect'),
    scrollback:
      typeof scrollback === 'number' && Number.isFinite(scrollback)
        ? Math.min(Math.max(Math.round(scrollback), TERMINAL_SCROLLBACK_MIN), TERMINAL_SCROLLBACK_MAX)
        : fallback.scrollback,
    lineHeight:
      typeof lineHeight === 'number' && Number.isFinite(lineHeight)
        ? Math.min(Math.max(Math.round(lineHeight * 20) / 20, TERMINAL_LINE_HEIGHT_MIN), TERMINAL_LINE_HEIGHT_MAX)
        : fallback.lineHeight
  }
}

/** Reads a stored object of flags, each one falling back to its default on its own. */
function readFlags<T extends Record<string, boolean>>(
  storage: Pick<Storage, 'getItem'> | undefined,
  key: string,
  fallback: T
): T {
  try {
    const raw = storage?.getItem(key)
    const parsed: unknown = raw === null || raw === undefined ? null : JSON.parse(raw)
    const value = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    const flags = { ...fallback }
    for (const name of Object.keys(fallback) as (keyof T)[]) {
      const stored = value[name as string]
      if (typeof stored === 'boolean') flags[name] = stored as T[keyof T]
    }
    return flags
  } catch {
    return fallback
  }
}

function writeJson(storage: Pick<Storage, 'setItem'> | undefined, key: string, value: unknown): void {
  try {
    storage?.setItem(key, JSON.stringify(value))
  } catch {
    // As above: the choice holds for this window and is forgotten on the next.
  }
}

const NOTICE_EVENTS_KEY = 'teamree.notices.events'

/** Which events raise a notification, under the one preference for how. */
export type NoticeEvents = { finished: boolean; asking: boolean; teammates: boolean }

export const NOTICE_EVENTS_DEFAULT: NoticeEvents = { finished: true, asking: true, teammates: true }

export function readStoredNoticeEvents(storage: Pick<Storage, 'getItem'> | undefined): NoticeEvents {
  return readFlags(storage, NOTICE_EVENTS_KEY, NOTICE_EVENTS_DEFAULT)
}

export function writeStoredNoticeEvents(storage: Pick<Storage, 'setItem'> | undefined, events: NoticeEvents): void {
  writeJson(storage, NOTICE_EVENTS_KEY, events)
}

const CONFIRMATIONS_KEY = 'teamree.confirm'

/** The questions that can be turned off: deleting a clean worktree, and closing a working agent's pane. */
export type Confirmations = { removeWorktree: boolean; stopAgent: boolean }

export const CONFIRMATIONS_DEFAULT: Confirmations = { removeWorktree: true, stopAgent: true }

export function readStoredConfirmations(storage: Pick<Storage, 'getItem'> | undefined): Confirmations {
  return readFlags(storage, CONFIRMATIONS_KEY, CONFIRMATIONS_DEFAULT)
}

export function writeStoredConfirmations(
  storage: Pick<Storage, 'setItem'> | undefined,
  confirmations: Confirmations
): void {
  writeJson(storage, CONFIRMATIONS_KEY, confirmations)
}

export function readStoredTerminalOptions(storage: Pick<Storage, 'getItem'> | undefined): TerminalOptions {
  try {
    const raw = storage?.getItem(TERMINAL_OPTIONS_KEY)
    return sanitizeTerminalOptions(raw === null || raw === undefined ? null : JSON.parse(raw))
  } catch {
    return TERMINAL_OPTIONS_DEFAULT
  }
}

export function writeStoredTerminalOptions(
  storage: Pick<Storage, 'setItem'> | undefined,
  options: TerminalOptions
): void {
  try {
    storage?.setItem(TERMINAL_OPTIONS_KEY, JSON.stringify(sanitizeTerminalOptions(options)))
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

/** Whether Merge into main… last pushed main, by project id. */
export function readStoredPushOnMerge(storage: Pick<Storage, 'getItem'> | undefined): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(PUSH_ON_MERGE_KEY) ?? '{}')
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean')
    )
  } catch {
    return {}
  }
}

export function writeStoredPushOnMerge(
  storage: Pick<Storage, 'setItem'> | undefined,
  choices: Record<string, boolean>
): void {
  try {
    storage?.setItem(PUSH_ON_MERGE_KEY, JSON.stringify(choices))
  } catch {
    // Kept for this window only.
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

/** The key in the editor map for every project that names none of its own. */
export const ANY_PROJECT = '*'

/** The editor a project's checkouts open in: its own, else the one for every project. */
export function editorFor(commands: Readonly<Record<string, string>>, projectId: string): string | undefined {
  return commands[projectId] ?? commands[ANY_PROJECT]
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

/** Whether diffs wrap long lines, and whether they hide changes that are only whitespace. */
export type DiffOptions = { wrap: boolean; hideWhitespace: boolean }

export const DIFF_OPTIONS_DEFAULT: DiffOptions = { wrap: false, hideWhitespace: false }

export function readStoredDiffOptions(storage: Pick<Storage, 'getItem'> | undefined): DiffOptions {
  try {
    const raw: unknown = JSON.parse(storage?.getItem(DIFF_OPTIONS_KEY) ?? '{}')
    const stored = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
    return { wrap: stored.wrap === true, hideWhitespace: stored.hideWhitespace === true }
  } catch {
    return DIFF_OPTIONS_DEFAULT
  }
}

export function writeStoredDiffOptions(storage: Pick<Storage, 'setItem'> | undefined, options: DiffOptions): void {
  try {
    storage?.setItem(DIFF_OPTIONS_KEY, JSON.stringify(options))
  } catch {
    // The choice holds for this window only.
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

/** Each project's last permission mode per agent kind. Unknown modes are dropped, never guessed at. */
export function readStoredPermissionModes(
  storage: Pick<Storage, 'getItem'> | undefined
): Record<string, Record<string, PermissionMode>> {
  try {
    const raw = storage?.getItem(PERMISSION_MODES_KEY)
    if (raw === null || raw === undefined) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return {}
    const projects: Record<string, Record<string, PermissionMode>> = {}
    for (const [projectId, modes] of Object.entries(parsed)) {
      if (!isRecord(modes)) continue
      const kept: Record<string, PermissionMode> = {}
      for (const [kind, mode] of Object.entries(modes)) if (isPermissionMode(mode)) kept[kind] = mode
      projects[projectId] = kept
    }
    return projects
  } catch {
    return {}
  }
}

export function writeStoredPermissionModes(
  storage: Pick<Storage, 'setItem'> | undefined,
  modes: Record<string, Record<string, PermissionMode>>
): void {
  try {
    storage?.setItem(PERMISSION_MODES_KEY, JSON.stringify(modes))
  } catch {
    // As above: the choice holds for this window and is forgotten on the next.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
