// Shape of the on-disk workspace file, plus the salvaging parser that turns
// whatever is actually on disk into something the runtime can hold. Entities in
// src/shared are plain types; these schemas are the runtime's own trust boundary
// against a file a user, a crash, or an older build may have mangled.

import { z } from 'zod'
import type { Layout, PaneNode, Project, Worktree } from '../../shared/entities'
import { MAX_PANE_LABEL_CHARS } from '../../shared/methods'
import { sanitizeAppearance, type Appearance } from '../../shared/theme'
import { AgentKindOnRead } from '../terminals/agent-command'
import type { ClosedTerminalRecord, TerminalRecord } from '../terminals/session-restore'

export const WORKSPACE_DOCUMENT_VERSION = 1

const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  baseRef: z.string().min(1),
  // Additive and optional: every workspace file already on disk parses.
  linkedPaths: z.array(z.string().min(1)).optional(),
  copiedPaths: z.array(z.string().min(1)).optional(),
  // Never an empty string: the service deletes the field rather than storing one.
  setupCommand: z.string().min(1).optional()
})

const WorktreeSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1),
  branch: z.string().min(1),
  path: z.string().min(1),
  startedFrom: z.string().min(1),
  state: z.enum(['creating', 'ready', 'removing', 'failed']),
  error: z.string().optional(),
  retryable: z.literal(true).optional(),
  createdAt: z.number(),
  // Which pane the setup command was started in; kept so the record still says setup ran.
  setupTerminalId: z.string().min(1).optional(),
  // Never an empty string, for the reason `setupCommand` gives above.
  task: z.string().min(1).optional(),
  baseRef: z.string().min(1).optional(),
  checkout: z.string().min(1).optional()
})

const PaneNodeSchema: z.ZodType<PaneNode> = z.lazy(() =>
  z.union([
    z.object({
      kind: z.literal('leaf'),
      terminalId: z.string().min(1),
      pane: z.enum(['terminal', 'file']).optional(),
      path: z.string().min(1).optional(),
      commit: z.string().min(1).optional(),
      compare: z.string().min(1).optional(),
      review: z.literal(true).optional()
    }),
    z.object({
      kind: z.literal('split'),
      direction: z.enum(['row', 'column']),
      sizes: z.array(z.number()),
      children: z.array(PaneNodeSchema),
      tabs: z.literal(true).optional(),
      shown: z.string().min(1).optional(),
      preview: z.string().min(1).optional()
    })
  ])
)

const LayoutSchema = z.object({
  worktreeId: z.string().min(1),
  root: PaneNodeSchema.nullable(),
  focusedTerminalId: z.string().min(1).nullable()
})

/** A terminal as it outlives the process that ran it; what startup rebuilds a pane from. */
const TerminalRecordSchema = z.object({
  id: z.string().min(1),
  worktreeId: z.string().min(1),
  cwd: z.string().min(1),
  shell: z.string().min(1),
  command: z.string().min(1).optional(),
  agent: AgentKindOnRead,
  agentSessionId: z.string().min(1).optional(),
  // `terminal rename --help` promises the label survives a restart; capped at the wire's length.
  label: z.string().min(1).max(MAX_PANE_LABEL_CHARS).optional(),
  // Whether anybody ever typed into the pane. Absent means unknown, not no:
  // every file already on disk lacks it, and reading it as `false` would take
  // the resume away from every pane once, on the launch after an upgrade.
  typed: z.boolean().optional(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  createdAt: z.number()
})

/** A closed pane kept for `terminal.reopen`. */
const ClosedTerminalSchema = z.object({
  record: TerminalRecordSchema,
  ordinal: z.number().int().positive().optional(),
  closedAt: z.number(),
  place: z
    .object({
      beside: z.array(z.string().min(1)).max(64),
      direction: z.enum(['row', 'column']),
      before: z.boolean()
    })
    .optional()
})

/** Questions this installation only ever asks once, and when. A closed set, not a bag. */
const AskedSchema = z.object({ installCli: z.number().optional() })

export type AskedQuestions = z.infer<typeof AskedSchema>

/** The questions there are. Adding one is adding a field above. */
export type AskedQuestion = keyof AskedQuestions

/**
 * What the update check remembers between runs. Release notes are not kept:
 * text off the wire has no place in the one file the app cannot afford to
 * misread. `automatic` is absent until somebody turns the check off.
 */
const UpdatesSchema = z.object({
  automatic: z.boolean().optional(),
  lastCheckedAt: z.number().optional(),
  /** Bounded because every other field on disk that came off a wire is. */
  lastSeenVersion: z.string().min(1).max(64).optional()
})

export type UpdateRecord = z.infer<typeof UpdatesSchema>

export type WorkspaceDocument = {
  version: number
  projects: Project[]
  worktrees: Worktree[]
  layouts: Layout[]
  terminals: TerminalRecord[]
  /** Closed panes that can be reopened, newest first; see `CLOSED_PANES_KEPT`. */
  closedTerminals: ClosedTerminalRecord[]
  /**
   * Panes the owner has stopped remote keystrokes reaching, by terminal id.
   * Durable because the id survives a restart; pruned by `removeTerminal`.
   */
  mutedTerminals: string[]
  /**
   * Teammates who may always type in a pane without being asked again. Keyed
   * by the public key the handshake authenticates, so it survives a handle change
   * and not a machine change. Pruned by `removeTerminal`.
   */
  standingConsent: StandingConsentRecord[]
  asked: AskedQuestions
  /**
   * How this installation paints itself. Here, not in the renderer's storage:
   * the main process reads it before any window exists for the opening colour.
   */
  appearance: Appearance
  /** The update check's preference and clock. See `UpdatesSchema`. */
  updates: UpdateRecord
}

/** One pane, one teammate, and when the owner said so. */
export type StandingConsentRecord = { terminalId: string; publicKey: string; since: number }

const StandingConsentSchema = z.object({
  terminalId: z.string().min(1),
  publicKey: z.string().min(1),
  since: z.number()
})

export function emptyWorkspaceDocument(): WorkspaceDocument {
  return {
    version: WORKSPACE_DOCUMENT_VERSION,
    projects: [],
    worktrees: [],
    layouts: [],
    terminals: [],
    closedTerminals: [],
    mutedTerminals: [],
    standingConsent: [],
    asked: {},
    appearance: sanitizeAppearance(undefined),
    updates: {}
  }
}

/**
 * Never throws. A corrupt document yields an empty workspace; a document with a
 * few bad rows yields the rows that still parse, because losing one broken
 * worktree beats losing every project the user ever added.
 */
export function parseWorkspaceDocument(raw: unknown): WorkspaceDocument {
  if (typeof raw !== 'object' || raw === null) return emptyWorkspaceDocument()
  const record = raw as Record<string, unknown>
  return {
    version: WORKSPACE_DOCUMENT_VERSION,
    projects: salvage(record.projects, ProjectSchema),
    worktrees: salvage(record.worktrees, WorktreeSchema),
    layouts: salvage(record.layouts, LayoutSchema),
    terminals: salvage(record.terminals, TerminalRecordSchema) as TerminalRecord[],
    closedTerminals: salvage(record.closedTerminals, ClosedTerminalSchema) as ClosedTerminalRecord[],
    mutedTerminals: salvage(record.mutedTerminals, z.string().min(1)),
    standingConsent: salvage(record.standingConsent, StandingConsentSchema),
    // A hand-edited date means the question has not been asked, never that the file is unusable.
    asked: AskedSchema.safeParse(record.asked).data ?? {},
    // Salvaged one colour at a time: a single bad hex costs that colour, not the theme.
    appearance: sanitizeAppearance(record.appearance),
    updates: UpdatesSchema.safeParse(record.updates).data ?? {}
  }
}

function salvage<T>(raw: unknown, schema: z.ZodType<T>): T[] {
  if (!Array.isArray(raw)) return []
  const rows: T[] = []
  for (const candidate of raw) {
    const parsed = schema.safeParse(candidate)
    if (parsed.success) rows.push(parsed.data)
  }
  return rows
}
