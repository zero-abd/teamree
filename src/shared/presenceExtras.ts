// Presence v2: the optional fields a newer runtime adds to what teammates see.
// Read field by field, so a malformed one costs that field and never the snapshot.

import { z } from 'zod'
import { MAX_PEER_MEMORY_BYTES } from './memory'
import { TASK_STAGES, type TaskStage } from './tasks'

/** Bounds on what presence v2 carries per worktree. */
export const PEER_TASK_CHARS = 200
export const MAX_PEER_PATHS = 200
export const PEER_REPORT_CHARS = 300
export const MAX_HANDOFFS = 20
export const MAX_HANDOFF_NOTE_CHARS = 4096

const onRead = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined)
const clipped = (max: number) => z.string().transform((text) => text.slice(0, max))
const Id = z.string().min(1).max(256)
const Path = z.string().min(1).max(4096)

const PeerMemoryNoteSchema = z.object({
  id: Id,
  kind: z.enum(['decision', 'question']),
  text: z.string().max(500),
  at: z.number(),
  open: z.boolean().optional(),
  paths: z.array(Path).max(20).optional()
})

const PeerWorktreeMemorySchema = z
  .object({
    revision: z.number().int().nonnegative(),
    notes: z.array(PeerMemoryNoteSchema).max(50),
    touched: z.array(Path).max(MAX_PEER_PATHS).optional()
  })
  .refine((memory) => JSON.stringify(memory).length <= MAX_PEER_MEMORY_BYTES)

/** Spread into a `PeerWorktree` payload schema with `.extend`. Paths only, never contents. */
export const PeerWorktreeExtrasOnRead = {
  task: onRead(clipped(PEER_TASK_CHARS)),
  parentId: onRead(Id),
  paths: onRead(z.array(Path).transform((paths) => paths.slice(0, MAX_PEER_PATHS))),
  ahead: onRead(z.number().int().nonnegative()),
  stage: onRead(z.enum(TASK_STAGES as [TaskStage, ...TaskStage[]])),
  report: onRead(z.object({ outcome: z.enum(['succeeded', 'failed']), summary: clipped(PEER_REPORT_CHARS) })),
  memory: onRead(PeerWorktreeMemorySchema)
}

const PeerHandoffSchema = z.object({
  id: Id,
  to: z.string().min(1).max(160),
  from: z.string().max(160).optional(),
  worktreeName: clipped(512),
  branch: z.string().min(1).max(512),
  note: z.string().max(MAX_HANDOFF_NOTE_CHARS),
  at: z.number()
})

/** Spread into the `PeerPresence` payload schema with `.extend`. */
export const PeerPresenceExtrasOnRead = {
  handoffs: onRead(z.array(PeerHandoffSchema).transform((handoffs) => handoffs.slice(0, MAX_HANDOFFS))),
  took: onRead(z.array(Id).max(MAX_HANDOFFS * 5))
}
