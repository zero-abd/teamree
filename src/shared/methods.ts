// The method catalogue: the single list of everything the runtime can be asked
// to do. Params and results live here so the runtime, the renderer client, and
// the CLI are all typed from one declaration and cannot drift apart.

import { z } from 'zod'
import type {
  CliInstall,
  CloneProgress,
  CliStatus,
  FileContent,
  FileWritten,
  InstalledAgent,
  Layout,
  MemberList,
  PaneConsent,
  PaneNode,
  PaneWatchers,
  PeerPresence,
  ProcessKill,
  Project,
  RelaySetting,
  RemoteWriteLog,
  RuntimeStatus,
  StartPointList,
  SystemResources,
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
  WorktreeDiscard,
  WorktreeFileMatches,
  WorktreeFiles,
  WorktreeHunkStage,
  WorktreeLog,
  WorktreeMergePreview,
  WorktreePush,
  WorktreeStatus
} from './entities'
import { MAX_AGENT_ARGS_CHARS } from './agentLaunch'
import { MAX_FILE_PANE_BYTES } from './filePane'
import { APPEARANCE_MODES, THEME_TOKENS, type Appearance, type AppearanceMode } from './theme'

/**
 * The most one remote keystroke may carry, counted in bytes at both ends (it was
 * once characters here and bytes at the far end, so a non-ASCII paste passed
 * here and was refused there). Past this a write is not typing and would cost
 * the pane its live output under `relay/README.md`'s per-connection budget;
 * refused outright, never chunked — half a paste in a shell is worse than none.
 */
export const MAX_REMOTE_WRITE_BYTES = 65_536

/**
 * A string capped by bytes: `.max()` counts UTF-16 code units and every wire
 * bound here is bytes — an emoji is one character and four bytes.
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
 * Cap on the pane id a remote keystroke names. Minted ids are `term_12`-sized;
 * the id is copied into the owner's write log on disk, so an unbounded one is a
 * megabyte of somebody else's choosing in the owner's evidence. See
 * `writeLog.ts` and `peerTransport.judgeWrite`, which refuses before the schema.
 */
export const MAX_TERMINAL_ID_CHARS = 256

/** Cap on a pane's name. Generous: what was typed is kept whole and shortened only where drawn. */
export const MAX_PANE_LABEL_CHARS = 512

/** Cap on a worktree's name as `worktree.rename` sets it; drawn shortened, like a pane's. */
export const MAX_WORKTREE_NAME_CHARS = 512

// Defined in `agentLaunch.ts` (importable without zod); re-exported for callers.
export { MAX_AGENT_ARGS_CHARS }

/**
 * Cap on an agent event's qualifier: a notification type copied from the
 * agent's stdin by a CLI that does not check it.
 */
export const MAX_AGENT_EVENT_DETAIL_CHARS = 64

/** Cap on a project's setup command: one shell line, bounded like `MAX_AGENT_ARGS_CHARS`. */
export const MAX_SETUP_COMMAND_CHARS = 4096

/**
 * The most lines one hunk may carry over the wire, so a caller cannot hand the
 * runtime a megabyte of "hunk" to reassemble.
 */
export const MAX_HUNK_LINES = 20_000

/**
 * One hunk of a patch, carried whole rather than by index: git checks it against
 * the index and working tree itself, so a stale one is refused by git. Per-line
 * numbers are deliberately absent; the header carries the two the format needs.
 * A `PatchHunk` from `parsePatch` satisfies this as it stands.
 */
export const Hunk = z.object({
  oldStart: z.number().int().min(0),
  oldCount: z.number().int().min(0),
  newStart: z.number().int().min(0),
  newCount: z.number().int().min(0),
  lines: z
    .array(
      z.object({
        kind: z.enum(['added', 'removed', 'context']),
        text: z.string(),
        /** What `\ No newline at end of file` was said about, said about the line. */
        noNewline: z.boolean().optional()
      })
    )
    .min(1)
    .max(MAX_HUNK_LINES)
})

/** One hunk as it crosses the wire: the shape `Hunk` validates. */
export type HunkInput = z.infer<typeof Hunk>

/** Why `project.add` turned a folder away, carried as `error.data.refusal`. */
export type ProjectAddRefusal = 'not-a-repository' | 'no-commits'

/** One theme slot. Only shape and size are checked; `sanitizeAppearance` drops a value that is not a colour. */
const THEME_CHOICE = z.object({
  themeId: z.string().min(1).max(64),
  ground: z.string().max(32).nullable(),
  accent: z.string().max(32).nullable(),
  overrides: z
    .record(z.string().max(64), z.string().max(32))
    .refine((overrides) => Object.keys(overrides).length <= THEME_TOKENS.length, {
      message: 'more overrides than there are tokens to override'
    })
})

export const Params = {
  statusGet: z.object({}),
  /**
   * Asks the app to quit, as the quit key does. Answered with the pid before
   * teardown; a runtime with no app around it refuses.
   */
  /** `force`: quit even with edited files in the window; they come back as drafts. */
  appQuit: z.object({ force: z.boolean().optional() }),

  projectList: z.object({}),
  /** `init`: a folder that is not a repository gets `git init` and an empty first commit before it is added. */
  projectAdd: z.object({ path: z.string().min(1), name: z.string().min(1).optional(), init: z.boolean().optional() }),
  projectRemove: z.object({ projectId: z.string().min(1) }),
  /**
   * `git clone` and then `project.add`. `path` is absolute or starts with `~`;
   * omitted, it is `~/code/<repo>`. Credentials come from git's own helper, never from here.
   */
  projectClone: z.object({
    url: z.string().trim().min(1).max(4096),
    path: z.string().min(1).max(4096).optional(),
    name: z.string().min(1).optional()
  }),
  projectCloneProgress: z.object({ url: z.string().trim().min(1) }),
  /** Stops the running clone of `url` and removes what it wrote. */
  projectCancelClone: z.object({ url: z.string().trim().min(1) }),
  /**
   * What a new worktree of this project carries from the primary checkout:
   * gitignored directories to symlink, gitignored files to copy. Each list
   * replaces the stored one whole; omitted leaves it alone; empty clears it.
   * Only path shape is judged here (relative, inside the repository, no pathspec
   * magic); existence and ignore status are judged when a worktree is prepared.
   */
  projectSetPaths: z.object({
    projectId: z.string().min(1),
    linkedPaths: z.array(z.string().min(1).max(512)).max(64).optional(),
    copiedPaths: z.array(z.string().min(1).max(512)).max(64).optional(),
    /**
     * Command every new worktree runs once its checkout is ready. Omitted leaves
     * the stored one alone; empty string clears it. Not judged at all: it runs
     * in the developer's own shell.
     */
    setupCommand: z.string().max(MAX_SETUP_COMMAND_CHARS).optional()
  }),

  worktreeList: z.object({ projectId: z.string().min(1).optional() }),
  worktreeGet: z.object({ worktreeId: z.string().min(1) }),
  worktreeCreate: z.object({
    projectId: z.string().min(1),
    name: z.string().min(1),
    /** Ref or sha to branch from. Defaults to the project's baseRef. */
    startedFrom: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    /**
     * What the worktree is for, as typed; see `Worktree.task`. Bounded like
     * `agentArgs`: it goes on the agent's command line.
     */
    task: z.string().min(1).max(MAX_AGENT_ARGS_CHARS).optional()
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
    /** Restricts the list to one path. */
    path: z.string().min(1).optional(),
    limit: z.number().int().positive().optional()
  }),
  /** Commits staged work plus the paths named. Deliberately no "commit everything". */
  worktreeCommit: z.object({
    worktreeId: z.string().min(1),
    message: z.string().min(1),
    /** Stage these before committing. Omitted commits what is already staged. */
    paths: z.array(z.string().min(1)).optional()
  }),
  /** Sends the branch to its remote. Deliberately no force. */
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

  /** Changes the name shown for a worktree; its branch, path and task stay as they are. */
  worktreeRename: z.object({ worktreeId: z.string().min(1), name: z.string().min(1).max(MAX_WORKTREE_NAME_CHARS) }),
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
  /**
   * One directory of a worktree: names and kinds, never contents. `path` is
   * relative to the root and may not leave it; one directory per call, no recursion.
   */
  worktreeFiles: z.object({
    worktreeId: z.string().min(1),
    /** Defaults to the root. */
    path: z.string().max(4096).optional(),
    limit: z.number().int().positive().max(10_000).optional()
  }),
  /** Paths whose name contains `query`, case-insensitively, over what git tracks or would track. */
  worktreeFindFiles: z.object({
    worktreeId: z.string().min(1),
    query: z.string().max(512),
    limit: z.number().int().positive().max(1000).optional()
  }),
  /** Everything a new worktree could branch from, for the create dialog. */
  worktreeStartPoints: z.object({
    projectId: z.string().min(1),
    limit: z.number().int().positive().optional()
  }),

  /**
   * Puts one hunk of the working-tree patch into the index, and nothing else.
   * The hunk is the one read out of `worktree.diff` for this path, handed back
   * as read. Only the index is written, never the working tree. Binary and
   * untracked files have no hunk to name and are refused.
   */
  worktreeStageHunk: z.object({
    worktreeId: z.string().min(1),
    path: z.string().min(1).max(4096),
    hunk: Hunk
  }),
  /** The same in reverse: takes one hunk of the staged patch back out of the index. */
  worktreeUnstageHunk: z.object({
    worktreeId: z.string().min(1),
    path: z.string().min(1).max(4096),
    hunk: Hunk
  }),

  /**
   * Throws away a path's unstaged change. Tracked: back to the staged, else committed,
   * content. Untracked: moved to the Trash. The index is never written.
   */
  worktreeDiscardPath: z.object({
    worktreeId: z.string().min(1),
    path: z.string().min(1).max(4096)
  }),
  /** Reverses one hunk of the unstaged patch out of the file on disk; a staged hunk is refused. */
  worktreeDiscardHunk: z.object({
    worktreeId: z.string().min(1),
    path: z.string().min(1).max(4096),
    hunk: Hunk
  }),

  /** Coding agents found on PATH, so a pane can start one without being told. */
  agentList: z.object({}),

  /** Where this app's CLI is, what is at its link path, and whether a shell would find it. */
  cliStatus: z.object({}),
  /**
   * Puts the CLI on PATH, asking for an administrator password only when needed.
   * Takes nothing: destination `/usr/local/bin/teamree`, source this app's own CLI.
   */
  cliInstall: z.object({}),
  /** Records that the first-run offer has been answered, so it is never made again. */
  cliDismissPrompt: z.object({}),

  /** Which known editors, terminals and Finder are installed: found by bundle id or on PATH, not a setting. */
  editorList: z.object({}),
  /**
   * Opens a path. `command` is a listed entry's `command` (an app's bundle id) or
   * one program name on PATH, never a shell line. Absent, the first editor found.
   */
  editorOpen: z.object({
    path: z.string().min(1),
    command: z.string().min(1).max(512).optional()
  }),

  /**
   * This build, what the download page has, and whether teamree checks. Read
   * from memory, never asks GitHub; includes what an earlier run's check found.
   */
  updateState: z.object({}),
  /** Asks GitHub now. The automatic check's rate limit does not apply: a person asked. */
  updateCheck: z.object({}),
  /** Turns the automatic check on or off. Remembered between runs. */
  updateSetAutomatic: z.object({ automatic: z.boolean() }),
  /**
   * Opens the newer release's download in the browser. Takes no URL: only the
   * release the runtime already holds can be opened, so nobody aims a browser through this app.
   */
  updateDownload: z.object({}),
  /** Fetches the newer release's `.dmg` into ~/Downloads and checks its size and SHA-256. Progress arrives as `updates`. */
  updateFetchInstaller: z.object({}),
  /** Opens the fetched `.dmg`, which mounts it. Takes no path: only the verified file can be opened. */
  updateOpenInstaller: z.object({}),

  /** Everyone whose public key is committed to the project, and who this installation is. */
  membersList: z.object({ projectId: z.string().min(1) }),
  /**
   * Writes this installation's public key into the project's roster. Writes the
   * file and stops: no stage, commit or push. `teamwork.publish` is that
   * separate act, deliberately not a flag on this one.
   */
  membersJoin: z.object({
    projectId: z.string().min(1),
    /** Overrides the handle derived from git's configured email. */
    handle: z.string().min(1).optional()
  }),

  /**
   * Where the project's relay is recorded: the committed file and the
   * per-machine override, and which is in effect.
   */
  teamworkRelay: z.object({ projectId: z.string().min(1) }),
  /**
   * Writes the relay URL to `.teamree/relay` and stops. A non-WebSocket URL is
   * refused with what to type instead.
   */
  teamworkSetRelay: z.object({ projectId: z.string().min(1), url: z.string().min(1) }),

  /**
   * Points this checkout's `origin` at the shared remote: the URL both cloned,
   * or the absolute path a shared volume is mounted at on both Macs. A project's
   * identity is the hash of its normalised origin, so a path is stored
   * normalised; a relative path, `~` or `..` is refused with what to type instead.
   */
  teamworkSetOrigin: z.object({ projectId: z.string().min(1), url: z.string().min(1) }),

  /** What `teamwork.publish` would do, so it can be said before it is done. */
  teamworkPublishPlan: z.object({ projectId: z.string().min(1) }),
  /**
   * Stages exactly the files `teamwork.publishPlan` named, commits, pushes.
   * `git add` with paths, never `-A`; never forces.
   */
  teamworkPublish: z.object({
    projectId: z.string().min(1),
    /** Overrides the message the plan proposed. */
    message: z.string().min(1).optional()
  }),
  /**
   * What the running publish is doing: phase, git's output, when it started and
   * last spoke. `teamwork.publish` itself does not answer until the push is over.
   */
  teamworkPublishProgress: z.object({ projectId: z.string().min(1) }),
  /** Stops the running publish. Whatever was committed stays committed. */
  teamworkCancelPublish: z.object({ projectId: z.string().min(1) }),

  /**
   * Whether teamwork is running for a project and how each link is going.
   * Answers "not configured" as readily as "connected", and `state: 'unread'`
   * for a project teamwork has not read yet (between `project.add` and its
   * reconcile, and during startup); see `TeamworkUnread`. "No such project"
   * therefore means nothing in this workspace has that id.
   */
  teamworkStatus: z.object({ projectId: z.string().min(1) }),
  /**
   * A teammate's worktrees and panes in one project, as last heard. `state:
   * 'unread'` means nothing has been read yet; an empty roster means it was
   * read and holds nobody but you. See `TeammatePresence`.
   */
  teamworkPresence: z.object({ projectId: z.string().min(1) }),
  /**
   * Opens a teammate's pane for reading. `paneId` is the namespaced id
   * `teamwork.presence` hands out; the project is named because there is one
   * link per shared repository. Output flows only while the subscription is held.
   */
  teamworkWatch: z.object({ projectId: z.string().min(1), paneId: z.string().min(1) }),
  /**
   * Types into a teammate's pane over the link already watching it. Crosses the
   * wire as `terminal.write`; resolves to nothing unless the teammate is on the
   * roster with a confirmed session, and the owner refuses it when the pane is
   * muted — a caller must surface the refusal. `data` is capped here and at the
   * far end.
   */
  teamworkType: z.object({
    projectId: z.string().min(1),
    paneId: z.string().min(1),
    data: atMostBytes(MAX_REMOTE_WRITE_BYTES, 1)
  }),
  /**
   * Who is reading and typing into this machine's panes in one project. One
   * shape, not the union: every fact is this machine's own (see `PaneWatchers`).
   * Answers for a project teamwork has not read yet, so a restored window can
   * read its mutes.
   */
  teamworkWatchers: z.object({ projectId: z.string().min(1) }),
  /**
   * Whose keystrokes are waiting on the owner in one project, and which
   * teammates have a standing permission. Invalidated by the `teammates` event.
   * Answers for a project teamwork has not read yet (see `PaneConsent`): a
   * permission the owner cannot see is one they cannot lift.
   */
  teamworkRequests: z.object({ projectId: z.string().min(1) }),
  /**
   * The owner's answer to one held burst. `through` is how many keystrokes the
   * owner was shown; it matters only for `once`, where a burst grows while the
   * prompt is up and anything held past it stays held and asks again. Omitted
   * covers everything waiting — right for a CLI, wrong for a screen.
   */
  teamworkDecide: z.object({
    requestId: z.string().min(1),
    decision: z.enum(['once', 'session', 'always', 'deny']),
    through: z.number().int().positive().optional()
  }),
  /** Takes back a standing permission. The owner's alone; effective from the next keystroke. */
  teamworkRevoke: z.object({ terminalId: z.string().min(1), publicKey: z.string().min(1) }),
  /**
   * Stops or restarts remote keystrokes reaching one of this machine's panes.
   * The owner's alone: no project id, no handle. A muted pane keeps streaming
   * and stays in every sidebar — `docs/teamwork.md`.
   */
  teamworkMute: z.object({ terminalId: z.string().min(1), muted: z.boolean() }),
  /**
   * The owner's record of every remote write their machine decided about,
   * oldest first; local, kept across restarts. Every write the owner's side
   * judges is here whether it landed or not. What the transport refuses first
   * (too large, too fast, unconfirmed session, not a write) is not written, or a
   * caller could fill this file from the far end of a relay: see
   * `tests/security/auditLogErasure.test.ts` and `PEER_WRITE_BURST` in `peerTransport.ts`.
   */
  teamworkWriteLog: z.object({
    /** Trailing entries to return. Defaults to everything retained. */
    limit: z.number().int().positive().optional()
  }),

  /**
   * PEER-ONLY: reachable over the peer transport and nowhere else. This
   * runtime's worktrees, branches, panes and activity — metadata, never output.
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
    /** What to call the pane, for a caller that knows better than the program will. */
    label: z.string().min(1).max(MAX_PANE_LABEL_CHARS).optional(),
    /**
     * Appended to `command` before the runtime rewrites it: the flags this
     * owner always passes this agent, as one command-line fragment (see
     * `src/shared/agentLaunch.ts`). Capped only in length.
     */
    agentArgs: z.string().max(MAX_AGENT_ARGS_CHARS).optional(),
    /**
     * The agent's first prompt, given the way its CLI takes one (see
     * `src/main/terminals/agent-command.ts`). Only the launch carries it, not a
     * resume. Ignored for a command that runs no known agent.
     */
    prompt: z.string().min(1).max(MAX_AGENT_ARGS_CHARS).optional(),
    cwd: z.string().min(1).optional(),
    cols: z.number().int().positive().optional(),
    rows: z.number().int().positive().optional(),
    /** The pane grid as the window draws it, in CSS pixels, so the pane lands where there is room. */
    area: z.object({ width: z.number().positive(), height: z.number().positive() }).optional(),
    /** The least a pane may be given in `area`, chrome included (`MIN_PANE_CELLS`). */
    minPane: z.object({ width: z.number().positive(), height: z.number().positive() }).optional()
  }),
  terminalWrite: z.object({
    terminalId: z.string().min(1).max(MAX_TERMINAL_ID_CHARS),
    // Capped here as well as at the receiving end, in the same unit: this is the
    // frame `teamwork.type` turns into.
    data: atMostBytes(MAX_REMOTE_WRITE_BYTES),
    /**
     * False when the emulator produced these bytes rather than a person: xterm
     * answers a program's queries on the same callback a keystroke arrives on.
     * They belong on the pty but are not typing (`TerminalRecord.typed`). Absent
     * means a person; only the window holding the emulator can tell.
     */
    byHand: z.boolean().optional()
  }),
  terminalResize: z.object({
    terminalId: z.string().min(1),
    cols: z.number().int().positive(),
    rows: z.number().int().positive()
  }),
  terminalClose: z.object({ terminalId: z.string().min(1) }),
  /** Renames a pane. Null clears the name, falling back to the program's own. */
  terminalRename: z.object({
    terminalId: z.string().min(1).max(MAX_TERMINAL_ID_CHARS),
    label: z.string().max(MAX_PANE_LABEL_CHARS).nullable()
  }),
  /** Point-in-time scrollback snapshot; for live output use terminal.subscribe. */
  terminalRead: z.object({
    terminalId: z.string().min(1).max(MAX_TERMINAL_ID_CHARS),
    /** Trailing bytes to return. Defaults to the full retained buffer. */
    tailBytes: z.number().int().positive().optional()
  }),
  terminalSubscribe: z.object({ terminalId: z.string().min(1).max(MAX_TERMINAL_ID_CHARS) }),
  /** Starts an exited pane's program over in the same pane. Refused while still running. */
  terminalRelaunch: z.object({ terminalId: z.string().min(1).max(MAX_TERMINAL_ID_CHARS) }),
  /**
   * The agent in a pane reporting its own state through a hook this app
   * configured (`src/main/terminals/agent-hooks.ts`), via `teamree agent
   * event`: "blocked on a question" leaves no byte in the pty. Event names are
   * the agent's own; `detail` is copied from its stdin and shown nowhere.
   */
  terminalAgentEvent: z.object({
    terminalId: z.string().min(1).max(MAX_TERMINAL_ID_CHARS),
    event: z.enum(['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop', 'SessionEnd']),
    at: z.number().int().nonnegative(),
    detail: z.string().max(MAX_AGENT_EVENT_DETAIL_CHARS).optional()
  }),
  terminalSplit: z.object({
    /** Pane to divide. The new terminal takes half of it. */
    terminalId: z.string().min(1),
    direction: z.enum(['row', 'column']),
    command: z.string().min(1).optional()
  }),

  appearanceGet: z.object({}),
  /**
   * The whole appearance, replaced (the editor moves all of it together). Only
   * shape and size are checked: a value that is not a colour is dropped by
   * `sanitizeAppearance`, so one bad hex costs that colour and nothing else.
   */
  appearanceSet: THEME_CHOICE.extend({
    mode: z.enum(APPEARANCE_MODES as [AppearanceMode, ...AppearanceMode[]]).optional(),
    /** The slot painted while the window is light. */
    light: THEME_CHOICE.optional()
  }),

  /** One text file of a worktree, for a file pane; `path` may not leave the worktree. Local only. */
  fileRead: z.object({
    worktreeId: z.string().min(1),
    path: z.string().min(1).max(4096),
    /** Answer media, binary and oversize files with a `view` rather than refusing them. */
    viewer: z.boolean().optional()
  }),
  fileWrite: z.object({
    worktreeId: z.string().min(1),
    path: z.string().min(1).max(4096),
    content: z.string().max(MAX_FILE_PANE_BYTES),
    encoding: z.enum(['utf-8', 'utf-8-bom']).optional(),
    /** Refuses the write with `conflict` when the file's mtime is no longer this one. */
    expectedModifiedAt: z.number().nonnegative().optional()
  }),

  layoutGet: z.object({ worktreeId: z.string().min(1) }),
  layoutSet: z.object({ worktreeId: z.string().min(1), root: z.unknown(), focusedTerminalId: z.string().nullable() }),

  /** What everything this app spawned is costing, from one `ps` call — see `src/main/resources`. */
  systemResources: z.object({}),
  /**
   * SIGTERM to one process in a pane's tree, or the whole group when the pid is
   * the pane's own child. Refused for any pid not under a pane, from a fresh sample.
   */
  systemKill: z.object({ pid: z.number().int().positive() }),

  workspaceSubscribe: z.object({}),

  unsubscribe: z.object({ subscription: z.string().min(1) })
} as const

/** Maps every method name to its params schema and its result type. */
export type MethodContract = {
  'status.get': { params: z.infer<typeof Params.statusGet>; result: RuntimeStatus }
  /** The reply is sent before teardown, so `quitting` is a promise; the endpoint going is the receipt. */
  'app.quit': { params: z.infer<typeof Params.appQuit>; result: { quitting: true; pid: number } }

  'project.list': { params: z.infer<typeof Params.projectList>; result: Project[] }
  'project.add': { params: z.infer<typeof Params.projectAdd>; result: Project }
  'project.remove': { params: z.infer<typeof Params.projectRemove>; result: { removed: true } }
  'project.clone': { params: z.infer<typeof Params.projectClone>; result: Project }
  /** Null when no clone of that URL is running. */
  'project.cloneProgress': { params: z.infer<typeof Params.projectCloneProgress>; result: CloneProgress | null }
  'project.cancelClone': { params: z.infer<typeof Params.projectCancelClone>; result: { cancelled: boolean } }
  /** Answers with the project as stored, so a caller sees what was kept. */
  'project.setPaths': { params: z.infer<typeof Params.projectSetPaths>; result: Project }

  'worktree.list': { params: z.infer<typeof Params.worktreeList>; result: Worktree[] }
  'worktree.get': { params: z.infer<typeof Params.worktreeGet>; result: Worktree }
  'worktree.create': { params: z.infer<typeof Params.worktreeCreate>; result: Worktree }
  // `checkoutLeftAt`: the row was dropped but the directory was not (git never
  // heard of the checkout, or refused to read it). Last thing that knows where.
  'worktree.remove': {
    params: z.infer<typeof Params.worktreeRemove>
    result: { removed: true; checkoutLeftAt?: string }
  }
  'worktree.status': { params: z.infer<typeof Params.worktreeStatus>; result: WorktreeStatus }
  'worktree.startPoints': { params: z.infer<typeof Params.worktreeStartPoints>; result: StartPointList }
  'worktree.changes': { params: z.infer<typeof Params.worktreeChanges>; result: WorktreeChanges }
  'worktree.diff': { params: z.infer<typeof Params.worktreeDiff>; result: WorktreeDiff }
  'worktree.files': { params: z.infer<typeof Params.worktreeFiles>; result: WorktreeFiles }
  'worktree.findFiles': { params: z.infer<typeof Params.worktreeFindFiles>; result: WorktreeFileMatches }
  'worktree.commit': { params: z.infer<typeof Params.worktreeCommit>; result: WorktreeCommit }
  'worktree.stageHunk': { params: z.infer<typeof Params.worktreeStageHunk>; result: WorktreeHunkStage }
  'worktree.unstageHunk': { params: z.infer<typeof Params.worktreeUnstageHunk>; result: WorktreeHunkStage }
  'worktree.discardPath': { params: z.infer<typeof Params.worktreeDiscardPath>; result: WorktreeDiscard }
  'worktree.discardHunk': { params: z.infer<typeof Params.worktreeDiscardHunk>; result: WorktreeDiscard }
  'worktree.push': { params: z.infer<typeof Params.worktreePush>; result: WorktreePush }
  'worktree.log': { params: z.infer<typeof Params.worktreeLog>; result: WorktreeLog }
  'worktree.mergePreview': {
    params: z.infer<typeof Params.worktreeMergePreview>
    result: WorktreeMergePreview
  }

  'worktree.rename': { params: z.infer<typeof Params.worktreeRename>; result: Worktree }

  'agent.list': { params: z.infer<typeof Params.agentList>; result: InstalledAgent[] }

  'cli.status': { params: z.infer<typeof Params.cliStatus>; result: CliStatus }
  'cli.install': { params: z.infer<typeof Params.cliInstall>; result: CliInstall }
  'cli.dismissPrompt': { params: z.infer<typeof Params.cliDismissPrompt>; result: CliStatus }

  /** What Open in offers, editors first in this app's own order of preference. */
  'editor.list': {
    params: z.infer<typeof Params.editorList>
    result: { editors: { command: string; label: string; kind?: 'editor' | 'terminal' | 'finder' }[] }
  }
  /** A refusal is a result, not an error: a menu item told why can say so. */
  'editor.open': {
    params: z.infer<typeof Params.editorOpen>
    result: { opened: true; editor: string } | { opened: false; reason: string }
  }

  'update.state': { params: z.infer<typeof Params.updateState>; result: UpdateState }
  'update.check': { params: z.infer<typeof Params.updateCheck>; result: UpdateState }
  'update.setAutomatic': { params: z.infer<typeof Params.updateSetAutomatic>; result: UpdateState }
  /** Answers with the address that was opened, so a caller can say what it was. */
  'update.download': { params: z.infer<typeof Params.updateDownload>; result: { opened: string } }
  'update.fetchInstaller': { params: z.infer<typeof Params.updateFetchInstaller>; result: UpdateState }
  'update.openInstaller': { params: z.infer<typeof Params.updateOpenInstaller>; result: { opened: string } }

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
  'terminal.rename': { params: z.infer<typeof Params.terminalRename>; result: Terminal }
  'terminal.read': { params: z.infer<typeof Params.terminalRead>; result: { data: string } }
  'terminal.subscribe': { params: z.infer<typeof Params.terminalSubscribe>; result: { subscription: string } }
  'terminal.split': { params: z.infer<typeof Params.terminalSplit>; result: { terminal: Terminal; layout: Layout } }
  /** The same pane running its program again: same id, leaf, directory; agent started over, not resumed. */
  'terminal.relaunch': { params: z.infer<typeof Params.terminalRelaunch>; result: Terminal }
  /** Answers with the pane, now carrying what its agent just said. */
  'terminal.agentEvent': { params: z.infer<typeof Params.terminalAgentEvent>; result: Terminal }

  /** How this installation is painted. Per machine, not per project. */
  'appearance.get': { params: z.infer<typeof Params.appearanceGet>; result: Appearance }
  'appearance.set': { params: z.infer<typeof Params.appearanceSet>; result: Appearance }

  'file.read': { params: z.infer<typeof Params.fileRead>; result: FileContent }
  'file.write': { params: z.infer<typeof Params.fileWrite>; result: FileWritten }

  'layout.get': { params: z.infer<typeof Params.layoutGet>; result: Layout }
  'layout.set': { params: z.infer<typeof Params.layoutSet>; result: Layout }

  'system.resources': { params: z.infer<typeof Params.systemResources>; result: SystemResources }
  'system.kill': { params: z.infer<typeof Params.systemKill>; result: ProcessKill }

  'workspace.subscribe': { params: z.infer<typeof Params.workspaceSubscribe>; result: { subscription: string } }

  unsubscribe: { params: z.infer<typeof Params.unsubscribe>; result: { unsubscribed: true } }
}

export type MethodName = keyof MethodContract
export type ParamsOf<M extends MethodName> = MethodContract[M]['params']
export type ResultOf<M extends MethodName> = MethodContract[M]['result']

/**
 * Events pushed on a workspace.subscribe subscription: each names a collection
 * that changed and the client refetches it. `layout` and `terminalExited` carry the id.
 */
export type WorkspaceEvent =
  | { type: 'projects' }
  | { type: 'worktrees' }
  | { type: 'terminals' }
  /**
   * A project's roster changed on disk. Carries no project id: events are
   * coalesced by key, and a roster is a cheap directory read.
   */
  | { type: 'members' }
  /** A link to a teammate changed, or what one shows did. No project id, as `members`. */
  | { type: 'teammates' }
  /**
   * The update check ran, finished, or its preference changed. On this stream
   * because the check starts from places the window cannot see (a timer, the
   * macOS app menu). Names no detail: the client re-reads `update.state`.
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
   * The pane rang the bell, at the owner's clock. Reported because everything
   * downstream correctly throws the byte away: it is not text and draws nothing.
   */
  | { type: 'bell'; at: number }

/**
 * Events pushed on a teamwork.watch subscription: everything a local pane says,
 * plus `elided` (bytes the owner produced that outran `relay/README.md`'s
 * per-connection budget, carried as a count so the gap can be drawn) and
 * `lost` (the link went away; a watcher must not see a frozen pane as live).
 */
export type WatchedPaneEvent = TerminalEvent | { type: 'elided'; bytes: number } | { type: 'lost'; reason: string }

/** Convenience re-export so consumers import layout shapes from one place. */
export type { PaneNode, Layout }
