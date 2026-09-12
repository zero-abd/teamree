// Shape of the on-disk workspace file, plus the salvaging parser that turns
// whatever is actually on disk into something the runtime can hold. Entities in
// src/shared are plain types; these schemas are the runtime's own trust boundary
// against a file a user, a crash, or an older build may have mangled.

import { z } from 'zod'
import type { Layout, PaneNode, Project, Worktree } from '../../shared/entities'

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

export type WorkspaceDocument = {
  version: number
  projects: Project[]
  worktrees: Worktree[]
  layouts: Layout[]
}

export function emptyWorkspaceDocument(): WorkspaceDocument {
  return { version: WORKSPACE_DOCUMENT_VERSION, projects: [], worktrees: [], layouts: [] }
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
    layouts: salvage(record.layouts, LayoutSchema)
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
