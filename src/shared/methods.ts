// The method catalogue: the single list of everything the runtime can be asked
// to do. Params and results live here so the runtime, the renderer client, and
// the CLI are all typed from one declaration and cannot drift apart.

import { z } from 'zod'
import type {
  CliInstall,
  CliStatus,
  InstalledAgent,
  Layout,
  MemberList,
  PaneConsent,
  PaneNode,
  PaneWatchers,
  PeerPresence,
  Project,
  RelaySetting,
  RemoteWriteLog,
  RuntimeStatus,
  StartPointList,
  TeammatePresence,
  TeamworkOrigin,
  TeamworkPublish,
  TeamworkPublishPlan,
  TeamworkPublishProgress,
  TeamworkStatus,
  Terminal,
  UpdateState,
  Worktree,
  WorktreeChanges,
  WorktreeCommit,
  WorktreeDiff,
  WorktreeLog,
  WorktreeMergePreview,
  WorktreePush,
  WorktreeStatus
} from './entities'
import { THEME_TOKENS, type Appearance } from './theme'

/**
 * The most one remote keystroke may carry.
 *
 * `relay/README.md` gives a connection 200 frames and 4 MiB a second, shared
 * with whatever output that same link is streaming back. Sixty-four kilobytes
 * is a very large paste and a sixteenth of that second; past it, a write is not
 * typing, and carrying it would cost the pane the live output it is being typed
 * into. Refusing outright rather than chunking is deliberate — half a paste
 * landing in somebody's shell is worse than none of it.
 *
 * Counted in bytes everywhere, including here. It used to be characters in the
 * schema and bytes at the far end, which is two caps wearing one name: a paste
 * of this many non-ASCII characters passed the sender's own machine and came
 * back from the teammate's refused as three times the size. The person who
 * pasted was told their teammate would not take it, by a machine that could
 * have told them itself. One unit, and the refusal where the typing is.
 */
export const MAX_REMOTE_WRITE_BYTES = 65_536

/**
 * A string field capped by what it weighs rather than by how long it reads.
 *
 * `.max()` counts UTF-16 code units, and every bound in this file that a wire
 * has to honour is a bound on bytes. The two agree for ASCII and disagree by up
 * to three times for everything else, which is the whole of the bug this
 * replaces: an emoji is one character and four bytes.
 */
function atMostBytes(bytes: number, minimum = 0) {
  return z
    .string()
    .min(minimum)
    .refine((text) => utf8Length(text) <= bytes, { message: `must be at most ${bytes} bytes` })
}

/** How many bytes this string is once encoded, without allocating the encoding. */
function utf8Length(text: string): number {
  let bytes = 0
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}

/**
 * The most a pane id a remote keystroke names may be.
 *
 * Every id this runtime mints is a short word and a counter — `term_12` — so
 * this is three orders of magnitude of headroom and refuses nothing anybody
 * types. It is here because `data` was capped and the id beside it was not, and
 * the id is copied further than the data ever goes: into the owner's write log,
 * onto their disk, and into the map that remembers who typed where. An
 * unbounded id is therefore a megabyte of somebody else's choosing in a file
 * that is supposed to be the owner's evidence — see `writeLog.ts`, which bounds
 * the entry as well, and `peerTransport.judgeWrite`, which refuses past this
 * before the schema is ever reached.
 */
export const MAX_TERMINAL_ID_CHARS = 256

export const Params = {
  statusGet: z.object({}),

  projectList: z.object({}),
  projectAdd: z.object({ path: z.string().min(1), name: z.string().min(1).optional() }),
  projectRemove: z.object({ projectId: z.string().min(1) }),
  /**
   * What a new worktree of this project carries over from the primary
   * checkout: gitignored directories to symlink, gitignored files to copy.
   *
   * Each list replaces the stored one whole, and an omitted list is left
   * alone — the same shape `appearance.set` uses, and for the same reason: two
   * fields that move independently, each of which somebody edits as a whole.
   * An empty array is how a list is cleared.
   *
   * Only the shape of each path is judged here and at the moment it is stored:
   * relative, inside the repository, and not pathspec magic. Whether it exists,
   * is ignored, and is untracked is a fact about the repository right now, so
   * it is judged when a worktree is actually being prepared.
   */
  projectSetPaths: z.object({
    projectId: z.string().min(1),
    linkedPaths: z.array(z.string().min(1).max(512)).max(64).optional(),
    copiedPaths: z.array(z.string().min(1).max(512)).max(64).optional()
  }),

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
   * Where this app's CLI is, what is at the path it would be linked to, and
   * whether that path is somewhere a shell would find it.
   */
  cliStatus: z.object({}),
  /**
   * Puts the CLI on PATH, asking for an administrator password only when the
   * destination directory cannot be written without one.
   *
   * Takes nothing: the destination is `/usr/local/bin/teamree` and the source
   * is this app's own CLI, so there is no argument that could be got wrong and
   * no way for a caller to aim the link somewhere else.
   */
  cliInstall: z.object({}),
  /**
   * Records that this installation has now been asked, so the offer made on
   * first run is made once and never again. Declining is an answer.
   */
  cliDismissPrompt: z.object({}),

  /**
   * What this build is, what the download page has, and whether teamree looks.
   *
   * A read out of memory: it never asks GitHub anything. The answer includes
   * whatever the last check found, including a check made in an earlier run.
   */
  updateState: z.object({}),
  /**
   * Asks GitHub now, because somebody chose to.
   *
   * The rate limit that governs the automatic check does not apply here: it
   * exists to stop the app asking on its own account, and a person who has just
   * picked "Check for updates" is owed an answer rather than a cached one.
   */
  updateCheck: z.object({}),
  /** Turns the automatic check on or off. Remembered between runs. */
  updateSetAutomatic: z.object({ automatic: z.boolean() }),
  /**
   * Opens the newer release's download in the user's browser.
   *
   * Takes no URL, and that is the point: the address came off the GitHub API,
   * so the only thing this can open is the release the runtime is already
   * holding. A call that named a page would be a way to aim somebody's browser
   * through this app.
   */
  updateDownload: z.object({}),

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
   * `teamwork.publish` is that second act, on its own button, after it has said
   * what it will do — deliberately a separate call and not a flag on this one.
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
   * Points this checkout's `origin` at the remote everybody shares.
   *
   * The one piece of setup that used to be a shell command in a panel. It is
   * here rather than left to the user because the identity of a project is the
   * hash of its normalised origin, so a checkout without one cannot take part
   * however much of the rest is done — and `git remote add origin <url>` typed
   * into the wrong directory is a thing that happens.
   *
   * Either the URL you both cloned or the absolute path a shared volume is
   * mounted at on both Macs. A path is stored normalised, because those are the
   * characters a teammate has to match: nothing on either machine can tell that
   * one volume mounted at two paths is one repository, so the paths agreeing is
   * the identity. Anything that could not be agreed on — a relative path, a `~`,
   * a `..` — is refused with what to type instead.
   */
  teamworkSetOrigin: z.object({ projectId: z.string().min(1), url: z.string().min(1) }),

  /**
   * What `teamwork.publish` would do, so it can be said before it is done.
   *
   * Read separately from the act because the act is outward-facing: it makes a
   * commit in somebody's repository and sends it to a remote, and a button that
   * did that without first naming the files, the message, the remote and the
   * branch would be taking a decision on their behalf.
   */
  teamworkPublishPlan: z.object({ projectId: z.string().min(1) }),
  /**
   * Stages the two files teamwork needs, commits them, and pushes.
   *
   * Exactly the files `teamwork.publishPlan` named and nothing else: it is
   * `git add` with paths, never `git add -A`, so a repository full of somebody's
   * work in progress cannot be swept into a commit they did not ask for. It
   * never forces, for the same reason `worktree.push` does not.
   */
  teamworkPublish: z.object({
    projectId: z.string().min(1),
    /** Overrides the message the plan proposed. */
    message: z.string().min(1).optional()
  }),
  /**
   * What the publish that is running is doing, while it is still doing it.
   *
   * `teamwork.publish` does not answer until the push is over, which for the
   * one call here that crosses a network can be minutes — so without a second
   * question to ask, a window has nothing to show between the button and the
   * result. This is that question: the phase, what git has printed, when it
   * started and when it last said anything.
   */
  teamworkPublishProgress: z.object({ projectId: z.string().min(1) }),
  /**
   * Stops the publish that is running.
   *
   * A way out is not a nicety on a call that can wait ten minutes on a
   * credential nothing can supply. Whatever was committed stays committed;
   * `teamwork.publish` reports it.
   */
  teamworkCancelPublish: z.object({ projectId: z.string().min(1) }),

  /**
   * Whether teamwork is running for a project, and how each link is going.
   *
   * Answers "not configured" as readily as "connected", because a project with
   * no relay is not offline and must not be shown as though it were. And it
   * answers `state: 'unread'` as readily as either, for a project the workspace
   * has that teamwork has not read yet — the window between `project.add` and
   * the reconcile it sets off, and the whole of startup before the peer service
   * is up. An error there would say "no such project" about a project that is
   * on screen; see `TeamworkUnread`.
   *
   * "No such project" therefore means what it says: nothing in this workspace
   * has that id.
   */
  teamworkStatus: z.object({ projectId: z.string().min(1) }),
  /**
   * A teammate's worktrees and panes in one project, as last heard.
   *
   * A union on the same window and for the same reason as `teamwork.status`,
   * because the roster is the other half of the same reconcile. `state:
   * 'unread'` says the project exists and nothing has been read about it; an
   * empty roster would say the repository was read and holds nobody but you,
   * which is a different sentence and the one that empties a sidebar. See
   * `TeammatePresence`.
   */
  teamworkPresence: z.object({ projectId: z.string().min(1) }),
  /**
   * Opens a teammate's pane for reading.
   *
   * `paneId` is the namespaced id `teamwork.presence` hands out, and the
   * project is named alongside it because one teammate can be reached over one
   * link per shared repository and a pane id alone does not say which.
   *
   * Nothing streams until this is called, and everything stops when the
   * subscription is released: output flows only for a pane somebody has open.
   */
  teamworkWatch: z.object({ projectId: z.string().min(1), paneId: z.string().min(1) }),
  /**
   * Types into a teammate's pane, over the link that is already watching it.
   *
   * The companion to `teamwork.watch`, and the reason milestone D needed the
   * most care: what crosses the wire under this is `terminal.write`, answered
   * by the owner's own terminal service. It resolves to nothing unless that
   * teammate is on this project's roster and their session is confirmed, and
   * the owner's end refuses it outright when the pane is muted — so a caller
   * has to be ready to be told no, and has to say so rather than swallow it.
   *
   * `data` is capped here as well as at the far end. Keystrokes are small and a
   * paste is not, and one write large enough to spend a connection's whole
   * second of relay budget would cost the pane its live output to carry it.
   */
  teamworkType: z.object({
    projectId: z.string().min(1),
    paneId: z.string().min(1),
    data: atMostBytes(MAX_REMOTE_WRITE_BYTES, 1)
  }),
  /**
   * Who is reading and typing into this machine's panes, right now, in one
   * project.
   *
   * One shape rather than the union above, because every fact in it is this
   * machine's own and none of it waits on a reconcile — the argument is written
   * out on `PaneWatchers`. It answers for a project teamwork has not read yet
   * rather than refusing one, which is what lets a restored window read the
   * mutes on panes it is already drawing.
   */
  teamworkWatchers: z.object({ projectId: z.string().min(1) }),
  /**
   * Whose keystrokes are waiting on the owner in one project, and which
   * teammates already have a standing permission there.
   *
   * Read on the same invalidation everything else in teamwork is: a request
   * appearing, growing, being answered or expiring all move the same
   * `teammates` event, because the window that has to put the question on
   * screen is the window that is already listening for it.
   *
   * Answers for a project teamwork has not read yet, on `teamwork.watchers`'
   * argument: see `PaneConsent`. A permission the owner cannot see is a
   * permission they cannot lift, and refusing the project outright was the most
   * complete way to hide one.
   */
  teamworkRequests: z.object({ projectId: z.string().min(1) }),
  /**
   * The owner's answer to one held burst.
   *
   * `through` is how many of the burst's keystrokes the owner was actually
   * shown. It matters only for `once`, and it matters there absolutely: a burst
   * grows while the prompt is up, so a decision taken about four keystrokes
   * must not admit the fourteen that are held by the time the click lands. The
   * window sends the count it drew; anything still held after that stays held
   * and asks again. Omitted, the answer covers everything waiting — which is
   * the right default for a CLI, where the list was printed and answered in one
   * breath, and the wrong one for a screen somebody is reading.
   */
  teamworkDecide: z.object({
    requestId: z.string().min(1),
    decision: z.enum(['once', 'session', 'always', 'deny']),
    through: z.number().int().positive().optional()
  }),
  /**
   * Takes back a standing permission.
   *
   * The owner's alone, like the mute, and for the same reason: a permission
   * that needed the other side's agreement to end would not be a permission,
   * it would be a contract. It takes effect on the next keystroke, which is
   * every keystroke that has not already been written.
   */
  teamworkRevoke: z.object({ terminalId: z.string().min(1), publicKey: z.string().min(1) }),
  /**
   * Stops, or restarts, remote keystrokes reaching one of *this machine's*
   * panes.
   *
   * The owner's alone: there is no project id because there is nobody to agree
   * with and nothing to negotiate, and no handle because a mute is of a pane
   * rather than of a person. A muted pane keeps streaming and keeps appearing
   * in everyone's sidebar — `docs/teamwork.md` is explicit that mute stops the
   * bytes and does not hide the worktree.
   */
  teamworkMute: z.object({ terminalId: z.string().min(1), muted: z.boolean() }),
  /**
   * The owner's record of every remote write their machine made a decision
   * about, oldest first.
   *
   * Local, on their machine, and readable after the fact — including after a
   * restart, which is what makes it a record rather than a display.
   *
   * "Made a decision about" and not "every write that arrived", because the two
   * are different and the difference is deliberate. Everything the *owner's*
   * side judges is here whether it landed or not — not a member, no such pane,
   * the pane has exited, the pane is muted — because those are bounded by the
   * owner's own state and each one is a thing somebody may need to account for
   * later.
   *
   * What the transport refuses before that — a write larger than one keystroke
   * may carry, one arriving faster than a person types, one on an unconfirmed
   * session, one that is not a write at all — is answered to the teammate and
   * not written here. A caller chooses how many of those to send and how large
   * each is, so recording them is a way of filling this file from the other end
   * of a relay, which is the one thing it must survive: see
   * `tests/security/auditLogErasure.test.ts`, and the note on `PEER_WRITE_BURST`
   * in `peerTransport.ts`. A count of them belongs somewhere; a line each does
   * not.
   */
  teamworkWriteLog: z.object({
    /** Trailing entries to return. Defaults to everything retained. */
    limit: z.number().int().positive().optional()
  }),

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
  terminalWrite: z.object({
    terminalId: z.string().min(1).max(MAX_TERMINAL_ID_CHARS),
    // Capped here as well as at the receiving end, and in the same unit. This
    // is the frame `teamwork.type` turns into, so a paste that is too large for
    // the wire is refused on the machine it was pasted on.
    data: atMostBytes(MAX_REMOTE_WRITE_BYTES)
  }),
  terminalResize: z.object({
    terminalId: z.string().min(1),
    cols: z.number().int().positive(),
    rows: z.number().int().positive()
  }),
  terminalClose: z.object({ terminalId: z.string().min(1) }),
  /** Point-in-time scrollback snapshot; for live output use terminal.subscribe. */
  terminalRead: z.object({
    terminalId: z.string().min(1).max(MAX_TERMINAL_ID_CHARS),
    /** Trailing bytes to return. Defaults to the full retained buffer. */
    tailBytes: z.number().int().positive().optional()
  }),
  terminalSubscribe: z.object({ terminalId: z.string().min(1).max(MAX_TERMINAL_ID_CHARS) }),
  terminalSplit: z.object({
    /** Pane to divide. The new terminal takes half of it. */
    terminalId: z.string().min(1),
    direction: z.enum(['row', 'column']),
    command: z.string().min(1).optional()
  }),

  appearanceGet: z.object({}),
  /**
   * The whole appearance, replaced.
   *
   * Replaced rather than patched because that is what the editor has in its
   * hand: a preset, two choices and a bag of edits, all of which move together
   * when somebody presses a swatch. The schema only checks shape and size — a
   * value that is not a colour is dropped by `sanitizeAppearance` on the way in
   * rather than refused here, because a stored theme with one bad hex in it
   * should cost that colour and nothing else.
   */
  appearanceSet: z.object({
    themeId: z.string().min(1).max(64),
    ground: z.string().max(32).nullable(),
    accent: z.string().max(32).nullable(),
    overrides: z
      .record(z.string().max(64), z.string().max(32))
      .refine((overrides) => Object.keys(overrides).length <= THEME_TOKENS.length, {
        message: 'more overrides than there are tokens to override'
      })
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
  /** Answers with the project as stored, so a caller sees what was kept. */
  'project.setPaths': { params: z.infer<typeof Params.projectSetPaths>; result: Project }

  'worktree.list': { params: z.infer<typeof Params.worktreeList>; result: Worktree[] }
  'worktree.get': { params: z.infer<typeof Params.worktreeGet>; result: Worktree }
  'worktree.create': { params: z.infer<typeof Params.worktreeCreate>; result: Worktree }
  // `checkoutLeftAt` is set when the row was dropped but the directory was
  // not: git had never heard of the checkout, or refused to read it. The files
  // are all still there, and this is the last thing that knows where.
  'worktree.remove': {
    params: z.infer<typeof Params.worktreeRemove>
    result: { removed: true; checkoutLeftAt?: string }
  }
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

  'cli.status': { params: z.infer<typeof Params.cliStatus>; result: CliStatus }
  'cli.install': { params: z.infer<typeof Params.cliInstall>; result: CliInstall }
  'cli.dismissPrompt': { params: z.infer<typeof Params.cliDismissPrompt>; result: CliStatus }

  'update.state': { params: z.infer<typeof Params.updateState>; result: UpdateState }
  'update.check': { params: z.infer<typeof Params.updateCheck>; result: UpdateState }
  'update.setAutomatic': { params: z.infer<typeof Params.updateSetAutomatic>; result: UpdateState }
  /** Answers with the address that was opened, so a caller can say what it was. */
  'update.download': { params: z.infer<typeof Params.updateDownload>; result: { opened: string } }

  'members.list': { params: z.infer<typeof Params.membersList>; result: MemberList }
  'members.join': { params: z.infer<typeof Params.membersJoin>; result: MemberList }

  'teamwork.relay': { params: z.infer<typeof Params.teamworkRelay>; result: RelaySetting }
  'teamwork.setRelay': { params: z.infer<typeof Params.teamworkSetRelay>; result: RelaySetting }
  'teamwork.setOrigin': { params: z.infer<typeof Params.teamworkSetOrigin>; result: TeamworkOrigin }
  'teamwork.publishPlan': { params: z.infer<typeof Params.teamworkPublishPlan>; result: TeamworkPublishPlan }
  'teamwork.publish': { params: z.infer<typeof Params.teamworkPublish>; result: TeamworkPublish }
  'teamwork.publishProgress': {
    params: z.infer<typeof Params.teamworkPublishProgress>
    /** Null when this project has never had a publish in this run of the app. */
    result: TeamworkPublishProgress | null
  }
  'teamwork.cancelPublish': {
    params: z.infer<typeof Params.teamworkCancelPublish>
    /** False when there was nothing running to stop. */
    result: { cancelled: boolean }
  }
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
  'teamwork.type': { params: z.infer<typeof Params.teamworkType>; result: { written: true } }
  'teamwork.watchers': { params: z.infer<typeof Params.teamworkWatchers>; result: PaneWatchers }
  'teamwork.requests': { params: z.infer<typeof Params.teamworkRequests>; result: PaneConsent }
  /** Answers with the pane's project, so the caller sees the queue it just shortened. */
  'teamwork.decide': { params: z.infer<typeof Params.teamworkDecide>; result: PaneConsent }
  'teamwork.revoke': { params: z.infer<typeof Params.teamworkRevoke>; result: PaneConsent }
  /** Answers with the pane's project, so the caller sees the mute it just set. */
  'teamwork.mute': { params: z.infer<typeof Params.teamworkMute>; result: PaneWatchers }
  'teamwork.writeLog': { params: z.infer<typeof Params.teamworkWriteLog>; result: RemoteWriteLog }

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

  /** How this installation is painted. Per machine, not per project. */
  'appearance.get': { params: z.infer<typeof Params.appearanceGet>; result: Appearance }
  'appearance.set': { params: z.infer<typeof Params.appearanceSet>; result: Appearance }

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
  /**
   * The update check has something new to say: it ran, it finished, or the
   * preference changed.
   *
   * On this stream rather than on one of its own because the check is started
   * from places the window cannot see — a timer half a minute after launch, and
   * the macOS app menu, which lives in the main process — and this is already
   * the channel by which a window hears about work it did not do. Like every
   * other event here it names no detail: the client re-reads `update.state`.
   */
  | { type: 'updates' }
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
