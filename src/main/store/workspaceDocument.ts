// Shape of the on-disk workspace file, plus the salvaging parser that turns
// whatever is actually on disk into something the runtime can hold. Entities in
// src/shared are plain types; these schemas are the runtime's own trust boundary
// against a file a user, a crash, or an older build may have mangled.

import { z } from 'zod'
import type { Layout, PaneNode, Project, Worktree } from '../../shared/entities'
import { sanitizeAppearance, type Appearance } from '../../shared/theme'
import { AGENT_KINDS } from '../terminals/agent-command'
import type { TerminalRecord } from '../terminals/session-restore'

export const WORKSPACE_DOCUMENT_VERSION = 1

const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  baseRef: z.string().min(1),
  // Additive and optional: every workspace file already on disk parses as a
  // project with neither list, which is exactly what a project that carries
  // nothing over into its worktrees looks like.
  linkedPaths: z.array(z.string().min(1)).optional(),
  copiedPaths: z.array(z.string().min(1)).optional()
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
  createdAt: z.number()
})

const PaneNodeSchema: z.ZodType<PaneNode> = z.lazy(() =>
  z.union([
    z.object({ kind: z.literal('leaf'), terminalId: z.string().min(1) }),
    z.object({
      kind: z.literal('split'),
      direction: z.enum(['row', 'column']),
      sizes: z.array(z.number()),
      children: z.array(PaneNodeSchema)
    })
  ])
)

const LayoutSchema = z.object({
  worktreeId: z.string().min(1),
  root: PaneNodeSchema.nullable(),
  focusedTerminalId: z.string().min(1).nullable()
})

/**
 * A terminal as it outlives the process that ran it. The PTY is gone on the
 * next launch; this is what startup rebuilds a pane from.
 */
const TerminalRecordSchema = z.object({
  id: z.string().min(1),
  worktreeId: z.string().min(1),
  cwd: z.string().min(1),
  shell: z.string().min(1),
  command: z.string().min(1).optional(),
  agent: z.enum(AGENT_KINDS as [string, ...string[]]).optional(),
  agentSessionId: z.string().min(1).optional(),
  // Whether anybody ever typed into the pane, which is what the next launch
  // reads to decide whether the pinned id above names a conversation at all.
  //
  // Optional because it has to be, and the absent case is the one to be careful
  // about: every workspace file already written is missing this field, and the
  // panes in those files are mostly panes with real conversations behind them.
  // Absent therefore means unknown rather than no — the restore tries the
  // resume, and a resume that turns out to find nothing writes `false` here on
  // its way out, so the pane starts over on the launch after that. Reading
  // absent as `false` would take the resume away from every pane already on
  // disk, exactly once, on the launch after an upgrade: the same bug this field
  // exists to fix, arrived at from the other side.
  typed: z.boolean().optional(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  createdAt: z.number()
})

/**
 * Questions this installation only ever asks once, and when it asked them.
 *
 * A closed set rather than a free-form bag, so the file cannot silently
 * accumulate keys nobody remembers writing. A timestamp rather than a flag
 * because it costs the same and answers "when did it stop asking me".
 */
const AskedSchema = z.object({ installCli: z.number().optional() })

export type AskedQuestions = z.infer<typeof AskedSchema>

/** The questions there are. Adding one is adding a field above. */
export type AskedQuestion = keyof AskedQuestions

/**
 * What the update check remembers between runs.
 *
 * Three small facts, and what is *not* here is the decision worth explaining:
 * the release notes are not kept. They are text from the GitHub API, and this
 * file is the one the app cannot afford to have trouble reading — the store
 * refuses to write over a file it could not parse precisely because somebody's
 * projects are in it. `teammateCache.ts` makes the same argument for the bytes
 * a peer sends, and keeps them somewhere else. So a run that is inside the rate
 * limit can still say that 0.2.0 exists, and offers the release page rather
 * than notes it did not keep.
 *
 * `automatic` is absent until somebody turns the check off, which is what makes
 * "on unless said otherwise" a fact about the schema rather than a fact spread
 * across the readers.
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
  /**
   * Panes the owner has stopped remote keystrokes reaching, by terminal id.
   *
   * Here rather than in memory because a terminal id survives a restart on
   * purpose — `session-restore.ts` keeps it so the pane layout needs no
   * remapping — so a pane comes back indistinguishable from the one that was
   * muted: same id, same worktree, same conversation resumed. A mute that did
   * not come back with it would be the owner's decision discarded at the one
   * moment nothing on screen says so.
   *
   * Beside the terminal records and pruned with them: `removeTerminal` drops
   * the mute, so there is nothing to sweep at startup, which is the moment
   * sweeping is least reliable.
   */
  mutedTerminals: string[]
  /**
   * Teammates the owner has told this machine may always type in a pane,
   * without being asked again.
   *
   * The mirror image of the list above, and here for the same two reasons. It
   * is durable because a permission that lapsed at the next restart would be
   * the owner's decision quietly discarded — they would find out by being asked
   * again for something they had already settled, which trains people to click
   * through the question this whole feature exists to make them read. And it is
   * kept beside the terminal records because a permission is about one pane, so
   * `removeTerminal` drops it and there is nothing to sweep.
   *
   * The key is committed to the repository and is the identity the handshake
   * authenticates, so this survives a teammate changing their handle and does
   * not survive them changing their machine — which is the right way round.
   */
  standingConsent: StandingConsentRecord[]
  asked: AskedQuestions
  /**
   * How this installation paints itself: a preset, an optional ground and
   * accent, and any per-token edits.
   *
   * Here rather than in the renderer's local storage because it is a fact about
   * the installation and not about one window: the main process reads it before
   * any window exists, to give the window the background colour it will open
   * with, and a second window has to open the same colour as the first. It is
   * also the shape of preference this file already holds — `asked` is the same
   * kind of thing — so it costs no new file on disk.
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
    mutedTerminals: salvage(record.mutedTerminals, z.string().min(1)),
    standingConsent: salvage(record.standingConsent, StandingConsentSchema),
    // Salvaged like everything else: a date somebody hand-edited into a string
    // means the question has not been asked, never that the file is unusable.
    asked: AskedSchema.safeParse(record.asked).data ?? {},
    // Salvaged one colour at a time rather than parsed whole: a theme with a
    // single bad hex in it should cost that colour, not the whole choice.
    appearance: sanitizeAppearance(record.appearance),
    // Salvaged on the same terms: a preference nobody can read is a preference
    // that has not been expressed, which is the default rather than a failure.
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
