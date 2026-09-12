// The method catalogue: the single list of everything the runtime can be asked
// to do. Params and results live here so the runtime, the renderer client, and
// the CLI are all typed from one declaration and cannot drift apart.

import { z } from 'zod'
import type {
  Layout,
  PaneNode,
  Project,
  RuntimeStatus,
  StartPointList,
  Terminal,
  Worktree,
  WorktreeChanges,
  WorktreeDiff,
  WorktreeStatus
} from './entities'

export const Params = {
  statusGet: z.object({}),

  projectList: z.object({}),
  projectAdd: z.object({ path: z.string().min(1), name: z.string().min(1).optional() }),
  projectRemove: z.object({ projectId: z.string().min(1) }),

  worktreeList: z.object({ projectId: z.string().min(1).optional() }),
  worktreeGet: z.object({ worktreeId: z.string().min(1) }),
  worktreeCreate: z.object({
    projectId: z.string().min(1),
    name: z.string().min(1),
    /** Ref or sha to branch from. Defaults to the project's baseRef. */
    startedFrom: z.string().min(1).optional(),
    branch: z.string().min(1).optional()
  }),
  worktreeRemove: z.object({
    worktreeId: z.string().min(1),
    /** Remove even with uncommitted changes or unmerged commits. */
    force: z.boolean().optional(),
    /** Delete the branch alongside the checkout. */
    deleteBranch: z.boolean().optional()
  }),
  worktreeStatus: z.object({ worktreeId: z.string().min(1) }),
  /** Every changed path, for a review pass before committing. */
  worktreeChanges: z.object({
    worktreeId: z.string().min(1),
    limit: z.number().int().positive().optional()
  }),
  /** The patch itself: the whole worktree, or one path in it. */
  worktreeDiff: z.object({
    worktreeId: z.string().min(1),
    /** Restricts the patch to one path. Defaults to the whole worktree. */
    path: z.string().min(1).optional(),
    /** Diff the index against HEAD instead of the working tree. */
    staged: z.boolean().optional(),
    contextLines: z.number().int().min(0).max(100).optional(),
    /** Ceiling on the patch returned, so one huge file cannot flood a caller. */
    maxBytes: z.number().int().positive().optional()
  }),
  /** Everything a new worktree could branch from, for the create dialog. */
  worktreeStartPoints: z.object({
    projectId: z.string().min(1),
    limit: z.number().int().positive().optional()
  }),

  terminalList: z.object({ worktreeId: z.string().min(1).optional() }),
  terminalCreate: z.object({
    worktreeId: z.string().min(1),
    /** Defaults to the user's login shell. */
    shell: z.string().min(1).optional(),
    /** Run this instead of an interactive shell. */
    command: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    cols: z.number().int().positive().optional(),
    rows: z.number().int().positive().optional()
  }),
  terminalWrite: z.object({ terminalId: z.string().min(1), data: z.string() }),
  terminalResize: z.object({
    terminalId: z.string().min(1),
    cols: z.number().int().positive(),
    rows: z.number().int().positive()
  }),
  terminalClose: z.object({ terminalId: z.string().min(1) }),
  /** Point-in-time scrollback snapshot; for live output use terminal.subscribe. */
  terminalRead: z.object({
    terminalId: z.string().min(1),
    /** Trailing bytes to return. Defaults to the full retained buffer. */
    tailBytes: z.number().int().positive().optional()
  }),
  terminalSubscribe: z.object({ terminalId: z.string().min(1) }),
  terminalSplit: z.object({
    /** Pane to divide. The new terminal takes half of it. */
    terminalId: z.string().min(1),
    direction: z.enum(['row', 'column']),
    command: z.string().min(1).optional()
  }),

  layoutGet: z.object({ worktreeId: z.string().min(1) }),
  layoutSet: z.object({ worktreeId: z.string().min(1), root: z.unknown(), focusedTerminalId: z.string().nullable() }),

  /**
   * Streams coarse invalidations for everything the workspace owns. Deliberately
   * coarse: the client refetches the affected collection rather than applying a
   * patch, which removes a whole class of state-divergence bugs and costs one
   * small request per change. This is what lets a GUI reflect work a CLI did.
   */
  workspaceSubscribe: z.object({}),

  unsubscribe: z.object({ subscription: z.string().min(1) })
} as const

/** Maps every method name to its params schema and its result type. */
export type MethodContract = {
  'status.get': { params: z.infer<typeof Params.statusGet>; result: RuntimeStatus }

  'project.list': { params: z.infer<typeof Params.projectList>; result: Project[] }
  'project.add': { params: z.infer<typeof Params.projectAdd>; result: Project }
  'project.remove': { params: z.infer<typeof Params.projectRemove>; result: { removed: true } }

  'worktree.list': { params: z.infer<typeof Params.worktreeList>; result: Worktree[] }
  'worktree.get': { params: z.infer<typeof Params.worktreeGet>; result: Worktree }
  'worktree.create': { params: z.infer<typeof Params.worktreeCreate>; result: Worktree }
  'worktree.remove': { params: z.infer<typeof Params.worktreeRemove>; result: { removed: true } }
  'worktree.status': { params: z.infer<typeof Params.worktreeStatus>; result: WorktreeStatus }
  'worktree.startPoints': { params: z.infer<typeof Params.worktreeStartPoints>; result: StartPointList }
  'worktree.changes': { params: z.infer<typeof Params.worktreeChanges>; result: WorktreeChanges }
  'worktree.diff': { params: z.infer<typeof Params.worktreeDiff>; result: WorktreeDiff }

  'terminal.list': { params: z.infer<typeof Params.terminalList>; result: Terminal[] }
  'terminal.create': { params: z.infer<typeof Params.terminalCreate>; result: Terminal }
  'terminal.write': { params: z.infer<typeof Params.terminalWrite>; result: { written: true } }
  'terminal.resize': { params: z.infer<typeof Params.terminalResize>; result: Terminal }
  'terminal.close': { params: z.infer<typeof Params.terminalClose>; result: { closed: true } }
  'terminal.read': { params: z.infer<typeof Params.terminalRead>; result: { data: string } }
  'terminal.subscribe': { params: z.infer<typeof Params.terminalSubscribe>; result: { subscription: string } }
  'terminal.split': { params: z.infer<typeof Params.terminalSplit>; result: { terminal: Terminal; layout: Layout } }

  'layout.get': { params: z.infer<typeof Params.layoutGet>; result: Layout }
  'layout.set': { params: z.infer<typeof Params.layoutSet>; result: Layout }

  'workspace.subscribe': { params: z.infer<typeof Params.workspaceSubscribe>; result: { subscription: string } }

  unsubscribe: { params: z.infer<typeof Params.unsubscribe>; result: { unsubscribed: true } }
}

export type MethodName = keyof MethodContract
export type ParamsOf<M extends MethodName> = MethodContract[M]['params']
export type ResultOf<M extends MethodName> = MethodContract[M]['result']

/**
 * Events pushed on a workspace.subscribe subscription. Each names a collection
 * that changed; the client refetches it. `layout` and `terminalExited` carry the
 * id that changed so a client can skip work it does not care about.
 */
export type WorkspaceEvent =
  | { type: 'projects' }
  | { type: 'worktrees' }
  | { type: 'terminals' }
  | { type: 'layout'; worktreeId: string }
  | { type: 'terminalExited'; terminalId: string; exitCode: number }

/** Events pushed on a terminal.subscribe subscription. */
export type TerminalEvent =
  | { type: 'data'; data: string }
  | { type: 'exit'; exitCode: number }
  | { type: 'title'; title: string }

/** Convenience re-export so consumers import layout shapes from one place. */
export type { PaneNode, Layout }
