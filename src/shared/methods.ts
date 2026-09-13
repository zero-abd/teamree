// The method catalogue: the single list of everything the runtime can be asked
// to do. Params and results live here so the runtime, the renderer client, and
// the CLI are all typed from one declaration and cannot drift apart.

import { z } from 'zod'
import type {
  InstalledAgent,
  Layout,
  MemberList,
  PaneNode,
  PaneWatchers,
  PeerPresence,
  Project,
  RelaySetting,
  RuntimeStatus,
  StartPointList,
  TeammatePresence,
  TeamworkStatus,
  Terminal,
  Worktree,
  WorktreeChanges,
  WorktreeCommit,
  WorktreeDiff,
  WorktreeLog,
  WorktreeMergePreview,
  WorktreePush,
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
  /**
   * Commits staged work. Nothing is staged on the caller's behalf beyond the
   * paths named, and there is deliberately no "commit everything".
   */
  worktreeCommit: z.object({
    worktreeId: z.string().min(1),
    message: z.string().min(1),
    /** Stage these before committing. Omitted commits what is already staged. */
    paths: z.array(z.string().min(1)).optional()
  }),
  /**
   * Sends the branch to its remote. There is deliberately no force: the value
   * of one is overwriting somebody else's history.
   */
  worktreePush: z.object({
    worktreeId: z.string().min(1),
    /** Defaults to origin. */
    remote: z.string().min(1).optional()
  }),
  /** The commits this worktree has made that its base does not have. */
  worktreeLog: z.object({
    worktreeId: z.string().min(1),
    limit: z.number().int().positive().optional()
  }),
  /** Whether this worktree would merge into its base, without merging it. */
  worktreeMergePreview: z.object({ worktreeId: z.string().min(1) }),
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

  /** Coding agents found on PATH, so a pane can start one without being told. */
  agentList: z.object({}),

  /**
   * Everyone whose public key is committed to the project, and who this
   * installation is next to them.
   */
  membersList: z.object({ projectId: z.string().min(1) }),
  /**
   * Writes this installation's public key into the project's roster.
   *
   * It writes the file and stops there: it does not stage, commit or push.
   * Getting the file into the repository is the user's, and it has to be,
   * because being able to push it is the whole of what membership means.
   */
  membersJoin: z.object({
    projectId: z.string().min(1),
    /** Overrides the handle derived from git's configured email. */
    handle: z.string().min(1).optional()
  }),

  /**
   * Where the project's relay is recorded, and what each of the two places
   * said — the committed file and the per-machine override, reported whichever
   * one is in effect.
   */
  teamworkRelay: z.object({ projectId: z.string().min(1) }),
  /**
   * Writes the relay URL into the project, at `.teamree/relay`.
   *
   * Like joining, it writes the file and stops: the relay is a team-wide fact,
   * and it becomes the team's when somebody pushes it. A URL that is not a
   * WebSocket one is refused with what to type instead rather than guessed at.
   */
  teamworkSetRelay: z.object({ projectId: z.string().min(1), url: z.string().min(1) }),

  /**
   * Whether teamwork is running for a project, and how each link is going.
   *
   * Answers "not configured" as readily as "connected", because a project with
   * no relay is not offline and must not be shown as though it were.
   */
  teamworkStatus: z.object({ projectId: z.string().min(1) }),
  /** A teammate's worktrees and panes in one project, as last heard. */
  teamworkPresence: z.object({ projectId: z.string().min(1) }),
  /**
   * Opens a teammate's pane for reading. Read-only, and there is no companion
   * method that writes: typing is milestone D.
   *
   * `paneId` is the namespaced id `teamwork.presence` hands out, and the
   * project is named alongside it because one teammate can be reached over one
   * link per shared repository and a pane id alone does not say which.
   *
   * Nothing streams until this is called, and everything stops when the
   * subscription is released: output flows only for a pane somebody has open.
   */
  teamworkWatch: z.object({ projectId: z.string().min(1), paneId: z.string().min(1) }),
  /** Who is reading this machine's panes, right now, in one project. */
  teamworkWatchers: z.object({ projectId: z.string().min(1) }),

  /**
   * PEER-ONLY. Reachable over the peer transport and nowhere else.
   *
   * What this runtime is doing, for a teammate: worktrees, branches, panes and
   * their activity. Metadata, and never a byte of terminal output — that is
   * milestone C, and the seam for it is `PEER_METHODS` in peerTransport.ts.
   */
  peerPresence: z.object({}),
  /** PEER-ONLY. Streams this runtime's presence: once now, and on every change. */
  peerSubscribe: z.object({}),

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
  'worktree.commit': { params: z.infer<typeof Params.worktreeCommit>; result: WorktreeCommit }
  'worktree.push': { params: z.infer<typeof Params.worktreePush>; result: WorktreePush }
  'worktree.log': { params: z.infer<typeof Params.worktreeLog>; result: WorktreeLog }
  'worktree.mergePreview': {
    params: z.infer<typeof Params.worktreeMergePreview>
    result: WorktreeMergePreview
  }

  'agent.list': { params: z.infer<typeof Params.agentList>; result: InstalledAgent[] }

  'members.list': { params: z.infer<typeof Params.membersList>; result: MemberList }
  'members.join': { params: z.infer<typeof Params.membersJoin>; result: MemberList }

  'teamwork.relay': { params: z.infer<typeof Params.teamworkRelay>; result: RelaySetting }
  'teamwork.setRelay': { params: z.infer<typeof Params.teamworkSetRelay>; result: RelaySetting }
  'teamwork.status': { params: z.infer<typeof Params.teamworkStatus>; result: TeamworkStatus }
  'teamwork.presence': { params: z.infer<typeof Params.teamworkPresence>; result: TeammatePresence }
  'teamwork.watch': {
    params: z.infer<typeof Params.teamworkWatch>
    result: {
      subscription: string
      /** The owner's pty size, to letterbox to. Never negotiated by the reader. */
      cols: number
      rows: number
      /** Whose pane it is, so the view is never ambiguous about that. */
      handle: string
    }
  }
  'teamwork.watchers': { params: z.infer<typeof Params.teamworkWatchers>; result: PaneWatchers }

  'peer.presence': { params: z.infer<typeof Params.peerPresence>; result: PeerPresence }
  'peer.subscribe': { params: z.infer<typeof Params.peerSubscribe>; result: { subscription: string } }

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
  /**
   * A project's roster changed on disk. Deliberately carries no project id:
   * events are coalesced by their key, and an id would have to appear in that
   * key for two projects' changes to survive one burst. A roster is a directory
   * read, so re-reading the few a window is showing costs less than the
   * bookkeeping to narrow it.
   */
  | { type: 'members' }
  /**
   * A link to a teammate changed, or what one of them is showing did.
   *
   * Carries no project id for the same reason `members` does not: events are
   * coalesced by their key, and both collections are cheap to re-read for the
   * few projects a window has open.
   */
  | { type: 'teammates' }
  | { type: 'layout'; worktreeId: string }
  | { type: 'terminalExited'; terminalId: string; exitCode: number }

/** Events pushed on a terminal.subscribe subscription. */
export type TerminalEvent =
  | { type: 'data'; data: string }
  | { type: 'exit'; exitCode: number }
  | { type: 'title'; title: string }

/**
 * Events pushed on a teamwork.watch subscription.
 *
 * A teammate's pane says everything a local one does, plus the two things only
 * a reader on the far end of a relay can be told, and both exist because a
 * viewer that quietly showed less than the truth would be a lie:
 *
 * `elided` is output the owner produced and this side will never see, because
 * the pane outran what `relay/README.md` budgets for one connection. It carries
 * the byte count so the gap can be drawn where it happened.
 *
 * `lost` is the link going away underneath the stream. A watcher whose teammate
 * closed their laptop must not be left looking at a frozen pane that appears
 * live.
 */
export type WatchedPaneEvent = TerminalEvent | { type: 'elided'; bytes: number } | { type: 'lost'; reason: string }

/** Convenience re-export so consumers import layout shapes from one place. */
export type { PaneNode, Layout }
