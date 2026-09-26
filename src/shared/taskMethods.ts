// Methods for task trees, messages, project memory, overlaps, usage, handoffs,
// templates, settings and add-ons. Merged into `Params` and `MethodContract` in methods.ts.

import { z } from 'zod'
import { MAX_AGENT_ARGS_CHARS } from './agentLaunch'
import { ADDON_IDS, type AddonId, type AddonStatus } from './contextProvider'
import type { Worktree } from './entities'
import {
  CONTEXT_SECTIONS,
  MAX_NOTE_CHARS,
  MAX_NOTE_PATHS,
  NOTE_KINDS,
  type ContextSection,
  type MemoryConflict,
  type MemoryNote,
  type NoteKind,
  type ProjectContext
} from './memory'
import { MAX_MESSAGE_BYTES, MAX_MESSAGE_OPTIONS, MESSAGE_KINDS, type MessageKind, type TaskMessage } from './messages'
import { MAX_HANDOFF_NOTE_CHARS } from './presenceExtras'
import type { RuntimeSettings } from './settings'
import type {
  PeerHandoff,
  TaskTemplate,
  TaskTemplateList,
  TeamworkHandoffs,
  WorktreeOverlaps,
  WorktreeUsage
} from './tasks'

const Id = z.string().min(1).max(256)
const Path = z.string().min(1).max(4096)
const encoder = new TextEncoder()
const Body = z
  .string()
  .min(1)
  .refine((text) => encoder.encode(text).length <= MAX_MESSAGE_BYTES, {
    message: `must be at most ${MAX_MESSAGE_BYTES} bytes`
  })

const Party = z
  .object({ worktreeId: Id.optional(), terminalId: Id.optional(), you: z.literal(true).optional() })
  .refine((party) => party.worktreeId !== undefined || party.terminalId !== undefined || party.you === true, {
    message: 'names nobody'
  })

const Address = z.union([z.object({ relation: z.enum(['parent', 'children', 'siblings']) }), Party])
const Outcome = z.enum(['succeeded', 'failed'])

export const TaskParams = {
  /** `reply` names the ask it answers; `outcome` belongs to `done` alone. */
  messageSend: z
    .object({
      from: Party,
      to: Address,
      kind: z.enum(MESSAGE_KINDS as [MessageKind, ...MessageKind[]]),
      text: Body,
      options: z.array(z.string().min(1).max(200)).min(1).max(MAX_MESSAGE_OPTIONS).optional(),
      replyTo: z.number().int().positive().optional(),
      outcome: Outcome.optional()
    })
    .refine((message) => message.kind !== 'reply' || message.replyTo !== undefined, {
      message: 'a reply names the ask it answers',
      path: ['replyTo']
    })
    .refine((message) => message.outcome === undefined || message.kind === 'done', {
      message: 'only done carries an outcome',
      path: ['outcome']
    }),
  messageList: z.object({
    projectId: Id.optional(),
    worktreeId: Id.optional(),
    terminalId: Id.optional(),
    kinds: z
      .array(z.enum(MESSAGE_KINDS as [MessageKind, ...MessageKind[]]))
      .min(1)
      .optional(),
    open: z.boolean().optional(),
    limit: z.number().int().positive().max(2000).optional()
  }),
  messageRead: z.object({ ids: z.array(z.number().int().positive()).min(1).max(2000) }),

  /** `budgetTokens` is clamped to `CONTEXT_BUDGET`; `format: 'text'` fills `text` only. */
  projectContext: z.object({
    worktreeId: Id,
    budgetTokens: z.number().int().positive().optional(),
    sections: z
      .array(z.enum(CONTEXT_SECTIONS as [ContextSection, ...ContextSection[]]))
      .min(1)
      .optional(),
    format: z.enum(['text', 'json']).optional(),
    query: z.string().max(512).optional()
  }),
  memoryNote: z.object({
    worktreeId: Id,
    kind: z.enum(NOTE_KINDS as [NoteKind, ...NoteKind[]]),
    text: z.string().trim().min(1).max(MAX_NOTE_CHARS),
    scope: z.enum(['private', 'team']).optional(),
    paths: z.array(Path).max(MAX_NOTE_PATHS).optional(),
    /** The pane writing it, when an agent is. */
    terminalId: Id.optional()
  }),
  memoryResolve: z.object({ noteId: Id, answer: z.string().max(MAX_NOTE_CHARS).optional() }),
  memoryForget: z.object({ noteId: Id }),
  memoryConflicts: z.object({ worktreeId: Id }),

  worktreeOverlaps: z.object({ projectId: Id }),
  worktreeUsage: z.object({ worktreeId: Id.optional(), projectId: Id.optional() }),

  teamworkHandOff: z.object({
    worktreeId: Id,
    to: z.string().min(1).max(160),
    note: z.string().max(MAX_HANDOFF_NOTE_CHARS)
  }),
  teamworkHandoffs: z.object({ projectId: Id }),
  teamworkTake: z.object({ projectId: Id, id: Id, agent: z.string().min(1).max(64).optional() }),
  teamworkDismissHandoff: z.object({ projectId: Id, id: Id }),

  projectTemplates: z.object({ projectId: Id }),
  projectSaveTemplate: z.object({
    projectId: Id,
    name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i),
    agents: z.record(z.string().min(1).max(64), z.number().int().min(0).max(16)),
    prompt: z.string().min(1).max(MAX_AGENT_ARGS_CHARS),
    from: z.enum(['base', 'parent']).optional()
  }),

  settingsGet: z.object({}),
  /** Omitted keys stay as they are. */
  settingsSet: z.object({
    shareTaskDetails: z.boolean().optional(),
    showCost: z.boolean().optional(),
    jacMemoryAddon: z.boolean().optional(),
    showInMenuBar: z.boolean().optional()
  }),

  addonsStatus: z.object({}),
  /** Sets the add-on up with the person's own tools; never downloads a binary. */
  addonsInstall: z.object({ id: z.enum(ADDON_IDS as [AddonId, ...AddonId[]]) })
} as const

type P = typeof TaskParams

export type TaskMethodContract = {
  /** One message per recipient: `children` and `siblings` fan out. */
  'message.send': { params: z.infer<P['messageSend']>; result: TaskMessage[] }
  'message.list': { params: z.infer<P['messageList']>; result: TaskMessage[] }
  'message.read': { params: z.infer<P['messageRead']>; result: { read: number } }

  'project.context': { params: z.infer<P['projectContext']>; result: ProjectContext }
  'memory.note': { params: z.infer<P['memoryNote']>; result: MemoryNote }
  'memory.resolve': { params: z.infer<P['memoryResolve']>; result: MemoryNote }
  'memory.forget': { params: z.infer<P['memoryForget']>; result: { forgotten: true } }
  'memory.conflicts': { params: z.infer<P['memoryConflicts']>; result: MemoryConflict[] }

  'worktree.overlaps': { params: z.infer<P['worktreeOverlaps']>; result: WorktreeOverlaps }
  'worktree.usage': { params: z.infer<P['worktreeUsage']>; result: WorktreeUsage[] }

  'teamwork.handOff': { params: z.infer<P['teamworkHandOff']>; result: PeerHandoff }
  'teamwork.handoffs': { params: z.infer<P['teamworkHandoffs']>; result: TeamworkHandoffs }
  'teamwork.take': { params: z.infer<P['teamworkTake']>; result: Worktree }
  'teamwork.dismissHandoff': { params: z.infer<P['teamworkDismissHandoff']>; result: { dismissed: true } }

  'project.templates': { params: z.infer<P['projectTemplates']>; result: TaskTemplateList }
  'project.saveTemplate': { params: z.infer<P['projectSaveTemplate']>; result: TaskTemplate }

  'settings.get': { params: z.infer<P['settingsGet']>; result: RuntimeSettings }
  'settings.set': { params: z.infer<P['settingsSet']>; result: RuntimeSettings }

  'addons.status': { params: z.infer<P['addonsStatus']>; result: AddonStatus[] }
  'addons.install': { params: z.infer<P['addonsInstall']>; result: AddonStatus }
}

/** Workspace stream events for the areas above; each names a collection to re-read. */
export type TaskWorkspaceEvent =
  | { type: 'messages' }
  | { type: 'memory' }
  | { type: 'settings' }
  | { type: 'addons' }
  | { type: 'templates' }
