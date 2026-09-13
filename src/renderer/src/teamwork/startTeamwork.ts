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
//
// What it does do now, and did not, is say which *side* of this the reader is
// on. Teamwork is a two-sided protocol and the report that prompted this said
// the setup was confusing even though it worked — and the confusion was not in
// any one step. It was that the same five ticks describe two different jobs:
// one person stands a relay up and invites, the other pulls what is already
// there and answers. Half of what anybody needs to know is what the other end
// is waiting for, and nothing here used to say it. So every step now carries
// two more sentences — why it exists, and what a teammate sees while it is not
// done — and both of them read differently depending on which of the two
// things you are doing.

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
 * Which of the two things somebody is doing here.
 *
 * Not a role and not a permission — after setup these two are members of one
 * project with identical powers, exactly as `docs/teamwork.md` says. It is only
 * a statement about what is already in the repository and therefore about which
 * half of the work is left, and it exists because a panel that cannot tell them
 * apart has to write every sentence for both at once, which is how five clear
 * steps become a document.
 */
export type TeamworkPath = 'start' | 'join'

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
  /**
   * Why this step is in the list at all.
   *
   * Fixed for a given path rather than derived from state: it is the answer to
   * "why am I being asked for this", which does not change as the step goes
   * from undone to done, and a reader who understands the shape of the thing
   * stops needing the runbook.
   */
  why: string
  /**
   * What somebody on the other machine sees while this step is not done, or
   * null where there is honestly nothing to say.
   *
   * The single most useful sentence in the whole panel, because the failure
   * mode of a two-sided protocol is two people each waiting for the other and
   * neither knowing it.
   */
  otherSide: string | null
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
  /**
   * Which of the two jobs this is. Null before anybody has said, which is the
   * state the panel puts the choice in front of them in.
   */
  path?: TeamworkPath | null | undefined
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
 * and equally explicit about the two things that make it survivable: their
 * keystrokes wait for you, and none of it can be done invisibly. Both halves
 * are here, and so is the warning they sit under. The warning without the
 * mitigations reads as "do not use this feature"; the mitigations without the
 * warning are a sales pitch.
 *
 * The first mitigation is deliberately not written as a promise of safety. A
 * prompt catches a colleague's mistake, which is what nearly every bad
 * keystroke is; it does not catch somebody who should not be on the roster,
 * because allowing them is one click and after it they can run anything. Saying
 * otherwise here would be the sales pitch.
 */
export const KEY_GRANT_WARNING = {
  head: 'A key in .teamree/members/ can run commands on this machine, as you.',
  body:
    'That is the feature: a teammate who can see your agent stuck on a question can type the answer into it. ' +
    'Anyone on this roster can ask to type into any pane here, and typing into a pane is running arbitrary ' +
    'commands as you.',
  mitigations: [
    'Their keystrokes wait: you are shown who, which pane and what, and nothing runs until you allow it.',
    'You can allow once, for this session, or from now on in that pane — and lift it again whenever you like.',
    'A pane that is being watched says so, and by whom.',
    'Typing is attributed live: the pane names who is typing while they type.',
    'Every remote write is recorded on this machine, with who and when — including the ones you refused.',
    'Mute is instant, per-pane, and yours — not a negotiation.'
  ],
  close:
    'Being asked catches a mistake, not somebody you should not have added: once you allow them they can run ' +
    'anything. Add the keys of people you would hand an unlocked laptop to.'
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
  /**
   * What the running publish is doing, while it is still doing it.
   *
   * Undefined until one has run in this session. It is a separate read from
   * `result` on purpose: `result` is what the call eventually answered, and
   * this is the only thing there is to show for the minutes before it does.
   */
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

/**
 * How long git may say nothing before that silence is itself worth reporting.
 *
 * A push that is working talks: it counts objects, compresses them and writes
 * them, and even a small one prints within a second or two. A push that is
 * waiting for a credential prints nothing at all, ever, and used to go on
 * printing nothing for ten minutes. Half a minute is comfortably longer than
 * any gap a healthy push has and far short of the timeout, which makes it the
 * point at which "still going" stops being the most likely explanation.
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
  /**
   * What that silence probably means, once it has gone on long enough to mean
   * anything. Null while git is talking.
   */
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

/**
 * The running publish, read as one sentence and two numbers.
 *
 * This is the whole answer to "it gets stuck at git push". Every part of it was
 * being measured on the other side of an IPC call and none of it was being
 * asked for: what it is doing, how long it has been doing it, and whether
 * anything has happened lately.
 */
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

/**
 * A duration, for somebody watching a clock rather than reading a log.
 *
 * Seconds below a minute and never a decimal: this is read to answer "is this
 * taking an unreasonable time", and a number with a fractional part in it
 * invites a precision the question does not have.
 */
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
 * Whether trying the same thing again could possibly help.
 *
 * A rejection is the one failure retrying fixes, and only after a pull — so it
 * gets the button and a sentence saying what to do first. An authentication
 * refusal fixed by nothing in this window gets the button too, because a person
 * who has just run `ssh-add` in Terminal should not have to go anywhere else to
 * find out whether it worked. A timeout and a cancel are both "it never
 * finished", which is exactly what trying again is for.
 */
export function retryHint(kind: PushFailureKind): string | null {
  switch (kind) {
    case 'rejected':
      return 'Pull with rebase first, or you will be refused for the same reason: git pull --rebase, then try again.'
    case 'auth':
    case 'host-key':
      return 'Fix the credential first — nothing in this window changes it — then try again without leaving the page.'
    case 'cancelled':
      return 'Nothing was sent. The commit is still here, so this sends exactly what it would have sent.'
    case 'timeout':
      return 'It never finished rather than being refused, so trying again is worth one attempt before anything else.'
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
 * The field's own verdict on what has been typed, before anything is written.
 *
 * The same grammar the runtime would refuse it with, so the answer cannot
 * differ — and reached while somebody is still typing, because the input
 * everybody arrives with is the `https://` address their deploy printed and
 * telling them a round trip later that it was wrong reads as the app being
 * broken rather than the address being incomplete.
 *
 * It takes the URL out of whatever it arrives inside. A relay URL is a thing
 * one person sends another, and what people send each other is a sentence with
 * a URL in it, a line out of a deploy's output, or a URL with a full stop stuck
 * to the end — so a field that only accepts the bare address refuses the exact
 * input everybody actually has, with a message about schemes. The grammar is
 * unchanged: what is found is put through the same parser and refused on the
 * same terms.
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

/**
 * Every URL in a piece of text, most relay-shaped first.
 *
 * `ws://` and `wss://` before `http`, because a message that carries both — an
 * invitation naming the repository and the relay, say — means the WebSocket one
 * here, and the repository URL is only a URL by accident of being in the same
 * paragraph. Trailing punctuation goes: a URL at the end of a sentence arrives
 * with a full stop on it.
 */
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
      /**
       * What a teammate has to match, for a path, and null for a URL.
       *
       * Carried by the verdict rather than worked out by the field, because it
       * is the same sentence the invitation sends and the same condition the
       * runtime hashes: three places saying it three ways is how one of them
       * ends up saying something that is not quite true.
       */
      note: string | null
    }
  | { state: 'bad'; reason: string }

/**
 * The origin field's own verdict, before git is run.
 *
 * The same grammar the runtime refuses with — `checkOrigin` is shared — because
 * what goes wrong here is rarely a typo. It is a path, and whether a path can
 * be an identity depends on which path it is: `~/shared/app.git` cannot be one
 * and `/Volumes/team/app.git` can. Learning that a round trip later reads as
 * the button being broken rather than as the answer being fixable.
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

/**
 * What each kind of origin has to agree about, for the disclosure beside the
 * field.
 *
 * It used to be three sentences in front of everybody who opened the panel,
 * including the ones whose origin was fine. It is the answer to one question —
 * "what exactly has to match?" — so it is where a question is asked.
 */
export const ORIGIN_DETAIL =
  'Two checkouts are one project when their origins normalise to the same thing. For a URL that is forgiving: ssh ' +
  'against https, a port and a trailing .git are all normalised away, so your URLs need not match each other ' +
  'exactly. For a repository shared over a mounted volume it is not, because nothing on either Mac can tell that ' +
  'one volume mounted at two paths is one repository — so the absolute path is the identity, case and .git and ' +
  'all, and both of you have to mount it at the same one. docs/teamwork.md has the rest.'

/** The label on the button that copies the invitation. Named so a test can find it. */
export const COPY_INVITE_BUTTON = 'Copy the invitation'

/**
 * The message to send a teammate, as a whole thing rather than as instructions
 * for writing one.
 *
 * There is no invitation in this protocol — push access is membership, and
 * nothing is sent anywhere — which is exactly why this is needed: the person
 * setting a team up has to explain a thing with no invitation in it to somebody
 * who is expecting one. So this is what that explanation actually says, in the
 * order it has to be done, ending with the sentence about what they are
 * agreeing to. It names no step they cannot find and invents no URL.
 *
 * Returns null when the repository has no origin to clone, because an
 * invitation that cannot say where the repository is is worse than no button.
 *
 * When the origin is a path it carries the one condition the protocol cannot
 * check for them: the same path on their Mac. This is the moment to say it —
 * the alternative is a teammate who mounts the volume wherever their Finder put
 * it, does all five steps correctly, and is never seen.
 */
export function inviteText(input: {
  originUrl: string | null
  relayUrl: string | null
  projectName: string
  handle: string | null
}): string | null {
  if (input.originUrl === null) return null
  const origin = checkOrigin(input.originUrl)
  const mount =
    origin.ok && origin.kind === 'path'
      ? [
          '',
          `The repository is a directory rather than a URL, so mount it at exactly ${origin.remote} — that path is`,
          'what both our machines hash to decide we are on the same project, and a different one means we never see',
          'each other.'
        ]
      : []
  const who = input.handle === null ? 'I' : `I (${input.handle})`
  const relay =
    input.relayUrl === null
      ? 'The relay we meet on is not in the repository yet — I will push it, and you will get it by pulling.'
      : `The relay we meet on is already in the repository at .teamree/relay (${input.relayUrl}), so there is ` +
        'nothing for you to configure.'
  return [
    `${who} have set up teamwork on ${input.projectName} in teamree. Everyone who can push to the repository is on`,
    'the team, so there is nothing to accept and no account to make.',
    '',
    // Quoted only when it has to be, which for a URL is never and for a volume
    // called "Team Share" is the difference between a command and two commands.
    `1. Clone it if you have not: git clone ${shellPath(input.originUrl)}`,
    '2. Open teamree on your Mac and add that checkout as a project.',
    '3. Press Teamwork in the project header, choose “Join a team I was invited to”, and press Add my key.',
    '4. Press Commit and push. That is what puts you on the team.',
    ...mount,
    '',
    relay,
    '',
    'Worth knowing before you do it: a key in .teamree/members/ lets anyone on the roster type into any pane on',
    'your machine, which is running commands as you. That is the feature, and none of it can be done invisibly —',
    'a watched pane says so, typing is attributed live, every remote write is logged on your machine, and mute is',
    'instant and yours.'
  ].join('\n')
}

/** One thing that is either true or not at the end of setup. */
export type SetupFact = {
  label: string
  /** `unknown` is reserved for the push, which teamree genuinely cannot check. */
  state: 'yes' | 'no' | 'unknown'
  detail: string
}

/**
 * Where this ended up, in the four facts it is made of.
 *
 * A page of steps answers "what do I do next" and never answers "did that
 * work" — and here the honest answer to the second is usually "partly": the
 * commit lands and the push is refused, or everything on this machine is done
 * and the teammate has not opened the app. Half-working is the normal outcome
 * rather than an edge case, so one overall tick would have to pick one of the
 * halves to be wrong about. Four separate verdicts do not.
 */
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
      detail: list.enrolled
        ? `${selfFileOf(list) ?? list.selfFile} is in this checkout.`
        : 'Not in this checkout yet, so no teammate can address this machine.'
    },
    {
      label: 'The relay',
      state: relay.url === null ? 'no' : 'yes',
      detail:
        relay.url === null
          ? sentence(relay.onDisk.problem ?? `${relay.file} does not name a relay`)
          : `${relay.url}, from ${relay.source === 'environment' ? relay.override.name : relay.file}.`
    },
    {
      label: 'Pushed',
      state: pushed,
      detail:
        publish === undefined
          ? 'teamree has not pushed from here, so it cannot say whether these files are in the repository. Your ' +
            'own git will tell you: git status.'
          : publish.push.ok
            ? `${publish.branch} is on ${publish.remote}.`
            : // "Refused" is the remote's verdict, and two of these are not the
              // remote's at all: a push somebody stopped, and one that never
              // finished. Telling a person who pressed Stop that they were
              // turned away would send them to look at the wrong machine.
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
            ? 'Nobody but you is on this project’s roster yet.'
            : `${namesOfMembers(others)} ${others.length === 1 ? 'is' : 'are'} on the roster and not connected.`
    }
  ]

  const done = facts.every((fact) => fact.state === 'yes')
  // Only the first three are this machine's to finish. "Connected" is a fact
  // about somebody else's laptop, and reporting it as the unfinished step would
  // hand a person a job that is not theirs — which is the exact confusion this
  // panel is here to end.
  const stalled = facts.filter((fact) => fact.label !== 'Connected').find((fact) => fact.state === 'no')
  return {
    done,
    facts,
    head: done
      ? 'Teamwork is working in this repository.'
      : publish !== undefined && !publish.push.ok && publish.commit !== null
        ? 'Half of it: the commit was made here and the push did not land.'
        : stalled === undefined
          ? 'Everything this machine can do is done. What is left is somebody else opening teamree.'
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
      return 'Nothing here. A teammate opening teamree on a checkout of this repository is what changes it.'
  }
}

/**
 * The two things somebody can be doing here, in the words the choice is offered
 * in.
 *
 * Both are honest about what the other person has to do, because a flow that
 * describes only your own half is exactly the flow that was confusing: it
 * leaves you unable to tell "I have not finished" from "they have not started".
 */
export const TEAMWORK_PATHS = [
  {
    id: 'start',
    title: 'Start a team here',
    what:
      'Nobody has set teamwork up in this repository yet. You choose the relay your team will meet on, put your ' +
      'key in the repository, and push both — then send a teammate the repository URL.',
    them: 'They clone it, open teamree, add their key and push. Nothing is sent to them and there is nothing to accept.'
  },
  {
    id: 'join',
    title: 'Join a team I was invited to',
    what:
      'Somebody has already pushed a relay and their key here. You pull, add your key beside theirs, and push — ' +
      'there is no invitation to accept and nobody to ask, because push access is what membership means.',
    them: 'They see you at their next pull. teamree re-reads .teamree by itself, so neither of you restarts anything.'
  }
] as const satisfies readonly { id: TeamworkPath; title: string; what: string; them: string }[]

/**
 * Which of the two this repository looks like, and the fact that says so.
 *
 * Offered rather than applied. Reading the repository is a far better guess
 * than asking somebody who has not used this before — a relay file and a
 * colleague's key are unambiguous evidence that somebody went first — but it is
 * still a guess about intent, and the one thing this panel must never do is
 * take a decision quietly on somebody's behalf and then describe the result as
 * though they had made it.
 */
export function suggestedPath(
  list: MemberList | undefined,
  relay: RelaySetting | undefined
): { id: TeamworkPath; because: string } | null {
  if (list === undefined || relay === undefined) return null
  const others = list.members.filter((member) => !member.isSelf)
  if (relay.onDisk.url !== null && others.length > 0) {
    return {
      id: 'join',
      because: `${relay.file} and ${namesOfMembers(others)}’s key are already in this checkout, so somebody went first.`
    }
  }
  if (relay.onDisk.url !== null) {
    return { id: 'join', because: `${relay.file} is already in this checkout, so somebody has stood a relay up.` }
  }
  if (others.length > 0) {
    return {
      id: 'join',
      because: `${namesOfMembers(others)} ${others.length === 1 ? 'is' : 'are'} already on this project’s roster.`
    }
  }
  return { id: 'start', because: 'There is no relay and nobody’s key in this checkout, so nothing has been set up.' }
}

/** A step before the two sentences that say why it is there are added to it. */
type StepCore = Omit<StartTeamworkStep, 'why' | 'otherSide'>

/**
 * Why a step exists and what the far end sees while it does not, for each of
 * the two jobs.
 *
 * Written out per path rather than composed from fragments. The whole value of
 * these sentences is that they are about the reader's actual situation, and a
 * sentence assembled out of clauses that have to be true for both of two people
 * is exactly the prose that made the original flow a document to be studied.
 */
const GUIDANCE: Record<StepId, Record<TeamworkPath, { why: string; otherSide: string | null }>> = {
  identity: {
    start: {
      why:
        'teamree made an X25519 keypair the first time it ran, and the private half never leaves this machine. ' +
        'There is nothing to do here — it is shown so you can tell your own key from a teammate’s later.',
      otherSide: null
    },
    join: {
      why:
        'teamree made an X25519 keypair the first time it ran, and the private half never leaves this machine. ' +
        'Your teammate has one of their own; neither of you ever sees the other’s private half.',
      otherSide: null
    }
  },
  key: {
    start: {
      why:
        'Push access is membership. Your public key under .teamree/members/ is the only thing that lets a teammate ' +
        'address this machine — there is no account anywhere and nobody to ask.',
      otherSide:
        'Nobody who clones this repository can see that this machine exists until step 4 sends the file. There is ' +
        'no announcement: your key simply appears in their next pull.'
    },
    join: {
      why:
        'Push access is membership. Adding your key beside your teammate’s is the whole of joining — there is no ' +
        'invitation to accept, because being able to push this file is what being on the team means.',
      otherSide:
        'This file is exactly what your teammate is waiting for. Until it lands, teamree on their machine says ' +
        '“No teammates”, which looks identical to you having changed your mind.'
    }
  },
  relay: {
    start: {
      why:
        'Two machines behind two routers cannot reach each other, so both dial out to a relay instead. Your team ' +
        'runs it and teamree runs none — there is no default and nothing of ours to depend on.',
      otherSide:
        'Your teammates get this URL by pulling the repository, so choosing it is a one-time job for the team ' +
        'rather than something each of them repeats.'
    },
    join: {
      why:
        'The relay is one line in the repository, so it arrives with a pull. You should not be choosing one: ' +
        'everybody has to name the same relay or you never meet.',
      otherSide:
        'If you set a different relay from your teammate’s, you will each dial somewhere the other is not, and ' +
        'both machines will sit at “Nobody connected” with nothing wrong on either.'
    }
  },
  push: {
    start: {
      why:
        'Writing those files changed nothing anybody else can see. This is the act that makes them the team’s, and ' +
        'it is the only step here that leaves this machine.',
      otherSide:
        'Once it lands, a teammate needs only the repository URL: the relay is in it, and their own key is the ' +
        'only thing they add.'
    },
    join: {
      why:
        'Adding your key wrote a file in this checkout and stopped. A key nobody pushed is not membership, so this ' +
        'is the step that actually joins you.',
      otherSide:
        'Your teammate sees you at their next pull — teamree watches .teamree, so neither of you has to restart ' +
        'anything. If you both push at once the second one is rejected: pull with rebase and push again.'
    }
  },
  connected: {
    start: {
      why:
        'A link is up when a Noise session has authenticated against the key in this repository and been confirmed ' +
        'by a frame only the holder of its private half could have sent.',
      otherSide:
        'This one needs both machines: teamree open over there, their key pushed, and the same relay in both ' +
        'checkouts. “Nobody connected” is the ordinary state while you wait for somebody.'
    },
    join: {
      why:
        'A link is up when a Noise session has authenticated against the key in this repository and been confirmed ' +
        'by a frame only the holder of its private half could have sent.',
      otherSide:
        'Your teammate has to have pulled your key before their machine can dial you. If this sits at “not ' +
        'connected”, asking them to pull is the first thing to try.'
    }
  }
}

export function startTeamworkFlow(input: StartTeamworkInput): StartTeamworkFlow {
  // The guidance has to say something before anybody has chosen, and the
  // starting path is the one whose sentences are true of a repository nobody
  // has touched — which is the state the choice is being made in.
  const path = input.path ?? 'start'
  const steps = [identityStep(input), keyStep(input), relayStep(input), pushStep(input), connectedStep(input)].map(
    (step) => ({ ...step, ...GUIDANCE[step.id][path] })
  )
  // `unchecked` is deliberately not settled: the push step never self-completes
  // and is the one to lead with for as long as anything is written.
  const current = steps.find((step) => step.mark !== 'done' && step.mark !== 'this-run')
  // No blocker while the origin is unknown. The banner names a checkout that
  // cannot take part, and a project teamwork has not read yet is not one — it
  // is a project nothing has been established about.
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

function keyStep({ list, failedReads }: StartTeamworkInput): StepCore {
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

function pushStep(input: StartTeamworkInput): StepCore {
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

  // The runtime answered, and what it answered is that it has not read this
  // project yet — a project added moments ago, or a window that opened before
  // the peer service finished starting. Deliberately not the sentence above:
  // that one is this panel waiting on a call, this one is the runtime saying
  // the call has been made and the facts are not in. Nothing else in this step
  // may be said either way, because every phrase below it names something that
  // was found.
  if (status.state === 'unread') {
    return {
      id: 'connected',
      title,
      mark: 'todo',
      summary:
        'teamree has not read this project’s relay, roster or origin yet. This step says what it finds in a ' +
        'moment.'
    }
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
          `reason it stopped is in this run’s log.${mountMismatchNote(status)}`
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
    summary: `${relayLabel(status)} is reachable and no teammate’s machine is on it yet.${mountMismatchNote(status)}`
  }
}

/**
 * The one failure a path origin can produce that looks like nothing at all.
 *
 * Two machines that hash different project keys do not fail to connect: they
 * compute different rendezvous points and never look for each other, which
 * reads on both screens as "nobody is here yet" for as long as anybody is
 * willing to wait. The panel cannot detect it — that is the whole limitation —
 * so it says the condition out loud in the place where the silence appears, and
 * only for the origins it can be true of.
 */
function mountMismatchNote(status: TeamworkRead): string {
  if (!status.origin.ok) return ''
  const origin = checkOrigin(status.origin.url)
  if (!origin.ok || origin.kind !== 'path') return ''
  return (
    ` This project is matched by the path it is mounted at, ${origin.remote}. A teammate whose Mac reaches the ` +
    'same repository at any other path is on a different project as far as teamree is concerned, and will never ' +
    'appear here.'
  )
}

/**
 * Why a checkout with no usable `origin` cannot take part.
 *
 * One sentence, because the fix is now a field and a button directly under it
 * rather than a command to go and type somewhere else. What exactly has to
 * match is in `ORIGIN_DETAIL`, behind the disclosure beside that field, where
 * it is read by the people who need it and nobody else.
 *
 * It names both kinds of answer. This used to end "a URL, not a path on this
 * disk", which was the whole of the refusal a team sharing a repository over a
 * mounted volume ever got; the path they are looking at is now an answer, and
 * the sentence that greets them has to be the one that says so.
 */
function originBlocker(reason: string): string {
  return (
    `${sentence(reason)} Add the URL you and your teammates both cloned, or — for a repository on a shared volume ` +
    '— the absolute path it is mounted at on every Mac.'
  )
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
