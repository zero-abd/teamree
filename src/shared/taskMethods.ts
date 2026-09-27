// Methods for task trees, messages, project memory, overlaps, usage, handoffs,
// templates, settings and add-ons. Merged into `Params` and `MethodContract` in methods.ts.

import { z } from 'zod'
import { MAX_AGENT_ARGS_CHARS } from './agentLaunch'
import { ADDON_IDS, type AddonId, type AddonStatus } from './contextProvider'
import type { Worktree } from './entities'
import { LedgerParams, type LedgerMethodContract } from './ledgerMethods'
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
import type { WorktreeNest } from './nesting'
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
  /** The asker stopped waiting on these asks, or, resuming, started again. */
  messageWaiting: z.object({ ids: z.array(z.number().int().positive()).min(1).max(2000), waiting: z.boolean() }),

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
  /** Moves a worktree under `parentId`, or to the top level with null. `rebase` replays its commits onto the parent's tip. */
  worktreeNest: z.object({
    worktreeId: Id,
    parentId: Id.nullable(),
    rebase: z.boolean().optional(),
    dryRun: z.boolean().optional(),
    /** The calling pane, as on `worktree.create`: agent calls get the child limits. */
    fromTerminalId: Id.optional()
  }),

  teamworkHandOff: z.object({
    worktreeId: Id,
    to: z.string().min(1).max(160),
    note: z.string().max(MAX_HANDOFF_NOTE_CHARS),
    /** Commits everything uncommitted under this message before the push; omitted leaves it here. */
    commit: z.string().min(1).max(MAX_HANDOFF_NOTE_CHARS).optional(),
    /** Interrupts the worktree's agent panes before the commit, so nothing lands after it. */
    stopAgents: z.boolean().optional()
  }),
  teamworkHandoffs: z.object({ projectId: Id }),
  teamworkTake: z.object({ projectId: Id, id: Id, agent: z.string().min(1).max(64).optional() }),
  teamworkDismissHandoff: z.object({ projectId: Id, id: Id }),
  /** Hand Off's starting note: the task, the ledger's decisions and open questions, the last commits. */
  teamworkHandoffDraft: z.object({ worktreeId: Id }),

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
    showInMenuBar: z.boolean().optional(),
    warnAgentsAboutOverlaps: z.boolean().optional(),
    keepPanesRunning: z.boolean().optional(),
    /** Absolute or `~/`; empty clears it. Refused when not writable or inside a project's repository. */
    worktreesRoot: z.string().max(4096).optional(),
    /** Takes a `worktreesRoot` inside a repository. */
    allowInsideRepository: z.boolean().optional(),
    /** Empty clears it. */
    branchPrefix: z.string().max(64).optional(),
    /** A full path to a program; empty clears it. */
    shell: z.string().max(4096).optional(),
    fetchMinutes: z.number().int().min(1).max(1440).optional()
  }),

  addonsStatus: z.object({}),
  /** Sets the add-on up with the person's own tools; never downloads a binary. */
  addonsInstall: z.object({ id: z.enum(ADDON_IDS as [AddonId, ...AddonId[]]) }),

  ...LedgerParams
} as const

type P = typeof TaskParams

export type TaskMethodContract = LedgerMethodContract & {
  /** One message per recipient: `children` and `siblings` fan out. */
  'message.send': { params: z.infer<P['messageSend']>; result: TaskMessage[] }
  'message.list': { params: z.infer<P['messageList']>; result: TaskMessage[] }
  'message.read': { params: z.infer<P['messageRead']>; result: { read: number } }
  'message.waiting': { params: z.infer<P['messageWaiting']>; result: { changed: number } }

  'project.context': { params: z.infer<P['projectContext']>; result: ProjectContext }
  'memory.note': { params: z.infer<P['memoryNote']>; result: MemoryNote }
  'memory.resolve': { params: z.infer<P['memoryResolve']>; result: MemoryNote }
  'memory.forget': { params: z.infer<P['memoryForget']>; result: { forgotten: true } }
  'memory.conflicts': { params: z.infer<P['memoryConflicts']>; result: MemoryConflict[] }

  'worktree.overlaps': { params: z.infer<P['worktreeOverlaps']>; result: WorktreeOverlaps }
  'worktree.usage': { params: z.infer<P['worktreeUsage']>; result: WorktreeUsage[] }
  'worktree.nest': { params: z.infer<P['worktreeNest']>; result: WorktreeNest }

  'teamwork.handOff': { params: z.infer<P['teamworkHandOff']>; result: PeerHandoff }
  'teamwork.handoffs': { params: z.infer<P['teamworkHandoffs']>; result: TeamworkHandoffs }
  'teamwork.take': { params: z.infer<P['teamworkTake']>; result: Worktree }
  'teamwork.dismissHandoff': { params: z.infer<P['teamworkDismissHandoff']>; result: { dismissed: true } }
  'teamwork.handoffDraft': { params: z.infer<P['teamworkHandoffDraft']>; result: { note: string } }

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
