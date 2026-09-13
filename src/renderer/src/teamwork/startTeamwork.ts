// Where a project is in setting teamwork up, and what the next thing is.
//
// Everything here was already possible: generate a key, write it into
// `.teamree/members`, put a relay URL in `.teamree/relay`, commit both, push,
// wait. What was missing was one place that says which of those has happened.
// So this file is a reading of three answers the runtime already gives —
// `members.list`, `teamwork.relay` and `teamwork.status` — as five steps, each
// either true or not, and it holds no state of its own.
//
// Two things it deliberately will not do:
//
// **It does not claim the push happened by itself.** The panel can now make
// that commit and send it, on a button that says what it will do first — but
// until somebody presses it, nothing in the window can see whether the files
// are in the repository, so step four is marked as unchecked rather than
// guessed at. A tick there would be the app claiming an act nobody performed.
//
// **It does not fold "no origin" into "no relay".** The runtime's
// `disabledReason` names the first thing to fix, which for a bare project is
// the relay — but a checkout with no origin cannot take part whatever relay is
// set, because the project's identity is a hash of the normalised origin. That
// is why `TeamworkStatus` reports the two separately and why this reads both.

import type {
  Member,
  MemberList,
  PeerLink,
  RelaySetting,
  TeamworkPublish,
  TeamworkPublishPlan,
  TeamworkStatus
} from '@shared/entities'
import { sanitiseHandle } from '@shared/handle'
import { checkOriginUrl } from '@shared/originUrl'
import { parseRelayUrl } from '@shared/relayUrl'

export type StepId = 'identity' | 'key' | 'relay' | 'push' | 'connected'

export type StepMark =
  /** Checked, and true. */
  | 'done'
  /**
   * True for this run and not written down anywhere a teammate reads. The
   * environment override is the whole of this case: the panel's own tunnel
   * option tells people to use it, so calling it unfinished work parks the flow
   * on that step for the session.
   */
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
  /**
   * The step to lead with: the first that is not done. Null once every step
   * teamree can check is.
   */
  currentId: StepId | null
  /**
   * A fact about this checkout that stops teamwork however much of the rest is
   * done, or null. Shown at the top, because a person who works through four
   * steps and only then learns the fifth was impossible has been wasted.
   */
  blocker: string | null
}

/**
 * Why each of the three reads behind this panel last failed, for the ones that
 * did.
 *
 * A read that threw and a read still in flight both leave the answer
 * `undefined`, and they are not the same thing to say: one is "wait a moment"
 * and the other is "this will never arrive". Without this the panel said the
 * first about the second for the life of the window.
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
}

/**
 * The label on the button that writes this machine's key into the repository.
 *
 * A constant because the sidebar names it from a long way away: the header's
 * "Your key is not here" tooltip tells somebody which button to press, and a
 * tooltip naming a button that has since been renamed is the failure this
 * whole file exists to avoid being on the other end of.
 */
export const ADD_KEY_BUTTON = 'Add my key'

/**
 * What adding a key to `.teamree/members/` actually grants, said before the
 * button that adds one and not in a footnote.
 *
 * `docs/teamwork.md` is explicit that this is remote code execution by design,
 * and equally explicit that what makes it survivable is not a permission model
 * — which would be a lie at this granularity — but that none of it can be done
 * invisibly. Both halves are here. The warning without the mitigations reads as
 * "do not use this feature"; the mitigations without the warning are a sales
 * pitch.
 */
export const KEY_GRANT_WARNING = {
  head: 'A key in .teamree/members/ can run commands on this machine, as you.',
  body:
    'That is the feature: a teammate who can see your agent stuck on a question can type the answer into it. ' +
    'Anyone on this roster can type into any pane here, and typing into a pane is running arbitrary commands ' +
    'as you.',
  mitigations: [
    'A pane that is being watched says so, and by whom.',
    'Typing is attributed live: the pane names who is typing while they type.',
    'Every remote write is recorded on this machine, with who and when.',
    'Mute is instant, per-pane, and yours — not a negotiation.'
  ],
  close: 'Add the keys of people you would hand an unlocked laptop to, because that is what you are doing.'
} as const

/**
 * Who does this at all, said once above the button.
 *
 * Everything else that used to be here — which options exist, what a Durable
 * Object costs, why `cd relay` is wrong inside an installed app — is either the
 * button's own job now or `relay/README.md`'s. The panel was several paragraphs
 * deep before a reader reached anything they could press, and that was the
 * complaint.
 */
export const RELAY_LEAD =
  'Only whoever is standing the relay up does this. Everybody else pulls, and the URL arrives in .teamree/relay.'

/**
 * The deploy, in the fewest words that are still true.
 *
 * It is a button now, and the button runs the command in a pane in this window
 * rather than handing it over to be pasted into Terminal.app. Two facts belong
 * beside it and nothing else does: whose account it goes to, and that a browser
 * opens the first time. `relay/README.md` has the rest — what it costs, what a
 * Durable Object is, and every other way to get a relay.
 */
export const RELAY_DEPLOY = {
  button: 'Deploy a relay',
  what: 'One command, to your team’s own Cloudflare account. teamree hosts nothing and runs nothing for you.',
  browser: 'A browser opens once, for the Cloudflare sign-in. Nothing is deployed until you are signed in.',
  /** Said while it runs, because somebody watching a pane deserves to know what finishing looks like. */
  watching: 'It prints a wss:// URL when it finishes, and teamree offers to write that into the repository.',
  /** The label on the button that takes the URL the deploy printed. */
  use: 'Use this relay URL',
  /** Above the command itself, kept for anybody who would rather run it themselves. */
  manual: 'Or run it yourself:'
} as const

/**
 * The label on the disclosure that holds the options nobody should have to read.
 *
 * A constant because the panel and its test both name it, and a disclosure
 * whose label drifts is a disclosure nobody can be told to open.
 */
export const MORE_RELAYS_BUTTON = 'Other ways to get a relay'

/** Said once, above the folded options, so opening it is an informed choice. */
export const MORE_RELAYS_LEAD =
  'These are for a team that already has the network, the server, or a reason not to add a Cloudflare account. ' +
  'Each needs a clone of the teamree repository, because the Dockerfile is in one.'

/**
 * Where the resulting URL belongs, which is the part of this decision that is
 * actually teamree's business.
 *
 * A relay with a stable address is a team-wide fact and goes in the repository.
 * An ephemeral one is not a fact about the team at all — it is gone tomorrow —
 * and committing it would leave the next person reading a dead URL out of a
 * diff. That is the whole reason `TEAMREE_RELAY_URL` exists.
 */
export type RelayKeep = 'commit' | 'override'

/**
 * How prominent an option is.
 *
 * There is no `lead` any more, because the lead is a button: the Worker deploy
 * ships inside teamree and this panel runs it, so listing it again as one of
 * four equals would be the wall of choices all over again. What is left is
 * genuinely "other ways", folded away, with the one worth trying this afternoon
 * first.
 */
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

/**
 * Every other way a team gets a relay, in the order somebody should meet them.
 *
 * The facts are `relay/README.md`'s; this is that document's decision table
 * with the part teamree cares about — whether the address is stable enough to
 * commit — made explicit. It is shorter than it was because the option that
 * needed the most explaining is now a button, and because a panel is not the
 * place to re-state a README.
 */
export const RELAY_OPTIONS: readonly RelayOption[] = [
  {
    id: 'tunnel',
    tier: 'fallback',
    name: 'A tunnel to a relay on your own machine',
    what:
      'The fastest way to try this with somebody on another continent. Run the container here and put a tunnel in ' +
      'front of it; no account, and a public URL in seconds.',
    commands:
      'cd relay\ndocker build -t teamree-relay .\ndocker run -d -p 8787:8787 teamree-relay\n' +
      'cloudflared tunnel --url http://localhost:8787',
    effort: 'A couple of minutes, and nothing to sign up for.',
    money: 'Free, and up only for as long as the tunnel and this machine are.',
    keep: 'override',
    address:
      'The tunnel prints an ephemeral https:// URL that dies with it. Do not commit it: set TEAMREE_RELAY_URL to ' +
      'the wss:// form on both machines instead.'
  },
  {
    id: 'mesh',
    tier: 'more',
    name: 'A mesh VPN, or a box on the LAN',
    what:
      'Run the container on any machine the others can already reach — one office network, or Tailscale or ' +
      'WireGuard. Nothing is exposed publicly. Good if your team already has the network.',
    commands:
      'cd relay\ndocker build -t teamree-relay .\ndocker run -d -p 8787:8787 --restart unless-stopped teamree-relay',
    effort: 'Minutes if the network already exists. If it does not, the network is the work.',
    money: 'Whatever the box costs, which is usually nothing you are not already paying.',
    keep: 'commit',
    address: 'ws://<that machine>:8787/v1/relay, or wss:// once something is terminating TLS in front of it.'
  },
  {
    id: 'vps',
    tier: 'more',
    name: 'A VPS you rent',
    what:
      'The container on a small server, a hostname pointed at it, and Caddy or nginx in front for TLS. Durable, ' +
      'and the only one of these that is real administration.',
    commands:
      'cd relay\ndocker build -t teamree-relay .\ndocker run -d -p 8787:8787 --restart unless-stopped teamree-relay\n' +
      '# then terminate TLS in front of it and forward the upgrade headers',
    effort: 'An afternoon, then a server to keep patched.',
    money: 'Whatever the server costs, every month.',
    keep: 'commit',
    address: 'wss://<your hostname>/v1/relay'
  }
] as const

/**
 * The `wss://` line a finished deploy printed, out of everything the pane has
 * said.
 *
 * The last one wins: a person who deploys twice in one pane means the second.
 * Read from the pane's own scrollback rather than from anything the deploy is
 * asked to report, because the deploy is a program in a terminal and this is
 * the only thing it hands back.
 */
export function relayUrlFromOutput(output: string): string | null {
  const found = [...output.matchAll(/wss:\/\/[^\s"'<>)\]]+/g)].map((match) => match[0])
  for (let index = found.length - 1; index >= 0; index -= 1) {
    const candidate = found[index]
    if (candidate === undefined) continue
    const parsed = parseRelayUrl(candidate)
    if (parsed.ok) return parsed.url
  }
  return null
}

/**
 * The words on the button that makes this the team's, and what it will do.
 *
 * Named here because the panel and its tests both have to agree about what it
 * is called: a button that pushes somebody's repository is not a control whose
 * label may drift out from under the documentation that tells people to use it.
 */
export const PUBLISH_BUTTON = 'Commit and push'

/** A relay deploy running in a pane in this window, as the panel needs to see it. */
export type RelayDeployState = {
  /** The pane the command is running in. */
  terminalId: string
  /** The wss:// URL the deploy printed, once it has printed one. */
  url: string | null
  /** False once the command has exited; the pane stays until it is closed. */
  running: boolean
}

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
}

/** What to commit, and the commands that do it. Null when nothing is written. */
export type PushPlan = {
  /** Paths relative to the project root, as a diff would show them. */
  files: string[]
  /** Ready to paste, and never run by this app. */
  commands: string
}

/**
 * The one step the app will not take, said once for both files it wrote.
 *
 * Two runbook steps told people to commit and push these separately. They are
 * one commit, and saying so here is the difference between a person doing it
 * and a person doing half of it.
 *
 * It also says where they run. teamree opens terminals inside worktrees and
 * `.teamree` is in the primary checkout, so the obvious way to run these —
 * paste them into the pane the panel just helped make — stages nothing and
 * blames git for it. The `cd` is the first line of the same block the commands
 * are in, so whatever is selected to copy them takes it too.
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

/**
 * A path a shell will take as one word, quoted only when it has to be.
 *
 * `~/My Projects/thing` is an ordinary place to keep a checkout on a Mac, and
 * an unquoted `cd` on it fails in a way that reads as the panel being wrong
 * about where the files are.
 */
function shellPath(path: string): string {
  return /^[\w./@%+:,-]+$/.test(path) ? path : `'${path.replaceAll("'", String.raw`'\''`)}'`
}

export type RelayDraftCheck =
  | { state: 'empty' }
  | { state: 'ok'; url: string }
  /** `suggestion` is the corrected URL, offered whenever one can be worked out. */
  | { state: 'bad'; reason: string; suggestion: string | null }

/**
 * The field's own verdict on what has been typed, before anything is written.
 *
 * The same grammar the runtime would refuse it with, so the answer cannot
 * differ — and reached while somebody is still typing, because the input
 * everybody arrives with is the `https://` address their deploy printed and
 * telling them a round trip later that it was wrong reads as the app being
 * broken rather than the address being incomplete.
 */
export function checkRelayDraft(raw: string): RelayDraftCheck {
  if (raw.trim() === '') return { state: 'empty' }
  const parsed = parseRelayUrl(raw)
  if (parsed.ok) return { state: 'ok', url: parsed.url }
  return { state: 'bad', reason: sentence(parsed.reason), suggestion: parsed.suggestion ?? null }
}

export type OriginDraftCheck = { state: 'empty' } | { state: 'ok'; url: string } | { state: 'bad'; reason: string }

/**
 * The origin field's own verdict, before git is run.
 *
 * The same grammar the runtime refuses with — `checkOriginUrl` is shared —
 * because the mistake everybody makes here is typing a path, and being told
 * that a round trip later reads as the button being broken rather than the
 * answer being the wrong kind of thing.
 */
export function checkOriginDraft(raw: string): OriginDraftCheck {
  if (raw.trim() === '') return { state: 'empty' }
  const checked = checkOriginUrl(raw)
  return checked.ok ? { state: 'ok', url: checked.url } : { state: 'bad', reason: sentence(checked.reason) }
}

/**
 * Why a path will not do, for the disclosure beside the field.
 *
 * It used to be three sentences in front of everybody who opened the panel,
 * including the ones whose origin was fine. It is the answer to one question —
 * "why did it refuse my directory?" — so it is where a question is asked.
 */
export const ORIGIN_DETAIL =
  'A path on this disk is not something your teammates can clone. Your URLs need not match each other exactly: ' +
  'ssh against https, a port and a trailing .git are all normalised away. docs/teamwork.md has the rest.'

export function startTeamworkFlow(input: StartTeamworkInput): StartTeamworkFlow {
  const steps = [identityStep(input), keyStep(input), relayStep(input), pushStep(input), connectedStep(input)]
  // `unchecked` is deliberately not settled: the push step never self-completes
  // and is the one to lead with for as long as anything is written.
  const current = steps.find((step) => step.mark !== 'done' && step.mark !== 'this-run')
  const origin = input.status?.origin
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

/**
 * The file the join button will write, named the way the runtime will name it.
 *
 * The field used to echo what was typed, so `Ada Lovelace` promised
 * `.teamree/members/Ada Lovelace.pub` and `ada-lovelace.pub` is what appeared.
 * Null when there is no name to promise: nothing typed and git has no email to
 * fall back on, or nothing in what was typed survives sanitising.
 */
export function memberFilePreview(list: MemberList, typed: string): string | null {
  const name = typed.trim() === '' ? (list.self.handle ?? undefined) : sanitiseHandle(typed)
  return name === undefined ? null : `${MEMBERS_DIR}/${name}.pub`
}

/** Enough of a key to compare two of them by eye. Never enough to type one. */
export function shortKey(publicKey: string): string {
  return `${publicKey.slice(0, 16)}…`
}

function identityStep({ list, failedReads }: StartTeamworkInput): StartTeamworkStep {
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
  // The keypair is made on first run, so this is never a thing to do — only a
  // thing to show. A missing handle is step two's problem: it is the name on
  // the file, not the identity, and the identity is the key.
  const named =
    list.self.handle === null
      ? ' It has no name here yet: git has no user.email in this checkout, so step 2 asks you for one.'
      : ''
  return {
    id: 'identity',
    title,
    mark: 'done',
    summary: `This machine generated an X25519 keypair on first run. The private half never leaves it.${named}`
  }
}

function keyStep({ list, failedReads }: StartTeamworkInput): StartTeamworkStep {
  const title = 'Your key is in this repository'
  if (list === undefined) {
    if (failedReads?.list !== undefined) {
      return {
        id: 'key',
        title,
        mark: 'blocked',
        summary: `${readFailure('The roster', failedReads.list)} Until it can be, nothing here can say whether your key is in it.`
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
      summary: `Your key is in this checkout${file === null ? '' : ` as ${file}`}. Step 4 is what makes it the team’s.`
    }
  }
  return {
    id: 'key',
    title,
    mark: 'todo',
    summary: 'Your key is not in this repository, so no teammate can reach this machine or name what it says.'
  }
}

function relayStep({ relay, failedReads }: StartTeamworkInput): StartTeamworkStep {
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
  if (relay.onDisk.url !== null) {
    // What is read is the file in the working tree, so this says the same thing
    // step 2 says about the key. "Everyone who pulls it meets there" described
    // a push that had not happened and that this panel cannot see.
    return {
      id: 'relay',
      title,
      mark: 'done',
      summary: `${relay.file} in this checkout names ${relay.onDisk.url}. Step 4 is what makes it the team’s.`
    }
  }
  if (relay.source === 'environment' && relay.url !== null) {
    // Done for this run, and never done: the override is what the tunnel option
    // above tells people to use, and a step that stays unfinished while the
    // recommended path is working is the panel disagreeing with itself. The
    // caveat that it is not committed setup is the summary rather than the mark.
    return {
      id: 'relay',
      title,
      mark: 'this-run',
      summary:
        `${relay.override.name} is pointing this run at ${relay.url}, and nothing is in ${relay.file}. ` +
        'The override is per-machine and dies with this process, so a teammate reads nothing — which is right for ' +
        'an ephemeral tunnel and wrong for anything you mean to keep.'
    }
  }
  return {
    id: 'relay',
    title,
    mark: 'todo',
    summary: sentence(relay.onDisk.problem ?? `${relay.file} does not name a relay`)
  }
}

function pushStep(input: StartTeamworkInput): StartTeamworkStep {
  const title = 'Commit and push'
  // No path: this reads the plan for the files it names, and the commands with
  // the `cd` in them are rendered beside the summary, by the panel that knows
  // where the checkout is.
  const plan = pushPlan(input.list, input.relay, undefined)
  if (plan === null) {
    return { id: 'push', title, mark: 'todo', summary: 'Nothing to commit yet — the steps above write the files.' }
  }
  return {
    id: 'push',
    title,
    mark: 'unchecked',
    summary:
      `${listOf(plan.files)} ${plan.files.length === 1 ? 'is' : 'are'} in this checkout and mean nothing to anybody ` +
      'else until they are pushed. teamree cannot see whether you have done that, so this step never ticks itself.'
  }
}

function connectedStep(input: StartTeamworkInput): StartTeamworkStep {
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

  const connected = status.links.filter((link) => link.phase === 'connected')
  if (connected.length > 0) {
    const away = status.links.length - connected.length
    return {
      id: 'connected',
      title,
      mark: 'done',
      summary:
        `${namesOf(connected)} ${connected.length === 1 ? 'is' : 'are'} connected, over a Noise session that ` +
        `authenticated against the key in this repository.${
          away === 0 ? '' : ` ${away} other${away === 1 ? '' : 's'} on the roster ${away === 1 ? 'is' : 'are'} not.`
        }`
    }
  }
  if (!status.origin.ok) {
    return { id: 'connected', title, mark: 'blocked', summary: originBlocker(status.origin.reason) }
  }
  // Ahead of every phase that is a sentence about somebody else's machine, for
  // the reason the sidebar header checks it there: a key that is not on this
  // roster means no teammate reading the repository can address this machine,
  // so the links sit at `waiting` and each phrase below blames the one machine
  // doing nothing wrong. It is not ahead of `connected` above, because a link
  // that is up is a fact about both machines and outranks what any roster says.
  if (!status.enrolled) {
    return {
      id: 'connected',
      title,
      mark: 'blocked',
      summary:
        'Your own key is not in .teamree/members in this checkout, so no teammate can reach this machine. ' +
        'Step 2 writes the file and step 4 is what puts it where they will read it.'
    }
  }
  if (status.links.length === 0) {
    // The roster is read from disk the moment it is asked for; the links are
    // replaced at the end of a reconcile, and can be missing because one threw.
    // Saying "nobody but you" directly above the roster that lists them was the
    // panel preferring the later of two answers it already had.
    const others = input.list?.members.filter((member) => !member.isSelf) ?? []
    if (others.length > 0) {
      return {
        id: 'connected',
        title,
        mark: 'todo',
        summary:
          `${namesOfMembers(others)} ${others.length === 1 ? 'is' : 'are'} on this project’s roster and no link to ` +
          `${others.length === 1 ? 'them' : 'any of them'} is open yet. If this does not change in a moment, the ` +
          'reason it stopped is in this run’s log.'
      }
    }
    const ready = input.list?.enrolled === true && input.relay?.url != null
    return {
      id: 'connected',
      title,
      mark: 'todo',
      summary: ready
        ? 'This project’s roster has nobody in it but you. A teammate appears here once they push their key and ' +
          'you pull it.'
        : 'Nothing to connect to yet. Finish the steps above, then commit and push.'
    }
  }

  const refused = status.links.filter((link) => link.phase === 'refused')
  if (refused.length > 0) {
    return {
      id: 'connected',
      title,
      mark: 'todo',
      summary:
        `The handshake with ${namesOf(refused)} did not complete. Either roster could be the stale one, so pull, ` +
        'and ask them to pull. The reason under that link is this machine’s own, not a report from theirs.'
    }
  }
  const unreachable = status.links.filter((link) => link.phase === 'unreachable')
  if (unreachable.length > 0) {
    return {
      id: 'connected',
      title,
      mark: 'todo',
      summary: `This machine cannot reach ${relayLabel(status)}. Your teammates may be fine.`
    }
  }
  return {
    id: 'connected',
    title,
    mark: 'todo',
    summary: `${relayLabel(status)} is reachable and no teammate’s machine is on it yet.`
  }
}

/**
 * Why a checkout with no usable `origin` cannot take part.
 *
 * One sentence, because the fix is now a field and a button directly under it
 * rather than a command to go and type somewhere else. Why a path will not do
 * is in `ORIGIN_DETAIL`, behind the disclosure beside that field, where it is
 * read by the people who need it and nobody else.
 */
function originBlocker(reason: string): string {
  return `${sentence(reason)} Add the URL you and your teammates both cloned — a URL, not a path on this disk.`
}

function relayLabel(status: TeamworkStatus): string {
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

/**
 * A read that threw, with the runtime's own message kept whole.
 *
 * The alternative the panel had was "Reading…" for ever, which is the same
 * sentence as "this is still loading" and the one thing certainly untrue after
 * a throw.
 */
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
