// Where a project is in setting teamwork up: `members.list`, `teamwork.relay`
// and `teamwork.status` read as five steps, holding no state of its own. It never
// claims the push happened, and "no origin" is not folded into "no relay".

import {
  teamworkFacts,
  type Member,
  type MemberList,
  type PeerLink,
  type PushFailureKind,
  type RelaySetting,
  type TeamworkPublish,
  type TeamworkPublishPlan,
  type TeamworkPublishProgress,
  type TeamworkRead,
  type TeamworkStatus
} from '@shared/entities'
import { sanitiseHandle } from '@shared/handle'
import { checkOrigin, pathIdentityNote, type OriginKind } from '@shared/origin'
import { parseRelayUrl } from '@shared/relayUrl'

export type StepId = 'identity' | 'key' | 'relay' | 'push' | 'connected'

/**
 * Which of the two jobs somebody is doing here. Not a role or a permission:
 * after setup both are members with identical powers (`docs/teamwork.md`).
 */
export type TeamworkPath = 'start' | 'join'

export type StepMark =
  /** Checked, and true. */
  | 'done'
  /** True for this run only (the environment override), not written anywhere a teammate reads. */
  | 'this-run'
  /** Checked, and not true yet. */
  | 'todo'
  /** teamree cannot check this one and says so rather than guessing. */
  | 'unchecked'
  /** Something else has to be fixed before this one can become true. */
  | 'blocked'

export type StartTeamworkStep = {
  id: StepId
  /** The fact the step establishes, not the action that establishes it. */
  title: string
  mark: StepMark
  /** One line saying what is true right now. Always set, never a bare code. */
  summary: string
}

export type StartTeamworkFlow = {
  steps: StartTeamworkStep[]
  /** The first step not done; null once every step teamree can check is. */
  currentId: StepId | null
  /** A fact about this checkout that stops teamwork whatever else is done, or null. Shown at the top. */
  blocker: string | null
}

/**
 * Why each read last failed. A read that threw and one still in flight both
 * leave `undefined`, and "wait a moment" is not "this will never arrive".
 */
export type StartTeamworkReadErrors = {
  /** `members.list`, which carries both the identity and the roster. */
  list?: string | undefined
  relay?: string | undefined
  status?: string | undefined
}

/** Which of the three reads a retry is for. */
export type StartTeamworkRead = keyof StartTeamworkReadErrors

export type StartTeamworkInput = {
  list: MemberList | undefined
  relay: RelaySetting | undefined
  status: TeamworkStatus | undefined
  failedReads?: StartTeamworkReadErrors | undefined
  /** Which of the two jobs this is. Null before anybody has said. */
  path?: TeamworkPath | null | undefined
}

/** Named here because the sidebar's "Your key is not here" tooltip tells people which button to press. */
export const ADD_KEY_BUTTON = 'Add my key'

/**
 * What adding a key grants: remote code execution by design (`docs/teamwork.md`).
 * Not a promise of safety — a prompt catches a colleague's mistake, not a bad roster entry.
 */
export const KEY_GRANT_WARNING = 'Anyone on this roster can type into any pane here, as you.'

/** The deploy, in the fewest words that are still true. `relay/README.md` has the rest. */
export const RELAY_DEPLOY = {
  button: 'Deploy a relay',
  browser: 'Opens a browser to sign in to Cloudflare; deploys to your team’s account.',
  /** Said while it runs, because somebody watching a pane deserves to know what finishing looks like. */
  watching: 'Prints a wss:// URL when it finishes.',
  /** The label on the button that takes the URL the deploy printed. */
  use: 'Use this relay URL',
  /** Above the command itself, kept for anybody who would rather run it themselves. */
  manual: 'Or run it yourself:'
} as const

/**
 * The relay somebody runs on their own machine. `limit` is the point: two Macs
 * behind two home routers is what a relay exists to solve, and this one does not.
 */
export const RELAY_SERVE = {
  button: 'Run a relay yourself',
  limit: 'Only reachable from machines that can already reach this Mac — one LAN, or a VPN you are all on.',
  /** Said while it runs, because somebody watching a pane deserves to know what finishing looks like. */
  watching: 'Prints the URL to give your team.',
  /** The label on the button that takes the URL the relay printed. */
  use: 'Use this relay URL',
  /** Beside the button, not instead of it: right for one LAN, a trap otherwise, and teamree cannot tell which. */
  committing: 'A private address is unreachable from outside that network.',
  /**
   * The relay's first address is a guess — the OS lists wifi, VPN and container
   * bridges in no ranking — so the person who knows the network picks.
   */
  choice: 'This Mac has more than one address. Take the one on the network you share:',
  /** Above the command itself, kept for anybody who would rather run it themselves. */
  manual: 'Or run it yourself:'
} as const

/**
 * Dialling a relay and saying what answered. `proves` keeps it honest: a pass
 * is a fact about this Mac's network and nobody else's.
 */
export const RELAY_CHECK = {
  button: 'Check this relay',
  /** A different label from `button`: both can be on screen at once and dial different addresses. */
  draftButton: 'Check the URL you typed',
  what: 'Dials it from here and says what answered.',
  proves: 'Dialled from this Mac only.',
  /** Why the button beside the paste field is grey, which is always the same reason. */
  nothing: 'No relay URL to check yet.'
} as const

/** The disclosure's label, named so the panel and its test agree. */
export const MORE_RELAYS_BUTTON = 'Other ways to get a relay'

/** Said above the folded options. Only the container options still need a clone. */
export const MORE_RELAYS_LEAD = 'The container options need a clone of the teamree repository.'

/**
 * Whether the URL belongs in the repository. A stable address is a team fact;
 * an ephemeral one is gone tomorrow, which is why `TEAMREE_RELAY_URL` exists.
 */
export type RelayKeep = 'commit' | 'override'

/** How prominent an option is. No `lead`: the lead is the deploy button. */
export type RelayTier =
  /** The one alternative worth meeting first, inside the disclosure. */
  | 'fallback'
  /** Real, documented, and further down. */
  | 'more'

export type RelayOption = {
  id: 'tunnel' | 'mesh' | 'vps'
  tier: RelayTier
  name: string
  /** What it is, and who it is right for. */
  what: string
  /** Copyable, and run in a terminal rather than by this app. */
  commands: string
  effort: string
  money: string
  keep: RelayKeep
  /** What address comes out of it, and what to do with that address. */
  address: string
}

/** Every other way a team gets a relay, in the order to meet them. The facts are `relay/README.md`'s. */
export const RELAY_OPTIONS: readonly RelayOption[] = [
  {
    id: 'tunnel',
    tier: 'fallback',
    name: 'A tunnel to a relay on your own machine',
    what: 'Run the relay with the button above, then put a tunnel in front of it. No account.',
    commands: 'cloudflared tunnel --url http://localhost:8787',
    effort: 'A couple of minutes.',
    money: 'Free, while the tunnel and this machine are up.',
    keep: 'override',
    address: 'An ephemeral https:// URL that dies with the tunnel. Set TEAMREE_RELAY_URL to its wss:// form.'
  },
  {
    id: 'mesh',
    tier: 'more',
    name: 'A mesh VPN, or a box on the LAN',
    what: 'Run the relay on any machine the others can already reach. Nothing is exposed publicly.',
    commands:
      'cd relay\ndocker build -t teamree-relay .\ndocker run -d -p 8787:8787 --restart unless-stopped teamree-relay',
    effort: 'Minutes, if the network already exists.',
    money: 'Whatever the box costs.',
    keep: 'commit',
    address: 'ws://<that machine>:8787/v1/relay, or wss:// with TLS in front of it.'
  },
  {
    id: 'vps',
    tier: 'more',
    name: 'A VPS you rent',
    what: 'The container on a small server, with Caddy or nginx in front for TLS.',
    commands:
      'cd relay\ndocker build -t teamree-relay .\ndocker run -d -p 8787:8787 --restart unless-stopped teamree-relay\n' +
      '# then terminate TLS in front of it and forward the upgrade headers',
    effort: 'An afternoon, then a server to patch.',
    money: 'Whatever the server costs, monthly.',
    keep: 'commit',
    address: 'wss://<your hostname>/v1/relay'
  }
] as const

/**
 * The override that is set, cannot be read, and has taken this project's relay
 * away — or null. The runtime reads `TEAMREE_RELAY_URL` before the file and stops
 * there, so a broken override leaves no relay while `.teamree/relay` looks fine.
 */
export function brokenRelayOverride(relay: RelaySetting): string | null {
  if (relay.override.value === null || relay.url !== null || relay.onDisk.url === null) return null
  return (
    `${relay.override.name} is set to ${relay.override.value}, which is not a relay URL, so this project has no ` +
    `relay even though ${relay.file} has one.`
  )
}

/** A scheme a relay is dialled on. Nothing else is ever taken out of a pane. */
export type RelayUrlScheme = 'ws' | 'wss'

/**
 * Which schemes each pane may offer a URL on. A deploy prints `wss://` only, so
 * `ws://` out of it is a log line, not an endpoint; a check echoes its input and offers nothing.
 */
export const RELAY_PANE_URL_SCHEMES: Record<RelayPaneKind, readonly RelayUrlScheme[]> = {
  deploy: ['wss'],
  serve: ['ws', 'wss'],
  check: []
}

/** The relay URL a pane printed; the last one wins, since a second deploy means the second. */
export function relayUrlFromOutput(output: string, schemes: readonly RelayUrlScheme[]): string | null {
  const found = relayUrlsInOutput(output, schemes)
  return found[found.length - 1] ?? null
}

/**
 * Every relay URL a pane printed, in print order, each once. The last is the
 * command's own guess and can be a container bridge or VPN address, so all are offered.
 */
export function relayUrlsFromOutput(output: string, schemes: readonly RelayUrlScheme[]): string[] {
  const found: string[] = []
  for (const url of relayUrlsInOutput(output, schemes)) if (!found.includes(url)) found.push(url)
  return found
}

/** Every URL in the pane's scrollback that parses, in the order printed, repeats and all. */
function relayUrlsInOutput(output: string, schemes: readonly RelayUrlScheme[]): string[] {
  if (schemes.length === 0) return []
  // Longest first, so `wss://…` is never matched as `ws` followed by a `s://`
  // that is not a scheme separator at all.
  const alternatives = [...schemes].sort((a, b) => b.length - a.length).join('|')
  const pattern = new RegExp(String.raw`(?:${alternatives}):\/\/[^\s"'<>)\]]+`, 'g')
  const found: string[] = []
  for (const match of output.matchAll(pattern)) {
    const parsed = parseRelayUrl(match[0])
    if (parsed.ok) found.push(parsed.url)
  }
  return found
}

/**
 * The same launcher with a different verb, or null when the reported command does
 * not end in ` deploy`: swapping the verb on a program the runtime found is safe,
 * guessing at a different program is not. Shell-quoted because the pane is a shell.
 */
export function relayLauncherCommand(deployCommand: string, verb: 'serve' | 'check', argument?: string): string | null {
  const suffix = ' deploy'
  if (!deployCommand.endsWith(suffix)) return null
  const launcher = deployCommand.slice(0, -suffix.length)
  if (launcher.trim() === '') return null
  return argument === undefined ? `${launcher} ${verb}` : `${launcher} ${verb} ${singleQuote(argument)}`
}

/** One shell word: single quotes protect everything except a quote, which is closed, escaped and reopened. */
function singleQuote(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`
}

/** The button that pushes, named once so the panel and its tests agree. */
export const PUBLISH_BUTTON = 'Commit and push'

/** Which of the launcher's verbs a pane is running; one slot holds all three. */
export type RelayPaneKind = 'deploy' | 'serve' | 'check'

/** A relay command running in a pane in this window, as the panel needs to see it. */
export type RelayPaneState = {
  /** Which verb is running, because one pane slot holds all three. */
  kind: RelayPaneKind
  /** The pane the command is running in. */
  terminalId: string
  /** The relay URL the command offered, once it has offered one. Never set for a check. */
  url: string | null
  /** Every relay URL the pane printed, `url` among them, in print order. See `relayUrlsFromOutput`. */
  urls: string[]
  /** False once the command has exited; the pane stays until it is closed. */
  running: boolean
}

/** Why a second relay command cannot start: one pane per project, and a grey button needs a reason. */
export function relayPaneBusy(kind: RelayPaneKind): string {
  const what =
    kind === 'deploy' ? 'A deploy is' : kind === 'serve' ? 'A relay you are running yourself is' : 'A relay check is'
  return `${what} already open in a pane below. Close it first.`
}

/** Why a verb cannot run: the reported command does not end in ` deploy`, so nothing here knows the program. */
export const RELAY_LAUNCHER_UNKNOWN =
  'This build reports a relay command teamree does not recognise. Paste a relay URL below instead.'

/** What the pane says it is, above the terminal itself. */
export const RELAY_PANE_TITLES: Record<RelayPaneKind, string> = {
  deploy: 'Deploying a relay',
  serve: 'Running a relay on this Mac',
  check: 'Checking a relay'
}

/** Said when the command is over and there is no URL, instead of a blank space. */
export const RELAY_PANE_NO_URL = 'Finished, and printed no relay URL.'

/**
 * A `serve` address dies with its process, so the offer is withdrawn when the
 * pane stops. A deploy is different: its Worker outlives the pane.
 */
export const RELAY_SERVE_STOPPED = 'The relay in this pane has stopped, so the address it printed answers nothing.'

/** Whether the origin button is busy, and why it was last refused. */
export type OriginState = { pending: boolean; error: string | null }

/** Everything the commit-and-push button needs to describe itself and report back. */
export type PublishState = {
  /** What the runtime says the button would do. Undefined until it has been read. */
  plan: TeamworkPublishPlan | undefined
  pending: boolean
  /** Why the attempt could not even be made — a commit git refused, say. */
  error: string | null
  /** What the last attempt did, including a push that failed after a commit that did not. */
  result: TeamworkPublish | undefined
  /** What the running publish is doing. Separate from `result`, which is what the call eventually answered. */
  progress: TeamworkPublishProgress | undefined
}

/** What to commit, and the commands that do it. Null when nothing is written. */
export type PushPlan = {
  /** Paths relative to the project root, as a diff would show them. */
  files: string[]
  /** Ready to paste, and never run by this app. */
  commands: string
}

/**
 * The one step the app will not take, as one commit for both files. The `cd` is
 * in the block because `.teamree` is in the primary checkout, not the worktree a pane opens in.
 */
export function pushPlan(
  list: MemberList | undefined,
  relay: RelaySetting | undefined,
  projectPath: string | undefined
): PushPlan | null {
  const mine = list?.enrolled ? (selfFileOf(list) ?? null) : null
  const theirs = relay?.onDisk.url ? relay.file : null
  const files = [mine, theirs].filter((file): file is string => file !== null)
  if (files.length === 0) return null

  const message = mine === null ? 'Meet on our relay' : theirs === null ? 'Add my key to the team' : 'Set up teamwork'
  const cd = projectPath === undefined ? '' : `cd ${shellPath(projectPath)}\n`
  return { files, commands: `${cd}git add .teamree\ngit commit -m "${message}"\ngit push` }
}

/** A path as one shell word, quoted only when it has to be (`~/My Projects/thing`). */
function shellPath(path: string): string {
  return /^[\w./@%+:,-]+$/.test(path) ? path : `'${path.replaceAll("'", String.raw`'\''`)}'`
}

/**
 * How long git may say nothing before the silence is reported. A healthy push
 * prints within seconds; one waiting for a credential prints nothing, ever.
 */
export const PUBLISH_QUIET_MS = 30_000

/** A publish in flight, as the panel needs to describe it this second. */
export type PublishActivity = {
  /** What it is doing, in words rather than as a phase name. */
  doing: string
  /** How long the whole publish has been going. */
  elapsedMs: number
  /** The last thing git printed, or null when it has printed nothing. */
  lastLine: string | null
  /** How long git has been silent. */
  quietMs: number
  /** What the silence probably means, once long enough. Null while git is talking. */
  quiet: string | null
  /** True between pressing Stop and the process actually going. */
  cancelling: boolean
  /** False once it is over; the record stays so the duration can be reported. */
  running: boolean
}

const PHASE_WORDS: Record<TeamworkPublishProgress['phase'], string> = {
  staging: 'Staging the files',
  committing: 'Making the commit',
  pushing: 'Pushing to the remote',
  finished: 'Finished'
}

/** The running publish as one sentence and two numbers — the answer to "it gets stuck at git push". */
export function publishActivity(progress: TeamworkPublishProgress | undefined, now: number): PublishActivity | null {
  if (progress === undefined) return null
  const running = progress.finishedAt === null
  const elapsedMs = Math.max(0, (progress.finishedAt ?? now) - progress.startedAt)
  const quietMs = Math.max(0, now - progress.lastOutputAt)
  return {
    doing: progress.cancelling ? 'Stopping' : PHASE_WORDS[progress.phase],
    elapsedMs,
    lastLine: progress.output[progress.output.length - 1] ?? null,
    quietMs,
    quiet:
      running && progress.phase === 'pushing' && !progress.cancelling && quietMs >= PUBLISH_QUIET_MS
        ? `git has printed nothing for ${formatElapsed(quietMs)}. A push that goes this quiet is usually waiting ` +
          'for a credential teamree cannot be asked for. Stop it, and run the same push once in Terminal to see ' +
          'what it wants.'
        : null,
    cancelling: progress.cancelling,
    running
  }
}

/** A duration for somebody watching a clock: whole seconds, never a decimal. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
}

/** The label on the button that stops a push, named once so the tests can find it. */
export const CANCEL_PUBLISH_BUTTON = 'Stop'

/** The label on the button that tries a refused push again. */
export const RETRY_PUBLISH_BUTTON = 'Try the push again'

/**
 * Whether trying again could help. A rejection needs a pull first; an auth
 * refusal gets the button so an `ssh-add` in Terminal can be tried from here.
 */
export function retryHint(kind: PushFailureKind): string | null {
  switch (kind) {
    case 'rejected':
      return 'Pull with rebase first: git pull --rebase.'
    case 'auth':
    case 'host-key':
      return 'Fix the credential first; nothing in this window changes it.'
    case 'cancelled':
      return 'Nothing was sent. The commit is still here.'
    case 'timeout':
      return 'It never finished rather than being refused.'
    default:
      return null
  }
}

export type RelayDraftCheck =
  | { state: 'empty' }
  | { state: 'ok'; url: string }
  /** `suggestion` is the corrected URL, offered whenever one can be worked out. */
  | { state: 'bad'; reason: string; suggestion: string | null }

/**
 * The field's verdict before anything is written, on the grammar the runtime
 * refuses with. Takes the URL out of whatever it arrives inside — a sentence,
 * a log line, a full stop stuck on the end.
 */
export function checkRelayDraft(raw: string): RelayDraftCheck {
  if (raw.trim() === '') return { state: 'empty' }
  const first = parseRelayUrl(raw)
  if (first.ok) return { state: 'ok', url: first.url }

  const found = urlsIn(raw)
  for (const candidate of found) {
    const parsed = parseRelayUrl(candidate)
    if (parsed.ok) return { state: 'ok', url: parsed.url }
  }
  // Nothing in it parses, so the refusal is about the most relay-shaped thing
  // that was in there — which is what carries the suggestion worth offering.
  const best = found[0] === undefined ? first : parseRelayUrl(found[0])
  if (best.ok) return { state: 'ok', url: best.url }
  return { state: 'bad', reason: sentence(best.reason), suggestion: best.suggestion ?? null }
}

/** Every URL in a piece of text, `ws(s)://` first, trailing punctuation dropped. */
function urlsIn(text: string): string[] {
  const found = [...text.matchAll(/\b(wss?|https?):\/\/[^\s"'<>)\]]+/gi)].map((match) =>
    match[0].replace(/[.,;:!?]+$/, '')
  )
  return [...found.filter((url) => /^wss?:/i.test(url)), ...found.filter((url) => !/^wss?:/i.test(url))]
}

export type OriginDraftCheck =
  | { state: 'empty' }
  | {
      state: 'ok'
      /** What git will be given, which for a path is the normalised spelling. */
      url: string
      kind: OriginKind
      /** What a teammate has to match for a path, null for a URL. Carried here so the invitation and the runtime say the same. */
      note: string | null
    }
  | { state: 'bad'; reason: string }

/**
 * The origin field's verdict before git runs, on the shared `checkOrigin`
 * grammar: `~/shared/app.git` cannot be an identity and `/Volumes/team/app.git` can.
 */
export function checkOriginDraft(raw: string): OriginDraftCheck {
  if (raw.trim() === '') return { state: 'empty' }
  const checked = checkOrigin(raw)
  if (!checked.ok) return { state: 'bad', reason: sentence(checked.reason) }
  return {
    state: 'ok',
    url: checked.remote,
    kind: checked.kind,
    note: checked.kind === 'path' ? pathIdentityNote(checked.remote) : null
  }
}

/** What each kind of origin has to agree about, behind the disclosure beside the field. */
export const ORIGIN_DETAIL =
  'Origins are compared after normalising: scheme, port and a trailing .git are ignored. A path origin is compared ' +
  'literally, so both Macs must mount it at the same path.'

/** The label on the button that copies the invitation. Named so a test can find it. */
export const COPY_INVITE_BUTTON = 'Copy the invitation'

/**
 * The message to send a teammate. Push access is membership, so the protocol
 * has no invitation — which is why this is needed. Null with no origin to clone;
 * a path origin carries the mount condition the protocol cannot check.
 */
export function inviteText(input: {
  originUrl: string | null
  relayUrl: string | null
  projectName: string
  handle: string | null
}): string | null {
  if (input.originUrl === null) return null
  const origin = checkOrigin(input.originUrl)
  const mount = origin.ok && origin.kind === 'path' ? ['', `Mount the repository at exactly ${origin.remote}.`] : []
  const who = input.handle === null ? 'I' : `I (${input.handle})`
  const relay =
    input.relayUrl === null
      ? 'The relay is not in the repository yet — I will push it, and you will get it by pulling.'
      : `The relay is in the repository at .teamree/relay (${input.relayUrl}).`
  return [
    `${who} have set up teamwork on ${input.projectName} in teamree. Push access is membership — nothing to accept.`,
    '',
    // Quoted only when it has to be, which for a URL is never and for a volume
    // called "Team Share" is the difference between a command and two commands.
    `1. Clone it if you have not: git clone ${shellPath(input.originUrl)}`,
    // Whose word the URL is on: read off `origin`, and nothing here has tried to clone it.
    '   (That is this checkout’s origin as git has it; teamree has not checked that it clones.)',
    '2. Open teamree on your Mac and add that checkout as a project.',
    '3. Press Teamwork in the project header, choose “Join a team I was invited to”, and press Add my key.',
    '4. Press Commit and push. That is what puts you on the team.',
    ...mount,
    '',
    relay,
    '',
    'Anyone on the roster can type into any pane on your machine, as you.'
  ].join('\n')
}

/** One thing that is either true or not at the end of setup. */
export type SetupFact = {
  label: string
  /** `unknown` is reserved for the push, which teamree genuinely cannot check. */
  state: 'yes' | 'no' | 'unknown'
  detail: string
}

/** Where this ended up, in four facts. Half-working is the normal outcome, so four verdicts rather than one tick. */
export type SetupOutcome = {
  /** The sentence at the top. Never "done" unless every fact agrees. */
  head: string
  done: boolean
  facts: SetupFact[]
  /** The one thing left to do, or null when there is nothing. */
  next: string | null
}

export function setupOutcome(
  input: StartTeamworkInput & { publish?: TeamworkPublish | undefined }
): SetupOutcome | null {
  const { list, relay, status, publish } = input
  if (list === undefined || relay === undefined) return null

  const others = list.members.filter((member) => !member.isSelf)
  // A status teamwork has not read yet has no links to count, and counting none
  // is right: this fact says who is connected, and nobody is known to be.
  const connected = teamworkFacts(status)?.links.filter((link) => link.phase === 'connected') ?? []
  const pushed: SetupFact['state'] = publish === undefined ? 'unknown' : publish.push.ok ? 'yes' : 'no'

  const facts: SetupFact[] = [
    {
      label: 'Your key',
      state: list.enrolled ? 'yes' : 'no',
      detail: list.enrolled ? `${selfFileOf(list) ?? list.selfFile} is in this checkout.` : 'Not in this checkout yet.'
    },
    {
      label: 'The relay',
      state: relay.url === null ? 'no' : 'yes',
      detail:
        relay.url === null
          ? // The runtime's reason first: a broken override leaves the file fine, so
            // `onDisk.problem` alone put a false sentence on screen and in the sidebar.
            sentence(relay.problem ?? relay.onDisk.problem ?? `${relay.file} does not name a relay`)
          : `${relay.url}, from ${relay.source === 'environment' ? relay.override.name : relay.file}.`
    },
    {
      label: 'Pushed',
      state: pushed,
      detail:
        publish === undefined
          ? 'teamree has not pushed from here. Check with git status.'
          : publish.push.ok
            ? `${publish.branch} is on ${publish.remote}.`
            : // "Refused" is the remote's verdict; a stopped or unfinished push is not.
              `${
                publish.push.kind === 'cancelled'
                  ? 'You stopped the push.'
                  : publish.push.kind === 'timeout'
                    ? 'The push never finished.'
                    : 'The push was refused.'
              } ${publish.push.advice}`
    },
    {
      label: 'Connected',
      state: connected.length > 0 ? 'yes' : 'no',
      detail:
        connected.length > 0
          ? `${namesOf(connected)} ${connected.length === 1 ? 'is' : 'are'} connected.`
          : others.length === 0
            ? 'Nobody but you on the roster.'
            : `${namesOfMembers(others)} ${others.length === 1 ? 'is' : 'are'} on the roster and not connected.`
    }
  ]

  const done = facts.every((fact) => fact.state === 'yes')
  // Only the first three are this machine's to finish; "Connected" is about somebody else's laptop.
  const stalled = facts.filter((fact) => fact.label !== 'Connected').find((fact) => fact.state === 'no')
  return {
    done,
    facts,
    head: done
      ? 'Teamwork is working in this repository.'
      : publish !== undefined && !publish.push.ok && publish.commit !== null
        ? 'Committed here; the push did not land.'
        : stalled === undefined
          ? 'Done here. Waiting on a teammate.'
          : `Not finished: ${stalled.label.toLowerCase()}.`,
    next: done ? null : nextStepFor(stalled)
  }
}

/** The single thing to do next, from the first fact of this machine's that is not true. */
function nextStepFor(stalled: SetupFact | undefined): string | null {
  switch (stalled?.label) {
    case 'Your key':
      return `Step 2 writes it: ${ADD_KEY_BUTTON}.`
    case 'The relay':
      return 'Step 3 is where a relay is chosen or pasted in.'
    case 'Pushed':
      return `Step 4 sends it: ${PUBLISH_BUTTON}.`
    default:
      return null
  }
}

/** The two jobs, in the words the choice is offered in. */
export const TEAMWORK_PATHS = [
  { id: 'start', title: 'Start a team here' },
  { id: 'join', title: 'Join a team I was invited to' }
] as const satisfies readonly { id: TeamworkPath; title: string }[]

/**
 * Which of the two this repository looks like, and the evidence (`because`, null
 * when there is none). Offered, not applied: a guess about intent stays a guess.
 */
export function suggestedPath(
  list: MemberList | undefined,
  relay: RelaySetting | undefined
): { id: TeamworkPath; because: string | null } | null {
  if (list === undefined || relay === undefined) return null
  const others = list.members.filter((member) => !member.isSelf)
  if (relay.onDisk.url !== null && others.length > 0) {
    return {
      id: 'join',
      because: `${relay.file} and ${namesOfMembers(others)}’s key are already in this checkout.`
    }
  }
  if (relay.onDisk.url !== null) {
    return { id: 'join', because: `${relay.file} is already in this checkout.` }
  }
  if (others.length > 0) {
    return {
      id: 'join',
      because: `${namesOfMembers(others)} ${others.length === 1 ? 'is' : 'are'} already on the roster.`
    }
  }
  // Nothing to name: the absence of both is not worth a line under "Start a team here".
  return { id: 'start', because: null }
}

type StepCore = StartTeamworkStep

export function startTeamworkFlow(input: StartTeamworkInput): StartTeamworkFlow {
  const steps = [identityStep(input), keyStep(input), relayStep(input), pushStep(input), connectedStep(input)]
  // `unchecked` is deliberately not settled: the push step never self-completes
  // and is the one to lead with for as long as anything is written.
  const current = steps.find((step) => step.mark !== 'done' && step.mark !== 'this-run')
  // No blocker while the origin is unknown: an unread project is not a checkout that cannot take part.
  const origin = teamworkFacts(input.status)?.origin
  return {
    steps,
    currentId: current?.id ?? null,
    blocker: origin && !origin.ok ? originBlocker(origin.reason) : null
  }
}

/** Whose file this installation's key is in, when it is in one. */
export function selfFileOf(list: MemberList): string | undefined {
  return list.members.find((member) => member.isSelf)?.file
}

/** Where member keys live, relative to the checkout root. */
const MEMBERS_DIR = '.teamree/members'

/** The file the join button will write, sanitised the way the runtime names it. Null when there is no name. */
export function memberFilePreview(list: MemberList, typed: string): string | null {
  const name = typed.trim() === '' ? (list.self.handle ?? undefined) : sanitiseHandle(typed)
  return name === undefined ? null : `${MEMBERS_DIR}/${name}.pub`
}

/** Enough of a key to compare two of them by eye. Never enough to type one. */
export function shortKey(publicKey: string): string {
  return `${publicKey.slice(0, 16)}…`
}

function identityStep({ list, failedReads }: StartTeamworkInput): StepCore {
  const title = 'Your identity'
  if (list === undefined) {
    if (failedReads?.list !== undefined) {
      return {
        id: 'identity',
        title,
        mark: 'blocked',
        summary: readFailure('This machine’s identity', failedReads.list)
      }
    }
    return { id: 'identity', title, mark: 'todo', summary: 'Reading this machine’s identity…' }
  }
  // The keypair is made on first run, so this is only ever shown. A missing handle is step two's problem.
  const named = list.self.handle === null ? ' No handle yet: git has no user.email in this checkout.' : ''
  return {
    id: 'identity',
    title,
    mark: 'done',
    summary: `X25519 keypair, made on first run. The private half never leaves this machine.${named}`
  }
}

function keyStep({ list, failedReads }: StartTeamworkInput): StepCore {
  const title = 'Your key is in this repository'
  if (list === undefined) {
    if (failedReads?.list !== undefined) {
      return {
        id: 'key',
        title,
        mark: 'blocked',
        summary: readFailure('The roster', failedReads.list)
      }
    }
    return { id: 'key', title, mark: 'todo', summary: 'Waiting for the roster.' }
  }
  if (list.enrolled) {
    const file = selfFileOf(list) ?? list.selfFile
    return {
      id: 'key',
      title,
      mark: 'done',
      summary: `Your key is in this checkout${file === null ? '' : ` as ${file}`}. Step 4 pushes it.`
    }
  }
  return {
    id: 'key',
    title,
    mark: 'todo',
    summary: 'Your key is not in this checkout.'
  }
}

function relayStep({ relay, failedReads }: StartTeamworkInput): StepCore {
  const title = 'The team’s relay'
  if (relay === undefined) {
    if (failedReads?.relay !== undefined) {
      return {
        id: 'relay',
        title,
        mark: 'blocked',
        summary: readFailure('Where this project’s relay is recorded', failedReads.relay)
      }
    }
    return { id: 'relay', title, mark: 'todo', summary: 'Reading where this project’s relay is recorded…' }
  }
  // A broken override takes the relay away while the file still names one. The
  // file is not what is wrong, so the mark is `blocked` with the runtime's own reason.
  const overridden = brokenRelayOverride(relay)
  if (overridden !== null) {
    return { id: 'relay', title, mark: 'blocked', summary: sentence(relay.problem ?? overridden) }
  }
  if (relay.onDisk.url !== null) {
    // The file in the working tree, so this says what step 2 says about the key: step 4 pushes it.
    return {
      id: 'relay',
      title,
      mark: 'done',
      summary: `${relay.file} names ${relay.onDisk.url}. Step 4 pushes it.`
    }
  }
  if (relay.source === 'environment' && relay.url !== null) {
    // Done for this run and never done: the tunnel option tells people to use
    // the override, so the caveat is the summary rather than the mark.
    return {
      id: 'relay',
      title,
      mark: 'this-run',
      summary: `${relay.override.name} points this run at ${relay.url}; ${relay.file} is empty, so a teammate reads nothing.`
    }
  }
  return {
    id: 'relay',
    title,
    mark: 'todo',
    summary: sentence(relay.onDisk.problem ?? `${relay.file} does not name a relay`)
  }
}

function pushStep(input: StartTeamworkInput): StepCore {
  const title = 'Commit and push'
  // No path: the commands with the `cd` are rendered by the panel that knows where the checkout is.
  const plan = pushPlan(input.list, input.relay, undefined)
  if (plan === null) {
    return { id: 'push', title, mark: 'todo', summary: 'Nothing to commit yet — the steps above write the files.' }
  }
  return {
    id: 'push',
    title,
    mark: 'unchecked',
    summary: `${listOf(plan.files)} ${plan.files.length === 1 ? 'is' : 'are'} in this checkout, unpushed.`
  }
}

function connectedStep(input: StartTeamworkInput): StepCore {
  const title = 'Connected'
  const { status } = input
  if (status === undefined) {
    if (input.failedReads?.status !== undefined) {
      return {
        id: 'connected',
        title,
        mark: 'blocked',
        summary: readFailure('Whether teamwork is running here', input.failedReads.status)
      }
    }
    return { id: 'connected', title, mark: 'todo', summary: 'Reading whether teamwork is running here…' }
  }

  // The runtime answered that it has not read this project yet. Not the sentence
  // above: that is this panel waiting on a call, this is the facts not being in.
  if (status.state === 'unread') {
    return {
      id: 'connected',
      title,
      mark: 'todo',
      summary: 'teamree has not read this project’s relay, roster or origin yet.'
    }
  }

  const connected = status.links.filter((link) => link.phase === 'connected')
  if (connected.length > 0) {
    const away = status.links.length - connected.length
    return {
      id: 'connected',
      title,
      mark: 'done',
      summary: `${namesOf(connected)} ${connected.length === 1 ? 'is' : 'are'} connected.${
        away === 0 ? '' : ` ${away} other${away === 1 ? '' : 's'} on the roster ${away === 1 ? 'is' : 'are'} not.`
      }`
    }
  }
  if (!status.origin.ok) {
    return { id: 'connected', title, mark: 'blocked', summary: originBlocker(status.origin.reason) }
  }
  // Ahead of every phase about somebody else's machine: a key not on this roster
  // leaves the links at `waiting` and every phrase below blames the wrong machine.
  // Not ahead of `connected`, because a link that is up outranks any roster.
  if (!status.enrolled) {
    return {
      id: 'connected',
      title,
      mark: 'blocked',
      summary: 'Your own key is not in .teamree/members in this checkout.'
    }
  }
  if (status.links.length === 0) {
    // The roster is read from disk on demand; the links are replaced at the end
    // of a reconcile and can be missing because one threw. Prefer the roster.
    const others = input.list?.members.filter((member) => !member.isSelf) ?? []
    if (others.length > 0) {
      return {
        id: 'connected',
        title,
        mark: 'todo',
        summary:
          `${namesOfMembers(others)} ${others.length === 1 ? 'is' : 'are'} on the roster; no link open yet.` +
          mountMismatchNote(status)
      }
    }
    const ready = input.list?.enrolled === true && input.relay?.url != null
    return {
      id: 'connected',
      title,
      mark: 'todo',
      summary: ready ? 'Nobody but you on the roster.' : 'Nothing to connect to yet.'
    }
  }

  const refused = status.links.filter((link) => link.phase === 'refused')
  if (refused.length > 0) {
    return {
      id: 'connected',
      title,
      mark: 'todo',
      summary: `The handshake with ${namesOf(refused)} did not complete. Pull, and ask them to pull.`
    }
  }
  const unreachable = status.links.filter((link) => link.phase === 'unreachable')
  if (unreachable.length > 0) {
    return {
      id: 'connected',
      title,
      mark: 'todo',
      summary: `This machine cannot reach ${relayLabel(status)}.`
    }
  }
  return {
    id: 'connected',
    title,
    mark: 'todo',
    summary: `${relayLabel(status)} is reachable; no teammate is on it yet.${mountMismatchNote(status)}`
  }
}

/**
 * The one path-origin failure that looks like nothing: two machines hashing
 * different project keys never look for each other. Undetectable, so said out loud.
 */
function mountMismatchNote(status: TeamworkRead): string {
  if (!status.origin.ok) return ''
  const origin = checkOrigin(status.origin.url)
  if (!origin.ok || origin.kind !== 'path') return ''
  return ` A teammate whose Mac mounts this repository anywhere but ${origin.remote} will never appear here.`
}

/** Why a checkout with no usable `origin` cannot take part. Detail is in `ORIGIN_DETAIL`. */
function originBlocker(reason: string): string {
  return sentence(reason)
}

function relayLabel(status: TeamworkRead): string {
  if (!status.relay) return 'The relay'
  return status.relay.source === 'environment'
    ? `${status.relay.url} (from the environment)`
    : `${status.relay.url} (from .teamree/relay)`
}

function namesOf(links: PeerLink[]): string {
  return listOf(links.map((link) => link.handle))
}

function namesOfMembers(members: Member[]): string {
  return listOf(members.map((member) => member.handle))
}

/** A read that threw, with the runtime's message kept whole — not "Reading…" for ever. */
function readFailure(what: string, error: string): string {
  return `${what} could not be read: ${sentence(error)}`
}

function listOf(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** The runtime's reasons are clause-shaped. Panels speak in sentences. */
function sentence(text: string): string {
  const trimmed = text.trim()
  if (trimmed === '') return trimmed
  const capitalised = trimmed[0]!.toUpperCase() + trimmed.slice(1)
  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`
}
