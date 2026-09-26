// The context-provider protocol: one JSON object per line over a provider's
// stdio. How an out-of-process memory (the Jac add-on) plugs in behind `project.context`.

import { z } from 'zod'
import {
  MAX_NOTE_CHARS,
  MAX_NOTE_PATHS,
  NOTE_KINDS,
  type ContextSection,
  type MemoryNote,
  type MemoryTouch,
  type MemoryWorktree
} from './memory'

export const CONTEXT_PROVIDER_PROTOCOL = 1

/** A provider command for development, used instead of any add-on. */
export const CONTEXT_PROVIDER_ENV = 'TEAMREE_CONTEXT_PROVIDER'

/** Every call to a provider is cut here; past it the built-in bundle answers alone. */
export const PROVIDER_TIMEOUT_MS = 800

/** Failures in a row before a provider is turned off until restart. */
export const PROVIDER_FAILURES_BEFORE_OFF = 3

/** Longest line read from a provider; a longer one is a failure, not a reply. */
export const MAX_PROVIDER_LINE_CHARS = 262_144

/** A change to project memory, mirrored to a provider as it happens. */
export type MemoryEvent =
  | { type: 'worktree'; worktree: MemoryWorktree }
  | { type: 'worktreeRemoved'; worktreeId: string }
  | { type: 'touch'; touch: MemoryTouch }
  /** A note written, answered or updated. */
  | { type: 'note'; note: MemoryNote }
  | { type: 'noteForgotten'; noteId: string }
  | { type: 'landed'; worktreeId: string; into: string }

/** Lines teamree writes to a provider. */
export type ProviderRequest =
  | { type: 'hello'; protocol: number; app: string }
  | { type: 'event'; projectId: string; event: MemoryEvent }
  | {
      type: 'context'
      id: number
      projectId: string
      worktreeId: string
      budgetTokens: number
      sections?: ContextSection[]
      query?: string
    }

const Text = (max: number) => z.string().max(max)
const Paths = z.array(z.string().min(1).max(4096)).max(200)

const ProviderNote = z.object({
  id: z.string().min(1).max(256),
  worktreeId: z.string().min(1).max(256),
  kind: z.enum(NOTE_KINDS as [MemoryNote['kind'], ...MemoryNote['kind'][]]),
  text: Text(MAX_NOTE_CHARS),
  scope: z.enum(['private', 'team']),
  open: z.boolean().optional(),
  answer: Text(MAX_NOTE_CHARS).optional(),
  paths: z.array(z.string().min(1).max(4096)).max(MAX_NOTE_PATHS).optional(),
  at: z.number(),
  author: z.string().min(1).max(256),
  agentId: z.string().max(256).optional()
})

/** What a provider may add to the bundle; teamree merges it and re-applies the budget. */
export const ProviderContextSchema = z.object({
  ancestors: z
    .array(z.object({ worktreeId: z.string().min(1).max(256), name: Text(512), goal: Text(512) }))
    .max(16)
    .optional(),
  self: z
    .object({ goal: Text(512), decisions: z.array(ProviderNote).max(50), questions: z.array(ProviderNote).max(50) })
    .optional(),
  siblings: z
    .array(
      z.object({
        worktreeId: z.string().min(1).max(256),
        name: Text(512),
        goal: Text(512),
        state: Text(64),
        owner: z.string().min(1).max(256),
        overlap: Paths,
        decisions: z.array(ProviderNote).max(50)
      })
    )
    .max(50)
    .optional(),
  files: z
    .array(z.object({ path: z.string().min(1).max(4096), summary: Text(240), touchedBy: z.array(Text(256)).max(20) }))
    .max(200)
    .optional()
})

export type ProviderContext = z.infer<typeof ProviderContextSchema>

/** Lines a provider writes back. Anything else is a failure. */
export const ProviderReplySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), protocol: z.number().int(), name: Text(128), version: Text(64) }),
  z.object({ type: z.literal('context'), id: z.number().int(), context: ProviderContextSchema }),
  z.object({ type: z.literal('error'), id: z.number().int().optional(), message: Text(1024) })
])

export type ProviderReply = z.infer<typeof ProviderReplySchema>

/** One line from a provider, or undefined when it is not a reply this protocol knows. */
export function parseProviderLine(line: string): ProviderReply | undefined {
  if (line.length > MAX_PROVIDER_LINE_CHARS) return undefined
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  return ProviderReplySchema.safeParse(value).data
}

export type AddonId = 'jac-memory'

export const ADDON_IDS: readonly AddonId[] = ['jac-memory']

export type AddonState = 'off' | 'installing' | 'running' | 'failed'

/** One add-on as Settings › Add-ons shows it. `needs` names a missing tool, never downloaded for the person. */
export type AddonStatus = {
  id: AddonId
  state: AddonState
  detail?: string
  needs?: 'uv'
  version?: string
}
