// Shape of the on-disk workspace file, plus the salvaging parser that turns
// whatever is actually on disk into something the runtime can hold. Entities in
// src/shared are plain types; these schemas are the runtime's own trust boundary
// against a file a user, a crash, or an older build may have mangled.

import { z } from 'zod'
import type { Layout, PaneNode, Project, Worktree } from '../../shared/entities'
import { AGENT_KINDS } from '../terminals/agent-command'
import type { TerminalRecord } from '../terminals/session-restore'

export const WORKSPACE_DOCUMENT_VERSION = 1

const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  baseRef: z.string().min(1)
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

export type WorkspaceDocument = {
  version: number
  projects: Project[]
  worktrees: Worktree[]
  layouts: Layout[]
  terminals: TerminalRecord[]
  asked: AskedQuestions
}

export function emptyWorkspaceDocument(): WorkspaceDocument {
  return { version: WORKSPACE_DOCUMENT_VERSION, projects: [], worktrees: [], layouts: [], terminals: [], asked: {} }
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
    // Salvaged like everything else: a date somebody hand-edited into a string
    // means the question has not been asked, never that the file is unusable.
    asked: AskedSchema.safeParse(record.asked).data ?? {}
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
