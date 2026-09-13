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
      'A project with no relay is not offline, it is not configured, and this says so rather than showing it ' +
      "as a network problem. `enrolled: no` is the one cause of silence that is entirely this end's: every " +
      'link waits forever for a teammate who has no key to answer with.\n\n' +
      'A project added seconds ago answers `state: unread`: it exists, and teamree has not read its relay, ' +
      'roster or origin yet. Nothing is asserted about it until it has — ask again in a moment.\n\n' +
      'Exit stays 0 whatever the answer, including "teamwork is off" and "not read yet". Branch on ' +
      "`status.state`, then on `status.disabledReason` and on each link's `phase` under --json.",
    args: [PROJECT_ARG],
    examples: ['teamree team status api', 'teamree team status api --json'],
    run: async (context) => {
      const project = await resolveProject(context.client, context.args[0] as string)
      const status = await context.client.call('teamwork.status', { projectId: project.id })
      // Nothing has been read about this project, so there is no roster to lay
      // a table out from and no relay to report — and asking the runtime for
      // the presence beside it would only be asking a second question it cannot
      // answer yet. One honest line instead, and still exit 0: a project this
      // machine has just been given is not a failure of the command.
      if (status.state === 'unread') {
        const header = formatFields([
          ['project', `${project.name} (${project.id})`],
          ['teamwork', 'not read yet - teamree has not read this project’s relay, roster or origin'],
          ['read at', new Date(status.readAt).toISOString()]
        ])
        return {
          data: { project, status, presence: null },
          text: `${header}\n\nAsk again in a moment.`
        }
      }
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
      'repository is yours to do — being able to push it is what membership means.\n\n' +
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
      'The committed file and the per-machine override are both reported, whichever is in effect. The ' +
      'override is named even when it is not set at all, since an app launched from a desktop inherits no ' +
      'shell environment.',
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
      "Like joining, it writes the file and stops: the relay becomes the team's when somebody pushes it.\n\n" +
      'A URL that is not a WebSocket one is refused with what to type instead, and that refusal is exit code 1.',
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
      'A bounded snapshot by default: it takes the pane’s scrollback and then its live tail, and stops once ' +
      'the pane has been quiet for --quiet-ms.\n\n' +
      'With --follow it streams until you interrupt it, until the pane’s process exits, or until the link ' +
      'to that machine goes away.\n\n' +
      '--follow and --json are refused together: --json promises exactly one JSON document on stdout and a ' +
      'stream is not one. Use the snapshot with --json, or --follow without it.\n\n' +
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
      'Every guard lives at the owner’s end. Their machine refuses unless your key is on the roster and the ' +
      'session is confirmed; it refuses outright when the owner has muted the pane; it caps one write at ' +
      '64 KiB; and it records every write — who, which pane, how many bytes, what happened — in a log that ' +
      'survives a restart. The owner sees "you are typing" while it happens.\n\n' +
      'Nothing is submitted by accident: the text is sent verbatim and --enter is the only thing that ' +
      'appends a carriage return. A refusal comes back with the code the owner gave it — "muted" and "that ' +
      'pane is gone" are different answers — and is exit code 1.\n\n' +
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
          'Send it as several smaller writes, or put the text in a file the pane can read.'
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
      'Where the pane ids for `team watch` and `team type` come from. A row that is not live shows what that ' +
      'teammate was showing when their machine was last reachable, not what is there now; nothing can be ' +
      'done to it.',
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
      'Live rather than a log — for the record of what was typed, use `teamree team write-log`.\n\n' +
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
    path: ['team', 'requests'],
    summary: 'Show whose keystrokes are waiting for you, and who may already type here.',
    details:
      'A teammate typing in one of this machine’s panes is held until you say so. Nothing in the list below ' +
      'has run: the bytes are on this machine, and the pane has not seen them.\n\n' +
      'WHAT is shown exactly as it was sent, with every control character made visible — an escape sequence ' +
      'is printed rather than obeyed, a return is a mark, and the characters that make text read backwards ' +
      'are named. Read it before you answer it.\n\n' +
      'A request expires on its own if nobody answers, and the teammate is told that it did. Standing ' +
      'permissions are listed underneath, because a permission you cannot see is one you cannot lift.',
    args: [PROJECT_ARG],
    examples: ['teamree team requests api', 'teamree team requests api --json'],
    run: async (context) => {
      const project = await resolveProject(context.client, context.args[0] as string)
      const waiting = await context.client.call('teamwork.requests', { projectId: project.id })
      const now = Date.now()
      const questions = formatTable(
        ['ID', 'WHO', 'PANE', 'KEYSTROKES', 'EXPIRES', 'WHAT'],
        waiting.requests.map((request) => [
          request.id,
          request.handle,
          request.terminalId,
          String(request.writes),
          `${Math.max(0, Math.round((request.expiresAt - now) / 1000))}s`,
          request.clipped ? `${request.preview} (more is held than is shown)` : request.preview
        ]),
        'Nobody is waiting on you.'
      )
      const permissions = formatTable(
        ['PANE', 'WHO', 'SCOPE'],
        waiting.standing.map((grant) => [grant.terminalId, grant.handle, grant.scope]),
        'Nobody may type here without being asked first.'
      )
      return { data: waiting, text: `${questions}\n\n${permissions}` }
    }
  },
  {
    path: ['team', 'allow'],
    summary: 'Let a teammate’s waiting keystrokes run.',
    details:
      'Without a flag this allows exactly what is waiting and nothing after it: the next keystroke asks ' +
      'again. `--session` lets that teammate type in that pane until this runtime stops or their link ' +
      'drops; `--always` lets them until you lift it or the pane closes, and survives a restart.\n\n' +
      'Read `teamree team requests` first. Allowing something you have not read is the one use of this ' +
      'command that makes the question pointless.',
    args: [{ name: 'request', description: 'Request id from `teamree team requests`.', required: true }],
    flags: [
      {
        name: 'session',
        kind: 'boolean',
        description: 'Allow this teammate in this pane until the runtime stops or their link drops.'
      },
      {
        name: 'always',
        kind: 'boolean',
        description: 'Allow this teammate in this pane until you lift it or the pane closes.'
      }
    ],
    examples: ['teamree team allow ask_3', 'teamree team allow ask_3 --session'],
    run: async (context) => {
      const requestId = context.args[0] as string
      const session = readBoolean(context.flags, 'session') === true
      const always = readBoolean(context.flags, 'always') === true
      if (session && always) {
        throw new UsageError('Choose one of --session and --always: they are two lengths of the same permission.')
      }
      const decision = always ? 'always' : session ? 'session' : 'once'
      const waiting = await context.client.call('teamwork.decide', { requestId, decision })
      return {
        data: { requestId, decision, requests: waiting },
        text: [
          decision === 'once'
            ? `Allowed ${requestId}. The next keystroke will ask again.`
            : decision === 'session'
              ? `Allowed ${requestId}, and this teammate may type in this pane until the runtime stops or their link drops.`
              : `Allowed ${requestId}, and this teammate may type in this pane until you lift it with \`teamree team revoke\`.`,
          waiting.requests.length === 0
            ? 'Nobody else is waiting on you.'
            : `${waiting.requests.length} other request${waiting.requests.length === 1 ? '' : 's'} still waiting.`
        ].join('\n')
      }
    }
  },
  {
    path: ['team', 'deny'],
    summary: 'Refuse a teammate’s waiting keystrokes.',
    details:
      'The bytes are dropped on this machine and never reach the pane. The teammate is told, in their own ' +
      'window, that you did not allow it — a keystroke that vanished without a word would leave them ' +
      'believing they had typed into your shell.',
    args: [{ name: 'request', description: 'Request id from `teamree team requests`.', required: true }],
    examples: ['teamree team deny ask_3'],
    run: async (context) => {
      const requestId = context.args[0] as string
      const waiting = await context.client.call('teamwork.decide', { requestId, decision: 'deny' })
      return {
        data: { requestId, decision: 'deny', requests: waiting },
        text: `Refused ${requestId}. Nothing reached the pane, and they were told.`
      }
    }
  },
  {
    path: ['team', 'revoke'],
    summary: 'Take back a standing permission to type in one of this machine’s panes.',
    details:
      'Yours alone, like a mute, and it takes effect on the next keystroke. The teammate is not told; they ' +
      'find out the way they found out they had it, by typing and being asked about.',
    args: [
      { name: 'terminal', description: 'Terminal id from `teamree terminal list`.', required: true },
      { name: 'teammate', description: 'Public key from `teamree team requests --json`.', required: true }
    ],
    examples: ['teamree team revoke t_12 Lx9TqvJ2mR0aUf7cHbN4sKwEdY1gZp6VtQiOnA3XjBM='],
    run: async (context) => {
      const terminalId = context.args[0] as string
      const publicKey = context.args[1] as string
      const waiting = await context.client.call('teamwork.revoke', { terminalId, publicKey })
      return {
        data: { terminalId, publicKey, requests: waiting },
        text: `Lifted. They will be asked again the next time they type in ${terminalId}.`
      }
    }
  },
  {
    path: ['team', 'mute'],
    summary: 'Stop remote keystrokes reaching one of this machine’s panes.',
    details:
      'A mute is of a pane rather than of a person, so it takes no project and no handle. A muted pane keeps ' +
      'streaming and keeps appearing in everyone’s sidebar — mute stops the keystrokes, it does not hide the ' +
      'worktree. Attempts to type into it are still recorded, and still refused.',
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
      'Local to this machine, and readable after a restart. Oldest first.\n\n' +
      'It does not hold the bytes: input includes what a terminal does not echo, so keeping it would turn an ' +
      'audit trail into a plaintext store of teammates’ passphrases. How much was sent is here; what it was ' +
      'is not, anywhere.',
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
