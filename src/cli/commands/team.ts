// Teamwork from a shell.
//
// The GUI could see the roster, the relay, who was connected and what a
// teammate's pane was printing; the CLI could see none of it, which made the
// whole feature human-only by accident. An agent working beside a person on a
// shared project has the same questions they do — is this on, who is here, what
// is that pane doing — and until now it had no way to ask them.
//
// Two deliberate absences are documented at the bottom of this file rather than
// implemented badly: there is no `layout set`, and there is no command that
// reads a teammate's pane without naming whose it is.

import type { PeerPane, TeammatePresence, TeammateWorktree } from '../../shared/entities.js'
import { MAX_REMOTE_WRITE_BYTES, type WatchedPaneEvent } from '../../shared/methods.js'
import { readBoolean, readNumber, readString, requireString } from '../argv.js'
import type { CommandContext, CommandSpec } from '../command-spec.js'
import { CliError, ExitCode, UsageError } from '../exit.js'
import { formatFields, formatTable } from '../output.js'
import { resolveProject } from '../selectors.js'
import type { RuntimeClient } from '../transport.js'

/** Every team command names its project the same way, so say it once. */
const PROJECT_ARG = {
  name: 'project',
  description: 'Project id, name, or path.',
  required: true
} as const

const TEAMMATE_ARG = {
  name: 'teammate',
  description: 'Teammate handle from `teamree team status`, or a public key prefix.',
  required: true
} as const

const PANE_FLAG = {
  name: 'pane',
  kind: 'string',
  placeholder: '<pane>',
  description: "Which of their panes: the pane id, or the owner's terminal id. Required when they have several."
} as const

/** Compact age, so a table column of them stays readable. */
function ago(at: number | null, now: number): string {
  if (at === null) return 'never'
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function shortKey(publicKey: string): string {
  return publicKey.slice(0, 12)
}

/**
 * Tiered matching with the same discipline as `selectors.ts`: a tier that
 * matches more than one teammate is an error rather than a coin flip.
 */
function selectTeammate(
  presence: TeammatePresence,
  token: string
): { handle: string; publicKey: string; connected: boolean; heardAt: number | null } {
  const lower = token.toLowerCase()
  const people = presence.teammates
  const tiers: ReadonlyArray<[string, (person: (typeof people)[number]) => boolean]> = [
    ['handle', (person) => person.handle === token],
    ['handle', (person) => person.handle.toLowerCase() === lower],
    ['key', (person) => person.publicKey === token],
    ['key prefix', (person) => person.publicKey.startsWith(token)]
  ]

  for (const [tier, predicate] of tiers) {
    const matches = people.filter(predicate)
    if (matches.length === 1) return matches[0] as (typeof people)[number]
    if (matches.length > 1) {
      throw new CliError({
        code: 'ambiguous_selector',
        message: `"${token}" matches ${matches.length} teammates by ${tier}. Use a public key instead.`,
        exitCode: ExitCode.Failure,
        data: { matches: matches.map((person) => ({ handle: person.handle, publicKey: person.publicKey })) }
      })
    }
  }

  throw new CliError({
    code: 'not_found',
    message: `No teammate matches "${token}" on this project's roster.`,
    exitCode: ExitCode.Failure,
    hint:
      people.length === 0
        ? 'This roster has nobody else on it yet. Run `teamree team members <project>` to see it.'
        : `On this roster: ${people.map((person) => person.handle).join(', ')}.`,
    data: { known: people.map((person) => ({ handle: person.handle, publicKey: person.publicKey })) }
  })
}

type PaneCandidate = {
  handle: string
  publicKey: string
  live: boolean
  worktree: { id: string; name: string; branch: string }
  pane: PeerPane
}

function panesOf(presence: TeammatePresence, publicKey: string): PaneCandidate[] {
  const mine = presence.worktrees.filter((worktree: TeammateWorktree) => worktree.publicKey === publicKey)
  return mine.flatMap((worktree) =>
    worktree.panes.map((pane) => ({
      handle: worktree.handle,
      publicKey: worktree.publicKey,
      live: worktree.live,
      worktree: { id: worktree.id, name: worktree.name, branch: worktree.branch },
      pane
    }))
  )
}

function describePane(candidate: PaneCandidate): Record<string, unknown> {
  return {
    paneId: candidate.pane.id,
    title: candidate.pane.title,
    worktree: candidate.worktree.name,
    running: candidate.pane.running,
    busy: candidate.pane.busy,
    live: candidate.live
  }
}

/**
 * Picks the pane to act on. With one pane there is nothing to choose; with
 * several there is, and guessing at somebody else's shell is exactly the guess
 * not to make.
 */
function selectPane(candidates: readonly PaneCandidate[], handle: string, token: string | undefined): PaneCandidate {
  if (candidates.length === 0) {
    throw new CliError({
      code: 'not_found',
      message: `${handle} has no panes this machine has heard about.`,
      exitCode: ExitCode.Failure,
      hint: 'Panes appear once their machine is connected and has sent presence.'
    })
  }

  if (token === undefined) {
    if (candidates.length === 1) return candidates[0] as PaneCandidate
    throw new CliError({
      code: 'ambiguous_pane',
      message: `${handle} has ${candidates.length} panes. Name one with --pane.`,
      exitCode: ExitCode.Failure,
      hint: `Panes: ${candidates.map((candidate) => `${candidate.pane.id} (${candidate.pane.title})`).join(', ')}.`,
      data: { panes: candidates.map(describePane) }
    })
  }

  const tiers: ReadonlyArray<[string, (candidate: PaneCandidate) => boolean]> = [
    ['pane id', (candidate) => candidate.pane.id === token],
    // `peer:<key prefix>:<their terminal id>` — the tail is what their own
    // machine calls the pane, and is the half a person would copy.
    ['terminal id', (candidate) => candidate.pane.id.endsWith(`:${token}`)],
    ['title', (candidate) => candidate.pane.title === token]
  ]

  for (const [tier, predicate] of tiers) {
    const matches = candidates.filter(predicate)
    if (matches.length === 1) return matches[0] as PaneCandidate
    if (matches.length > 1) {
      throw new CliError({
        code: 'ambiguous_selector',
        message: `"${token}" matches ${matches.length} of ${handle}'s panes by ${tier}. Use the full pane id.`,
        exitCode: ExitCode.Failure,
        data: { matches: matches.map(describePane) }
      })
    }
  }

  throw new CliError({
    code: 'not_found',
    message: `${handle} has no pane matching "${token}".`,
    exitCode: ExitCode.Failure,
    hint: `Panes: ${candidates.map((candidate) => candidate.pane.id).join(', ')}.`,
    data: { panes: candidates.map(describePane) }
  })
}

/** Resolves project, teammate and pane in one go: every pane command needs all three. */
async function resolveTarget(
  context: CommandContext,
  projectToken: string,
  teammateToken: string
): Promise<{ projectId: string; projectName: string; person: ReturnType<typeof selectTeammate>; pane: PaneCandidate }> {
  const project = await resolveProject(context.client, projectToken)
  const presence = await context.client.call('teamwork.presence', { projectId: project.id })
  const person = selectTeammate(presence, teammateToken)
  const pane = selectPane(panesOf(presence, person.publicKey), person.handle, readString(context.flags, 'pane'))
  return { projectId: project.id, projectName: project.name, person, pane }
}

/** Default pty size a watcher letterboxes to when the owner reported none. */
const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

const DEFAULT_WATCH_QUIET_MS = 400
const DEFAULT_WATCH_TIMEOUT_MS = 5_000

type WatchCollection = {
  reason: 'quiet' | 'timeout' | 'exit' | 'lost' | 'interrupted'
  output: string
  /** Bytes the pane printed that this side will never see; a gap, announced. */
  elidedBytes: number
  exitCode?: number
  lostReason?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * Reads a teammate's pane for a bounded while, or until told to stop.
 *
 * `teamwork.watch` answers with the scrollback and then the live tail on one
 * subscription, so a snapshot is "subscribe, let the scrollback land, stop" —
 * which is what a quiet window measures. An exit or a lost link ends either
 * mode, because both say there is nothing more to read and a reader left
 * staring at a frozen pane would be a lie.
 */
async function collectPane(options: {
  client: RuntimeClient
  projectId: string
  paneId: string
  follow: boolean
  quietMs: number
  timeoutMs: number
  /** Text mode with --follow writes through this as bytes arrive. */
  onData?: (text: string) => void
}): Promise<WatchCollection> {
  let output = ''
  let elidedBytes = 0
  let stopped: WatchCollection['reason'] | undefined
  let exitCode: number | undefined
  let lostReason: string | undefined
  let lastAt = Date.now()

  const subscription = await options.client.subscribe(
    'teamwork.watch',
    { projectId: options.projectId, paneId: options.paneId },
    (raw) => {
      const event = raw as WatchedPaneEvent
      lastAt = Date.now()
      if (event.type === 'data') {
        if (options.onData) options.onData(event.data)
        else output += event.data
        return
      }
      if (event.type === 'elided') {
        elidedBytes += event.bytes
        return
      }
      if (event.type === 'exit') {
        exitCode = event.exitCode
        stopped = 'exit'
        return
      }
      if (event.type === 'lost') {
        lostReason = event.reason
        stopped = 'lost'
      }
    }
  )

  const interrupt = (): void => {
    stopped = 'interrupted'
  }
  // Signals only in follow mode: a bounded snapshot ends on its own, and a CLI
  // that swallowed Ctrl-C for a command that is about to return anyway would be
  // taking something away from the caller for nothing.
  const release = options.follow ? stopSignals(interrupt) : undefined

  const started = Date.now()
  const tick = Math.max(5, Math.min(50, options.quietMs))
  try {
    for (;;) {
      if (stopped !== undefined) break
      if (!options.follow) {
        if (Date.now() - lastAt >= options.quietMs) {
          stopped = 'quiet'
          break
        }
        if (Date.now() - started >= options.timeoutMs) {
          stopped = 'timeout'
          break
        }
      }
      await sleep(tick)
    }
  } finally {
    release?.()
    await subscription.unsubscribe().catch(() => {})
  }

  return {
    reason: stopped ?? 'quiet',
    output,
    elidedBytes,
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(lostReason === undefined ? {} : { lostReason })
  }
}

/** Ctrl-C ends a follow cleanly rather than killing it mid-subscription. */
function stopSignals(stop: () => void): () => void {
  const onSignal = (): void => stop()
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  return () => {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

export const teamCommands: readonly CommandSpec[] = [
  {
    path: ['team', 'status'],
    summary: 'Say whether teamwork is on for a project, and who is there.',
    details:
      'The one command to reach for first. It answers four separate questions and keeps them separate: ' +
      'whether teamwork is configured at all, where the relay is, whether this machine is on the roster, and ' +
      'how each link to a teammate is going.\n\n' +
      'A project with no relay is not offline, it is not configured, and this says so rather than showing it ' +
      "as a network problem. `enrolled: no` is the one cause of silence that is entirely this end's: every " +
      'link waits forever for a teammate who has no key to answer with.\n\n' +
      'Exit stays 0 whatever the answer, including "teamwork is off": the codes say whether the command ran. ' +
      "Branch on `status.disabledReason` and on each link's `phase` under --json.",
    args: [PROJECT_ARG],
    examples: ['teamree team status api', 'teamree team status api --json'],
    run: async (context) => {
      const project = await resolveProject(context.client, context.args[0] as string)
      const status = await context.client.call('teamwork.status', { projectId: project.id })
      const presence = await context.client.call('teamwork.presence', { projectId: project.id })
      const now = Date.now()

      const standings = new Map(presence.teammates.map((person) => [person.publicKey, person]))
      const linked = new Set(status.links.map((link) => link.publicKey))
      const rows = [
        ...status.links.map((link) => {
          const standing = standings.get(link.publicKey)
          return [
            link.handle,
            link.phase,
            standing?.connected ? 'yes' : 'no',
            ago(standing?.heardAt ?? null, now),
            link.detail ?? ''
          ]
        }),
        // Somebody on the roster with no link at all is a real state — teamwork
        // is off, or their key arrived since the last dial — and dropping them
        // would show a shorter roster than the repository has.
        ...presence.teammates
          .filter((person) => !linked.has(person.publicKey))
          .map((person) => [person.handle, 'no link', person.connected ? 'yes' : 'no', ago(person.heardAt, now), ''])
      ]

      const header = formatFields([
        ['project', `${project.name} (${project.id})`],
        ['teamwork', status.disabledReason === null ? 'on' : `off - ${status.disabledReason}`],
        ['relay', status.relay === null ? 'none' : `${status.relay.url} (${status.relay.source})`],
        ['origin', status.origin.ok ? 'ok' : `not shared - ${status.origin.reason}`],
        ['enrolled', status.enrolled ? 'yes' : 'no - this machine’s key is not on the roster; run `teamree team join`'],
        ['roster', `${presence.teammates.length} teammate${presence.teammates.length === 1 ? '' : 's'}`],
        ['read at', new Date(status.readAt).toISOString()]
      ])

      const table = formatTable(
        ['HANDLE', 'LINK', 'LIVE', 'HEARD', 'DETAIL'],
        rows,
        'Nobody else is on this roster yet.'
      )
      return { data: { project, status, presence }, text: `${header}\n\n${table}` }
    }
  },
  {
    path: ['team', 'members'],
    summary: "List a project's roster: every committed public key.",
    details:
      'The roster is files in the repository, not an account system: a key is a member because somebody with ' +
      'push access committed it. `problems` names files that could not be read, which is why a teammate can ' +
      'be missing from a list that is otherwise fine.',
    args: [PROJECT_ARG],
    examples: ['teamree team members api', 'teamree team members api --json'],
    run: async (context) => {
      const project = await resolveProject(context.client, context.args[0] as string)
      const list = await context.client.call('members.list', { projectId: project.id })

      const table = formatTable(
        ['HANDLE', 'SELF', 'ADDED', 'KEY', 'FILE'],
        list.members.map((member) => [
          member.handle,
          member.isSelf ? 'yes' : '',
          member.addedAt,
          shortKey(member.publicKey),
          member.file
        ]),
        'No members committed yet. Join with: teamree team join <project>'
      )

      const footer = formatFields([
        ['you', list.self.handle ?? '(no handle; git has no configured email)'],
        ['your key', shortKey(list.self.publicKey)],
        ['enrolled', list.enrolled ? 'yes' : `no - joining would write ${list.selfFile ?? '(no filename yet)'}`],
        ['watched', list.watched ? 'yes' : 'no - this list is only as fresh as this read']
      ])
      const problems =
        list.problems.length === 0
          ? ''
          : `\n\nProblems:\n${list.problems.map((problem) => `  ${JSON.stringify(problem)}`).join('\n')}`
      return { data: list, text: `${table}\n\n${footer}${problems}` }
    }
  },
  {
    path: ['team', 'join'],
    summary: "Write this machine's public key into a project's roster.",
    details:
      'It writes the file and stops there: it does not stage, commit or push. Getting the file into the ' +
      'repository is yours to do, and it has to be, because being able to push it is the whole of what ' +
      'membership means.\n\n' +
      'The private half never leaves this machine and is never written inside the repository.',
    args: [PROJECT_ARG],
    flags: [
      {
        name: 'handle',
        kind: 'string',
        placeholder: '<handle>',
        description: "Name to file the key under; defaults to one derived from git's configured email."
      }
    ],
    examples: ['teamree team join api', 'teamree team join api --handle ana'],
    run: async (context) => {
      const project = await resolveProject(context.client, context.args[0] as string)
      const handle = readString(context.flags, 'handle')
      const list = await context.client.call('members.join', {
        projectId: project.id,
        ...(handle === undefined ? {} : { handle })
      })
      const me = list.members.find((member) => member.isSelf)
      const lines = [
        me === undefined
          ? 'Wrote the key, but it is not showing in the roster yet.'
          : `Joined ${project.name} as ${me.handle}.`,
        me === undefined ? '' : `Wrote ${me.file}. Commit and push it — that is what makes it membership.`
      ].filter((line) => line.length > 0)
      return { data: list, text: lines.join('\n') }
    }
  },
  {
    path: ['team', 'relay', 'show'],
    summary: "Show where a project's relay is recorded, and what each place says.",
    details:
      'Both halves are reported whichever is in effect, because the two questions worth asking are "which URL ' +
      'is teamree using" and "why is it not the one I set". The per-machine override is named even when it is ' +
      'not set at all, since an app launched from a desktop inherits no shell environment.',
    args: [PROJECT_ARG],
    examples: ['teamree team relay show api --json'],
    run: async (context) => {
      const project = await resolveProject(context.client, context.args[0] as string)
      const relay = await context.client.call('teamwork.relay', { projectId: project.id })
      return {
        data: relay,
        text: formatFields([
          ['url', relay.url ?? 'none'],
          ['source', relay.source ?? '-'],
          ['problem', relay.problem ?? '-'],
          ['file', relay.file],
          ['on disk', relay.onDisk.url ?? `none - ${relay.onDisk.problem ?? 'no file'}`],
          ['override', `${relay.override.name}=${relay.override.value ?? '(not set)'}`]
        ])
      }
    }
  },
  {
    path: ['team', 'relay', 'set'],
    summary: 'Write a relay URL into the project, at .teamree/relay.',
    details:
      "Like joining, it writes the file and stops: the relay is a team-wide fact and it becomes the team's " +
      'when somebody pushes it.\n\n' +
      "The URL is checked by the runtime, by the same code the window's relay field goes through, so the CLI " +
      'and the GUI cannot come to different conclusions about what a relay URL is. A URL that is not a ' +
      'WebSocket one is refused with what to type instead, and that refusal is exit code 1.',
    args: [
      PROJECT_ARG,
      { name: 'url', description: 'WebSocket URL, e.g. wss://relay.example/v1/relay.', required: true }
    ],
    examples: ['teamree team relay set api wss://relay.example/v1/relay'],
    run: async (context) => {
      const project = await resolveProject(context.client, context.args[0] as string)
      const relay = await context.client.call('teamwork.setRelay', {
        projectId: project.id,
        url: context.args[1] as string
      })
      return {
        data: relay,
        text: [
          `Wrote ${relay.file} in ${project.name}: ${relay.onDisk.url ?? '(nothing)'}.`,
          'Commit and push it to make it the team’s.',
          ...(relay.source === 'environment'
            ? [`Note: ${relay.override.name} is set, so this machine keeps dialling ${relay.url ?? 'nothing'}.`]
            : [])
        ].join('\n')
      }
    }
  },
  {
    path: ['team', 'watch'],
    summary: "Read a teammate's pane.",
    details:
      'A bounded snapshot by default, because a CLI command that never returns is not a thing a script can ' +
      'call. The watch delivers the pane’s scrollback and then its live tail on one subscription, so the ' +
      'snapshot is: open it, let the scrollback land, stop when the pane has been quiet for --quiet-ms, and ' +
      'release the subscription. Output flows only while somebody has the pane open, so nothing is left ' +
      'running on the teammate’s machine afterwards.\n\n' +
      'With --follow it streams until you interrupt it, until the pane’s process exits, or until the link ' +
      'to that machine goes away — a watcher whose teammate shut their laptop must not be left looking at a ' +
      'frozen pane that appears live.\n\n' +
      '--follow and --json are refused together, on purpose: --json promises exactly one JSON document on ' +
      'stdout and a stream is not one. Use the snapshot with --json, or --follow without it.\n\n' +
      'Reading is visible to the owner while it happens; there is no quiet way to watch somebody.',
    args: [PROJECT_ARG, TEAMMATE_ARG],
    flags: [
      PANE_FLAG,
      { name: 'follow', kind: 'boolean', alias: 'f', description: 'Stream until interrupted instead of snapshotting.' },
      {
        name: 'quiet-ms',
        kind: 'number',
        placeholder: '<ms>',
        description: `Silence that ends a snapshot. Defaults to ${DEFAULT_WATCH_QUIET_MS}.`
      },
      {
        name: 'timeout-ms',
        kind: 'number',
        placeholder: '<ms>',
        description: `Hard ceiling on a snapshot. Defaults to ${DEFAULT_WATCH_TIMEOUT_MS}.`
      }
    ],
    examples: [
      'teamree team watch api ana --json',
      'teamree team watch api ana --pane t_7 --follow',
      'teamree team watch api ana --quiet-ms 2000'
    ],
    run: async (context) => {
      const follow = readBoolean(context.flags, 'follow')
      if (follow && context.json) {
        throw new UsageError(
          '--follow and --json cannot be used together.',
          '--json emits exactly one JSON document; a stream is not one. Drop --follow for a snapshot, or drop --json.'
        )
      }

      const target = await resolveTarget(context, context.args[0] as string, context.args[1] as string)
      const collected = await collectPane({
        client: context.client,
        projectId: target.projectId,
        paneId: target.pane.pane.id,
        follow,
        quietMs: readNumber(context.flags, 'quiet-ms') ?? DEFAULT_WATCH_QUIET_MS,
        timeoutMs: readNumber(context.flags, 'timeout-ms') ?? DEFAULT_WATCH_TIMEOUT_MS,
        // Streaming writes go straight out; in --json mode there is no follow,
        // so the single-document guarantee is structural rather than checked.
        ...(follow ? { onData: (text: string) => context.streams.out(text) } : {})
      })

      const data = {
        projectId: target.projectId,
        handle: target.person.handle,
        paneId: target.pane.pane.id,
        worktree: target.pane.worktree,
        title: target.pane.pane.title,
        // The owner's, and never negotiated: a reader letterboxes rather than
        // resizing a pty under a program it is only reading.
        cols: target.pane.pane.cols ?? DEFAULT_COLS,
        rows: target.pane.pane.rows ?? DEFAULT_ROWS,
        live: target.pane.live,
        follow,
        reason: collected.reason,
        output: collected.output,
        bytes: Buffer.byteLength(collected.output),
        elidedBytes: collected.elidedBytes,
        ...(collected.exitCode === undefined ? {} : { exitCode: collected.exitCode }),
        ...(collected.lostReason === undefined ? {} : { lostReason: collected.lostReason })
      }

      // Follow already wrote every byte as it arrived; anything more here would
      // be a second copy of the same output.
      if (follow) {
        const notes = [
          collected.reason === 'exit' ? `\n[pane exited ${collected.exitCode ?? '?'}]` : '',
          collected.reason === 'lost' ? `\n[link lost: ${collected.lostReason ?? 'no reason given'}]` : '',
          collected.elidedBytes > 0 ? `\n[${collected.elidedBytes} bytes elided by the relay]` : ''
        ].filter((note) => note.length > 0)
        return { data, text: notes.join('') }
      }

      const banner = collected.elidedBytes > 0 ? `[${collected.elidedBytes} bytes elided by the relay]\n` : ''
      const footer =
        collected.reason === 'exit'
          ? `\n[pane exited ${collected.exitCode ?? '?'}]`
          : collected.reason === 'lost'
            ? `\n[link lost: ${collected.lostReason ?? 'no reason given'}]`
            : ''
      const body = collected.output === '' ? `[${target.person.handle}: nothing to read]` : collected.output
      return { data, text: `${banner}${body}${footer}` }
    }
  },
  {
    path: ['team', 'type'],
    summary: "Type into a teammate's pane.",
    details:
      'Keystrokes, as if they were typed on their keyboard: what crosses the wire is a terminal write, ' +
      'answered by their machine and running as them.\n\n' +
      'This is a real capability and a real foot-gun, and it is here because every guard that makes it ' +
      'survivable lives at the owner’s end and is unchanged by the caller being a script. Their machine ' +
      'refuses unless your key is on the roster and the session is confirmed; it refuses outright when the ' +
      'owner has muted the pane; it caps one write at 64 KiB; and it records every write — who, which pane, ' +
      'how many bytes, what happened — in a log that survives a restart. The owner sees "you are typing" ' +
      'while it happens, exactly as they do when the window sends it. Withholding it from the CLI would not ' +
      'remove the capability from the product, only from the caller whose commands can be read back.\n\n' +
      'What the CLI adds is that nothing is submitted by accident: the text is sent verbatim and --enter is ' +
      'the only thing that appends a carriage return. A refusal comes back with the code the owner gave it — ' +
      '"muted" and "that pane is gone" are different answers — and is exit code 1, never swallowed.\n\n' +
      'Type only into a pane you have looked at. `teamree team watch` is the looking.',
    args: [PROJECT_ARG, TEAMMATE_ARG],
    flags: [
      PANE_FLAG,
      { name: 'text', kind: 'string', placeholder: '<text>', description: 'Exact bytes to send.', required: true },
      { name: 'enter', kind: 'boolean', description: 'Append a carriage return, submitting the line.' }
    ],
    examples: [
      'teamree team type api ana --text y --enter',
      'teamree team type api ana --pane t_7 --text "npm test" --enter'
    ],
    run: async (context) => {
      const data = requireString(context.flags, 'text') + (readBoolean(context.flags, 'enter') ? '\r' : '')
      const bytes = Buffer.byteLength(data)
      // Checked here so an oversized paste is a usage error with a number in it
      // rather than a schema rejection from the far end of a relay.
      if (bytes > MAX_REMOTE_WRITE_BYTES) {
        throw new UsageError(
          `--text is ${bytes} bytes; one remote write may carry at most ${MAX_REMOTE_WRITE_BYTES}.`,
          'Past that it is not typing: carrying it would cost the pane the live output it is being typed into.'
        )
      }

      const target = await resolveTarget(context, context.args[0] as string, context.args[1] as string)
      await context.client.call('teamwork.type', {
        projectId: target.projectId,
        paneId: target.pane.pane.id,
        data
      })
      return {
        data: {
          written: true,
          projectId: target.projectId,
          handle: target.person.handle,
          paneId: target.pane.pane.id,
          bytes,
          enter: readBoolean(context.flags, 'enter')
        },
        text: `sent ${bytes} bytes to ${target.person.handle}'s pane ${target.pane.pane.id}`
      }
    }
  },
  {
    path: ['team', 'panes'],
    summary: 'List the teammate panes this machine can see in one project.',
    details:
      'What `team watch` and `team type` address, and where their pane ids come from. A pane on a row that ' +
      'is not live is a true picture of what that teammate was showing when their machine was last ' +
      'reachable, and not a statement about what it is showing now — nothing can be done to it.',
    args: [PROJECT_ARG],
    flags: [
      {
        name: 'teammate',
        kind: 'string',
        placeholder: '<teammate>',
        description: 'Restrict to one teammate (handle or public key prefix).'
      }
    ],
    examples: ['teamree team panes api', 'teamree team panes api --teammate ana --json'],
    run: async (context) => {
      const project = await resolveProject(context.client, context.args[0] as string)
      const presence = await context.client.call('teamwork.presence', { projectId: project.id })
      const token = readString(context.flags, 'teammate')
      const candidates =
        token === undefined
          ? presence.worktrees
              .flatMap((worktree) => panesOf(presence, worktree.publicKey))
              .filter(
                (candidate, index, all) => all.findIndex((other) => other.pane.id === candidate.pane.id) === index
              )
          : panesOf(presence, selectTeammate(presence, token).publicKey)

      return {
        data: { projectId: project.id, panes: candidates.map(describePane), readAt: presence.readAt },
        text: formatTable(
          ['HANDLE', 'PANE', 'WORKTREE', 'TITLE', 'STATE', 'LIVE', 'QUIET'],
          candidates.map((candidate) => [
            candidate.handle,
            candidate.pane.id,
            candidate.worktree.name,
            candidate.pane.title,
            candidate.pane.running ? (candidate.pane.busy ? 'busy' : 'idle') : `exit ${candidate.pane.exitCode ?? '?'}`,
            candidate.live ? 'yes' : 'no',
            ago(Date.now() - candidate.pane.quietForMs, Date.now())
          ]),
          'No teammate panes heard about yet.'
        )
      }
    }
  },
  {
    path: ['team', 'watchers'],
    summary: "Show who is reading and typing into this machine's panes.",
    details:
      'The owner’s half of the bargain that makes "anyone can type" survivable: nothing can be done to ' +
      'your panes invisibly. It is live rather than a log — for the record of what was actually typed, use ' +
      '`teamree team write-log`.\n\n' +
      'Only panes with something to say appear: a reader, a typist, or a mute. An empty list means nobody is ' +
      'reading, nobody has typed, and nothing is muted.',
    args: [PROJECT_ARG],
    examples: ['teamree team watchers api --json'],
    run: async (context) => {
      const project = await resolveProject(context.client, context.args[0] as string)
      const watchers = await context.client.call('teamwork.watchers', { projectId: project.id })
      return {
        data: watchers,
        text: formatTable(
          ['TERMINAL', 'MUTED', 'WATCHING', 'TYPED'],
          watchers.panes.map((pane) => [
            pane.terminalId,
            pane.muted ? 'yes' : '',
            pane.watchers.map((watcher) => watcher.handle).join(', '),
            pane.typists
              .map((typist) => `${typist.handle} (${typist.writes} writes, ${typist.refused} refused)`)
              .join(', ')
          ]),
          'Nobody is reading or typing here, and nothing is muted.'
        )
      }
    }
  },
  {
    path: ['team', 'mute'],
    summary: 'Stop remote keystrokes reaching one of this machine’s panes.',
    details:
      'The owner’s alone: no project and no handle, because a mute is of a pane rather than of a person ' +
      'and there is nobody to agree with. A muted pane keeps streaming and keeps appearing in everyone’s ' +
      'sidebar — mute stops the bytes, it does not hide the worktree. Attempts to type into it are still ' +
      'recorded, and still refused.',
    args: [{ name: 'terminal', description: 'Terminal id from `teamree terminal list`.', required: true }],
    examples: ['teamree team mute t_12'],
    run: async (context) => muteCommand(context, true)
  },
  {
    path: ['team', 'unmute'],
    summary: 'Let remote keystrokes reach one of this machine’s panes again.',
    args: [{ name: 'terminal', description: 'Terminal id from `teamree terminal list`.', required: true }],
    examples: ['teamree team unmute t_12'],
    run: async (context) => muteCommand(context, false)
  },
  {
    path: ['team', 'write-log'],
    summary: 'Print this machine’s record of every remote keystroke.',
    details:
      'Local, on this machine, and readable after the fact — including after a restart, which is what makes ' +
      'it a record rather than a display. Oldest first.\n\n' +
      'It deliberately does not hold the bytes. A remote write carries input, and input includes what a ' +
      'terminal does not echo, so keeping it would turn an audit trail into a plaintext store of teammates’ ' +
      'passphrases. How much was sent is here; what it was is not, anywhere.',
    flags: [
      {
        name: 'limit',
        kind: 'number',
        placeholder: '<count>',
        description: 'Trailing entries to return. Defaults to everything retained.'
      }
    ],
    examples: ['teamree team write-log --limit 20 --json'],
    run: async (context) => {
      const limit = readNumber(context.flags, 'limit')
      const log = await context.client.call('teamwork.writeLog', limit === undefined ? {} : { limit })
      const table = formatTable(
        ['WHEN', 'HANDLE', 'PANE', 'BYTES', 'RETURNS', 'OUTCOME', 'WHY'],
        log.writes.map((write) => [
          new Date(write.at).toISOString(),
          write.handle,
          write.terminalId,
          String(write.bytes),
          String(write.returns),
          write.outcome,
          write.reason ?? ''
        ]),
        'Nobody has typed into this machine.'
      )
      return {
        data: log,
        text: log.problem === null ? table : `${table}\n\nThe record may be incomplete: ${log.problem}`
      }
    }
  }
]

async function muteCommand(context: CommandContext, muted: boolean): Promise<{ data: unknown; text: string }> {
  const terminalId = context.args[0] as string
  const watchers = await context.client.call('teamwork.mute', { terminalId, muted })
  const pane = watchers.panes.find((candidate) => candidate.terminalId === terminalId)
  return {
    data: { terminalId, muted, watchers },
    text: [
      muted
        ? `Muted ${terminalId}. It keeps streaming; remote keystrokes are refused.`
        : `Unmuted ${terminalId}. Remote keystrokes reach it again.`,
      ...(pane !== undefined && pane.watchers.length > 0
        ? [`Reading it right now: ${pane.watchers.map((watcher) => watcher.handle).join(', ')}.`]
        : [])
    ].join('\n')
  }
}
