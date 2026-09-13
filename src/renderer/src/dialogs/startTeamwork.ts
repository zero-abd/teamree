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
// **It does not claim the push happened.** teamree writes files and stops, and
// nothing in the window can see whether a commit exists, so step four is marked
// as unchecked rather than guessed at. A tick there would be the app claiming
// the one act it has refused to perform.
//
// **It does not fold "no origin" into "no relay".** The runtime's
// `disabledReason` names the first thing to fix, which for a bare project is
// the relay — but a checkout with no origin cannot take part whatever relay is
// set, because the project's identity is a hash of the normalised origin. That
// is why `TeamworkStatus` reports the two separately and why this reads both.

import type { Member, MemberList, PeerLink, RelaySetting, TeamworkStatus } from '@shared/entities'
import { sanitiseHandle } from '@shared/handle'
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
    'That is deliberate and it is the feature: a teammate who can see your agent stuck on a question can type ' +
    'the answer into it. But be exact about what it means — anyone on this roster can type into any pane here, ' +
    'and typing into a pane is running arbitrary commands as you.',
  mitigations: [
    'A pane that is being watched says so, and by whom.',
    'Typing is attributed live: the pane names who is typing while they type.',
    'Every remote write is recorded on this machine, with who and when.',
    'Mute is instant, per-pane, and yours — not a negotiation.'
  ],
  close: 'Add the keys of people you would hand an unlocked laptop to, because that is what you are doing.'
} as const

/** The one line about who chooses a relay, for whoever has not got one. */
export const RELAY_LEAD =
  'If somebody on your team has already stood a relay up, you do not choose: git pull, and it arrives in ' +
  '.teamree/relay. This list is for whoever is standing one up. teamree never starts a relay itself — it dials ' +
  'a URL, and standing one up happens in a terminal.'

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

export type RelayOption = {
  id: 'worker' | 'tunnel' | 'mesh' | 'vps'
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
 * The four ways a team actually gets a relay, with what each costs.
 *
 * Presented rather than defaulted. A bare URL field assumes the person already
 * knows what to paste, and the one thing that is certainly true of somebody
 * opening this panel for the first time is that they do not. The facts are
 * `relay/README.md`'s; this is that document's decision table with the part
 * teamree cares about — whether the address is stable enough to commit — made
 * explicit.
 */
export const RELAY_OPTIONS: readonly RelayOption[] = [
  {
    id: 'worker',
    name: 'Deploy the Worker to your team’s own Cloudflare account',
    what:
      'Start here unless you have a reason not to. It is one command, there is nothing to babysit, and it works ' +
      'from anywhere because both machines dial out to it.',
    commands: 'cd relay\nnpm install\nnpx wrangler login\nnpm run deploy',
    effort: 'One command, once. Needs a Cloudflare account; nothing to configure and no resource ids to fill in.',
    money:
      'Durable Objects have been on the Workers free plan since 7 April 2025 for classes on the SQLite backend, ' +
      'which this relay’s wrangler.jsonc already declares — so a small team is very likely free. relay/README.md ' +
      'is explicit that it has not re-verified today’s exact free-tier figures: read them on Cloudflare’s Durable ' +
      'Objects pricing page before a large team lives in this all day.',
    keep: 'commit',
    address:
      'Wrangler prints https://teamree-relay.<your-subdomain>.workers.dev. The relay is that host with /v1/relay ' +
      'on it, spoken as wss://. Paste what it printed below and teamree will show you the corrected URL.'
  },
  {
    id: 'tunnel',
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
      'The tunnel prints an https:// URL, and it is ephemeral: it changes every time the tunnel restarts and dies ' +
      'with it. Do not commit it. Set TEAMREE_RELAY_URL to the wss:// form, on both machines, in the terminal each ' +
      'one starts teamree from — an app opened from Finder or the dock inherits no shell environment.'
  },
  {
    id: 'mesh',
    name: 'A mesh VPN, or a box on the LAN',
    what:
      'Run the container on any machine the others can already reach — one office network, or Tailscale or ' +
      'WireGuard. Nothing is exposed publicly. Good if your team already has the network.',
    commands:
      'cd relay\ndocker build -t teamree-relay .\ndocker run -d -p 8787:8787 --restart unless-stopped teamree-relay',
    effort:
      'Minutes if the network already exists. If it does not, the network is the work, and a relay on a laptop ' +
      're-inherits the NAT problem a relay exists to solve.',
    money: 'Whatever the box costs, which is usually nothing you are not already paying.',
    keep: 'commit',
    address: 'ws://<that machine>:8787/v1/relay, or wss:// once something is terminating TLS in front of it.'
  },
  {
    id: 'vps',
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
 */
export function pushPlan(list: MemberList | undefined, relay: RelaySetting | undefined): PushPlan | null {
  const mine = list?.enrolled ? (selfFileOf(list) ?? null) : null
  const theirs = relay?.committed.url ? relay.file : null
  const files = [mine, theirs].filter((file): file is string => file !== null)
  if (files.length === 0) return null

  const message = mine === null ? 'Meet on our relay' : theirs === null ? 'Add my key to the team' : 'Set up teamwork'
  return { files, commands: `git add .teamree\ngit commit -m "${message}"\ngit push` }
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
  if (relay.committed.url !== null) {
    return {
      id: 'relay',
      title,
      mark: 'done',
      summary: `${relay.file} names ${relay.committed.url}. Everyone who pulls it meets there.`
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
    summary: sentence(relay.committed.problem ?? `${relay.file} does not name a relay`)
  }
}

function pushStep(input: StartTeamworkInput): StartTeamworkStep {
  const title = 'Commit and push'
  const plan = pushPlan(input.list, input.relay)
  if (plan === null) {
    return { id: 'push', title, mark: 'todo', summary: 'Nothing to commit yet — the steps above write the files.' }
  }
  return {
    id: 'push',
    title,
    mark: 'unchecked',
    summary:
      `${listOf(plan.files)} ${plan.files.length === 1 ? 'is' : 'are'} in this checkout. teamree does not check ` +
      'whether you have committed them and will not push for you: being able to push that file is the whole of ' +
      'what membership means.'
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
        'Your own key is not in .teamree/members in this checkout, so no teammate can reach this machine: their ' +
        'machines have nothing to address, and every link here is waiting on a rendezvous they cannot compute. ' +
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
          `${others.length === 1 ? 'them' : 'any of them'} is open yet. teamree opens one per teammate as it reads ` +
          'the roster; if this does not change in a moment, the reason it stopped is in this run’s log.'
      }
    }
    const ready = input.list?.enrolled === true && input.relay?.url != null
    return {
      id: 'connected',
      title,
      mark: 'todo',
      summary: ready
        ? 'This project’s roster has nobody in it but you. A teammate appears here once they push their key and ' +
          'you pull it — nothing on this machine can know they meant to.'
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
        `Somebody answered on ${namesOf(refused)}’s rendezvous and did not authenticate against the key in this ` +
        'repository. This is the one here worth reading in full.'
    }
  }
  const unreachable = status.links.filter((link) => link.phase === 'unreachable')
  if (unreachable.length > 0) {
    return {
      id: 'connected',
      title,
      mark: 'todo',
      summary: `This machine cannot reach ${relayLabel(status)}. Your teammates may be perfectly fine.`
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
 * Why a checkout with no usable `origin` cannot take part, and the one thing to
 * do about it.
 *
 * The runtime's reason says what is wrong. It does not say what to type, and a
 * person reading "teamree cannot tell it is the same repository your teammates
 * have" reasonably tries a path on their disk next — which is the other half of
 * this failure, because the identity is a hash of the normalised remote and a
 * path is not one.
 */
function originBlocker(reason: string): string {
  return (
    `${sentence(reason)} Add the remote you and your teammates both cloned — git remote add origin <url> — and ` +
    'note that it has to be that URL rather than a path on this disk: two checkouts are the same project when ' +
    'the hash of their normalised origin matches, and a filesystem path is not a URL. ssh against https, a port ' +
    'or a trailing .git are all normalised away, so you need not match each other exactly.'
  )
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
