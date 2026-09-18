// Doing, in one command, what a joiner does by hand today.
//
// `docs/trying-teamwork.md` spends four numbered steps on this: clone the
// repository, add it as a project, write the relay file, add your key, commit
// and push. Every one of those is a thing somebody has to be told, in order,
// in prose, and the step people forget is the last one — which is the only step
// that actually puts them on the team. That is the whole reason this exists.
//
// It lives beside `commands/team.ts` rather than inside it because it is not
// shaped like the commands there. Every other one asks the runtime a question
// and lays the answer out; this one is a sequence of acts on somebody's disk and
// somebody's repository, where the interesting part is what it refuses to do and
// where it stops. That reasoning is long and it is all here, in one place.
//
// Two properties hold throughout, and neither is negotiable.
//
// **The link is not a credential.** It carries four public facts and grants
// nothing. The last step is a push, and a machine that may not push to that
// repository is refused there in git's own words. There is no path through this
// file that puts somebody on a roster without pushing a key, and adding one
// would not be a feature — it would be the end of the only thing that decides
// who is on a team.
//
// **Finishing is not connecting.** A pushed key means a repository changed. It
// says nothing whatever about whether a teammate's machine is switched on, and
// the closing sentence says so rather than congratulating anybody on a link that
// has not been made.
//
// Running it twice is safe and is the documented remedy for stopping in the
// middle: every step below either finds its work already done and says so, or
// does it.

import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { Project, TeamworkRead } from '../shared/entities.js'
import { checkOrigin, normaliseRemote, pathIdentityNote } from '../shared/origin.js'
import { parseRelayUrl } from '../shared/relayUrl.js'
import { readString } from './argv.js'
import { checkCloneable, cloneRepository } from './clone.js'
import type { CommandContext } from './command-spec.js'
import { asCliError, CliError, ExitCode, RuntimeCallError } from './exit.js'
import { parseInvitation, type Invitation } from './invitation.js'
import type { CommandOutput } from './output.js'
import { pathComparisonKey } from './selectors.js'

/** One thing that was done or found already done, in the order it happened. */
export type AcceptStep = {
  /** Machine-readable name of the stage, for an agent branching on where it got to. */
  step: 'link' | 'repository' | 'project' | 'origin' | 'relay' | 'roster' | 'publish'
  /** What happened, as a sentence. The text output is these, one per line. */
  outcome: string
}

/**
 * How long to wait for teamree to read a project it has only just been given.
 *
 * `project.add` writes the project and returns; the reconcile that reads its
 * `.teamree`, its `origin` and its roster runs off the back of that, afterwards.
 * Everything below needs the result of that read, so this is a real wait and not
 * a guard against a hypothetical — and it is bounded, because a runtime that
 * never reads is a thing to report rather than to hang on.
 */
const READ_TIMEOUT_MS = 15_000
const READ_POLL_MS = 250

export async function acceptInvitation(context: CommandContext): Promise<CommandOutput> {
  const journey = new Journey()
  try {
    return await accept(context, journey)
  } catch (thrown) {
    // Every way out of this flow carries what was already done, including the
    // ways this file did not write: a runtime that refuses `members.join`
    // because git has no configured email is a refusal at the roster step, and
    // reporting it without the four steps before it would leave somebody unable
    // to tell it from a refusal at the first one.
    throw journey.attach(thrown)
  }
}

async function accept(context: CommandContext, journey: Journey): Promise<CommandOutput> {
  const parsed = parseInvitation(context.args[0] as string)
  if (!parsed.ok) {
    throw journey.refusal({
      code: 'bad_invitation',
      message: `That is not a teamree invitation: ${parsed.reason}.`,
      hint: parsed.hint
    })
  }
  const invitation = parsed.invitation

  // Both addresses are checked before anything touches the disk. They are the
  // two fields everything below is built on, and finding out that the relay was
  // unusable after cloning a repository would be a mess made on the way to a
  // refusal that was available at the start.
  const origin = checkOrigin(invitation.origin)
  if (!origin.ok) {
    throw journey.refusal({
      code: 'bad_invitation_origin',
      message: `The invitation names a repository teamree cannot use: ${origin.reason}.`,
      hint: 'Ask whoever sent it to run `teamree team invite <project>` again — it refuses to write one of these.',
      data: { invitation }
    })
  }
  // The same allowlist again, on the spelling `checkOrigin` handed back rather
  // than on the one the invitation carried. `checkOrigin` refuses a transport
  // itself now — so on this path the answer is already known — and it is asked
  // here anyway because this is the boundary where a string somebody was sent
  // stops being text and becomes an argument to git, and a flow that is correct
  // only because of a check in another layer is a flow that breaks quietly the
  // day that layer is relaxed for some good reason. It is one list, asked twice.
  const cloneable = checkCloneable(origin.remote)
  if (!cloneable.ok) {
    throw journey.refusal({
      code: 'bad_invitation_origin',
      message: `The invitation names a repository teamree will not act on: ${cloneable.reason}.`,
      hint: 'Ask whoever sent it for the address they clone this repository with themselves.',
      data: { invitation }
    })
  }

  const relay = parseRelayUrl(invitation.relay)
  if (!relay.ok) {
    throw journey.refusal({
      code: 'bad_invitation_relay',
      message: `The invitation names a relay teamree cannot dial: ${relay.reason}.`,
      hint: 'Ask whoever sent it to run `teamree team invite <project>` again — it refuses to write one of these.',
      data: { invitation }
    })
  }

  journey.note(
    'link',
    `${invitation.from} invites you to ${invitation.project}: the repository at ${origin.remote}, ` +
      `meeting on ${relay.url}.`
  )

  const found = await findOrFetch(context, journey, invitation, origin)
  const project = found.project
  const status = await waitUntilRead(context, journey, project)

  // Origin. Everything teamwork does hangs off this one string — two checkouts
  // are the same project when their normalised origins match — so it is
  // established rather than assumed. A checkout that already names a *different*
  // repository is a refusal and never a correction: repointing somebody's origin
  // because a link said so is exactly the act nobody asked for.
  if (status.origin.ok) {
    const here = normaliseRemote(status.origin.url)
    if (here !== origin.normalised) {
      throw journey.refusal({
        code: 'origin_mismatch',
        message:
          `${project.name} at ${project.path} has origin ${status.origin.url}, and the invitation names ` +
          `${origin.remote}. Those are two different projects as far as teamree is concerned.`,
        hint:
          'Nothing was changed. If this is meant to be the same repository, check the address with whoever sent ' +
          'the invitation; if it is not, run this again with --into naming somewhere else to clone into.',
        data: { projectId: project.id, here: status.origin.url, invited: origin.remote }
      })
    }
    journey.note('origin', `origin already names ${status.origin.url}.`)
  } else if (found.cloned) {
    // Only ever on a checkout this command made. A clone normally comes out
    // with its origin already set, so this is the odd case rather than the
    // ordinary one — but the directory is one nothing else was using, so
    // writing a remote into it takes nothing away from anybody.
    const set = await context.client.call('teamwork.setOrigin', { projectId: project.id, url: origin.remote })
    journey.note(
      'origin',
      set.replaced
        ? `Pointed origin at ${set.url}, replacing the remote the clone came with.`
        : `Added origin ${set.url}.`
    )
  } else {
    // The refusal that matters most in this file.
    //
    // A checkout that was already on this machine and has no origin teamree can
    // read is not a checkout of the repository the link names — it is a
    // repository about which nothing is known. Pointing its `origin` at an
    // address out of a message and then pushing would send somebody's entire
    // local branch to a host whoever wrote the link chose, and a scratch
    // repository with no remote is exactly the shape that has in it. The
    // directory name is taken from the link too, so the address and the target
    // are picked by the same person.
    //
    // So: this command sets an origin on a checkout it cloned, and never on one
    // it found.
    throw journey.refusal({
      code: 'origin_missing',
      message:
        `${project.name} at ${project.path} was already on this machine and has no origin teamree can read: ` +
        `${status.origin.reason}. Nothing says it is the repository this invitation names.`,
      hint:
        'Nothing was changed. Run this again with --into naming a path that does not exist yet and it will clone ' +
        `a fresh checkout there; or, if that directory really is the repository, give it the remote yourself with ` +
        `\`git -C ${project.path} remote add origin ${origin.remote}\` and run this again.`,
      data: { projectId: project.id, path: project.path, invited: origin.remote, origin: status.origin }
    })
  }

  await settleRelay(context, journey, project, relay.url)
  await joinRoster(context, journey, project)
  const published = await publish(context, journey, project, origin)

  return {
    data: { project, invitation, steps: journey.steps, publish: published },
    text: [
      ...journey.steps.map((step) => step.outcome),
      '',
      `${project.name} is set up on this machine and your key is in the repository. That is what membership is.`,
      '',
      // The sentence this command exists to be careful about.
      'Nothing here says a teammate is connected. That is a fact about somebody else’s machine and this command ' +
        `has not observed it — \`teamree team status ${project.name}\` is where it is answered.`,
      ...(origin.kind === 'path' ? ['', pathIdentityNote(origin.remote)] : [])
    ].join('\n')
  }
}

/**
 * The checkout this invitation names: the one already here, or a fresh clone.
 *
 * "Already here" is decided on the normalised origin and nothing else, because
 * that is the same test teamwork itself uses to decide two checkouts are one
 * project. Matching on a directory name would find the wrong repository, and
 * matching on nothing would clone a second copy of one somebody already has.
 */
async function findOrFetch(
  context: CommandContext,
  journey: Journey,
  invitation: Invitation,
  /**
   * The origin as `checkOrigin` spells it, and never as the invitation typed it.
   * `remote` is what git is given — for a path that is the normalised spelling,
   * which is also the string `checkCloneable` was asked about — and `normalised`
   * is what a checkout's own origin is compared against.
   */
  origin: { remote: string; normalised: string }
): Promise<{ project: Project; cloned: boolean }> {
  const projects = await context.client.call('project.list', {})
  const matches: Project[] = []
  const unread: string[] = []
  for (const candidate of projects) {
    const status = await context.client.call('teamwork.status', { projectId: candidate.id })
    // A project teamree has not read yet has no origin to compare, and guessing
    // one from its name would be the wrong repository found confidently. It is
    // named in the refusals below instead, so a surprising clone has an
    // explanation attached to it.
    if (status.state !== 'read') {
      unread.push(candidate.name)
      continue
    }
    if (status.origin.ok && normaliseRemote(status.origin.url) === origin.normalised) matches.push(candidate)
  }

  if (matches.length > 1) {
    throw journey.refusal({
      code: 'ambiguous_project',
      message: `${matches.length} projects on this machine already have that origin: ${matches.map((project) => project.name).join(', ')}.`,
      hint: 'Nothing was changed. Remove the ones you do not want, or finish the setup in the one you do.',
      data: { matches: matches.map((project) => ({ id: project.id, name: project.name, path: project.path })) }
    })
  }
  const here = matches[0]
  if (here !== undefined) {
    journey.note('repository', `Found it here: ${here.name} at ${here.path}.`)
    journey.note('project', `${here.name} is already a project.`)
    return { project: here, cloned: false }
  }

  // Nothing here matched, so say what was not compared before saying what is
  // about to happen instead. A checkout that turns out to be a second copy of
  // one this machine already has should come with the reason it was not
  // recognised, rather than with a surprise.
  if (unread.length > 0) {
    journey.note(
      'repository',
      `teamree has not read ${unread.join(', ')} yet, so ${
        unread.length === 1 ? 'that project was' : 'those projects were'
      } not compared.`
    )
  }

  const into = destination(context, journey, invitation)
  let fetched = false
  if (existsSync(into)) {
    // Not a refusal, and deliberately so: "I already cloned it" is the ordinary
    // case, and the origin check above failed to find it only because teamree
    // was never told about it. Whether it really is the right repository is
    // settled against its own origin afterwards — and a checkout with no origin
    // to settle it against is refused there rather than adopted, because
    // `cloned` below is false for everything that reaches this line.
    journey.note('repository', `${into} is already here, so nothing was cloned.`)
  } else {
    const cloned = await cloneRepository({
      origin: origin.remote,
      into,
      cwd: context.cwd,
      // git's progress goes to stderr, and only when this is not --json.
      //
      // There is no third pipe. stdout carries the one document, and stderr is
      // where a failure document goes — every other command in this CLI puts it
      // there and every caller parses it from there — so a progress meter on
      // stderr under --json would be a JSON document with a kilobyte of
      // "Receiving objects: 43%" in front of it. That is a broken contract, not
      // a nicety, so the meter is what gives way: `--json` says nothing until
      // the clone is over, and the command's own help says so rather than
      // leaving somebody to discover ten minutes of silence.
      ...(context.json ? {} : { onProgress: (line: string) => context.streams.err(`${line}\n`) })
    })
    if (!cloned.ok) {
      throw journey.refusal({
        code: 'clone_failed',
        message: cloned.error,
        hint: cloned.advice,
        data: { origin: origin.remote, into, kind: cloned.kind }
      })
    }
    // Noted after the clone and not before it. A step written down on the way in
    // would say a repository had been copied in exactly the case where it had
    // not, which is the one sentence this list exists to be trusted about.
    journey.note('repository', `Nothing here has that origin, so this cloned ${origin.remote} into ${into}.`)
    fetched = true
  }

  return { project: await addProject(context, journey, into, invitation.project), cloned: fetched }
}

/** Adds the checkout, or finds the project that is already tracking it. */
async function addProject(
  context: CommandContext,
  journey: Journey,
  into: string,
  invitedName: string
): Promise<Project> {
  // The project name comes from the invitation when it is free, so that both
  // sides call the project the same thing. It is skipped when the name is taken,
  // because two projects with one name is an ambiguous selector for every
  // command after this — a nicety is not worth breaking `teamree team status`.
  const existing = await context.client.call('project.list', {})
  const taken = existing.some((project) => project.name.toLowerCase() === invitedName.toLowerCase())

  try {
    const added = await context.client.call('project.add', {
      path: into,
      ...(taken ? {} : { name: invitedName })
    })
    journey.note(
      'project',
      taken
        ? `Added it as ${added.name}; this machine already has a project called ${invitedName}.`
        : `Added ${added.name} as a project.`
    )
    return added
  } catch (error) {
    // "already tracks" is the one refusal with an answer other than stopping:
    // the checkout is here and is a project, and this was told about it a moment
    // too late to have matched it on origin.
    if (!(error instanceof RuntimeCallError) || error.code !== 'conflict') throw error
    const again = await context.client.call('project.list', {})
    const key = pathComparisonKey(into)
    const found = again.find((project) => pathComparisonKey(project.path) === key)
    if (found === undefined) throw error
    journey.note('project', `${found.name} already tracks ${found.path}.`)
    return found
  }
}

/**
 * Where to clone, as an absolute path.
 *
 * `--into` is taken as it was typed and resolved against the working directory,
 * which is what every other tool does with a path argument. A leading `~` is
 * refused rather than resolved: a shell expands one before this ever sees it, so
 * a `~` that survives to here was quoted, and `./~/api` is not what anybody
 * meant by it.
 */
function destination(context: CommandContext, journey: Journey, invitation: Invitation): string {
  const asked = readString(context.flags, 'into')
  if (asked !== undefined) {
    // `--into ""` and `--into .` both resolve to the working directory, which
    // would adopt whatever the caller happens to be standing in. Asked for and
    // never meant.
    if (asked.trim() === '' || asked.trim() === '.') {
      throw journey.refusal({
        code: 'bad_destination',
        message: '--into names no directory.',
        hint: 'Give the path to clone into. Leave --into off entirely to clone into the working directory under the repository’s own name.'
      })
    }
    if (asked.startsWith('~')) {
      throw journey.refusal({
        code: 'bad_destination',
        message: `--into ${asked} starts with a ~, which is a different directory for every account.`,
        hint: 'Give the path in full, starting with /, or leave --into off and let this clone into the current directory.'
      })
    }
    return isAbsolute(asked) ? asked : resolve(context.cwd, asked)
  }
  return join(context.cwd, repositoryName(invitation))
}

/**
 * A directory name for a fresh clone, from the repository's own last segment.
 *
 * The same name git itself would choose, because a joiner who later types
 * `git clone` by hand should find the directory where they expect it. The
 * project name is the fallback rather than the first choice for the same
 * reason — it is a label somebody typed, and it can be "Ledger (rewrite)".
 */
function repositoryName(invitation: Invitation): string {
  const segments = invitation.origin.replace(/\/+$/, '').split(/[/\\:]/)
  const last = segments[segments.length - 1] ?? ''
  const cleaned = last
    .replace(/\.git$/i, '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  if (cleaned.length > 0) return cleaned
  const fallback = invitation.project.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[-.]+|[-.]+$/g, '')
  return fallback.length > 0 ? fallback : 'teamree-project'
}

/** The relay file, written or found already saying the same thing. */
async function settleRelay(context: CommandContext, journey: Journey, project: Project, wanted: string): Promise<void> {
  const current = await context.client.call('teamwork.relay', { projectId: project.id })
  const onDisk = current.onDisk.url === null ? null : parseRelayUrl(current.onDisk.url)

  if (onDisk !== null && onDisk.ok) {
    if (onDisk.url !== wanted) {
      // Overwriting this would be the worst kind of quiet success: two halves of
      // a team dialling two relays never meet, and nothing on either machine
      // looks broken while it happens.
      throw journey.refusal({
        code: 'relay_mismatch',
        message: `${current.file} in this checkout names ${onDisk.url}, and the invitation names ${wanted}.`,
        hint:
          'Nothing was changed. Two relays is two halves of a team that never meet, and neither machine looks ' +
          'broken while it happens — so settle which one it is with whoever sent the invitation, and run this again.',
        data: { projectId: project.id, file: current.file, here: onDisk.url, invited: wanted }
      })
    }
    journey.note('relay', `${current.file} already names ${wanted}.`)
    return
  }

  // A file that is there and cannot be read as a relay is replaced rather than
  // refused — there is no URL in it to disagree with — but it is replaced out
  // loud, because overwriting something the team committed is not a thing to do
  // in a sentence that reads as though the file had been missing.
  const replaced =
    onDisk === null || onDisk.ok
      ? ''
      : ` It replaced what was there, which could not be read as a relay URL: ${onDisk.reason}.`
  const written = await context.client.call('teamwork.setRelay', { projectId: project.id, url: wanted })
  journey.note(
    'relay',
    `Wrote ${written.file}: ${wanted}.${replaced}` +
      (written.source === 'environment'
        ? ` Note that ${written.override.name} is set in this app’s environment, so this machine keeps dialling ${written.url ?? 'nothing'} until it is unset.`
        : '')
  )
}

/** This machine's key in the roster file, written or already there. */
async function joinRoster(context: CommandContext, journey: Journey, project: Project): Promise<void> {
  const before = await context.client.call('members.list', { projectId: project.id })
  const already = before.members.find((member) => member.isSelf)
  if (before.enrolled && already !== undefined) {
    journey.note('roster', `This machine’s key is already on the roster as ${already.handle}, in ${already.file}.`)
    return
  }

  const handle = readString(context.flags, 'handle')
  const after = await context.client.call('members.join', {
    projectId: project.id,
    ...(handle === undefined ? {} : { handle })
  })
  const me = after.members.find((member) => member.isSelf)
  journey.note(
    'roster',
    me === undefined
      ? 'Wrote this machine’s key, and the roster is not showing it yet.'
      : `Wrote ${me.file}, filing this machine’s key under ${me.handle}.`
  )
}

/** The push, which is the step that actually makes somebody a member. */
async function publish(
  context: CommandContext,
  journey: Journey,
  project: Project,
  origin: { remote: string }
): Promise<unknown> {
  const plan = await context.client.call('teamwork.publishPlan', { projectId: project.id })
  if (plan.blocker !== null) {
    throw journey.refusal({
      code: 'publish_blocked',
      message: plan.blocker,
      hint: `Everything before this is done. Fix that and run \`teamree team publish ${project.name}\`.`,
      data: { projectId: project.id, plan }
    })
  }

  const result = await context.client.call('teamwork.publish', { projectId: project.id })
  if (!result.push.ok) {
    const committed =
      result.commit === null
        ? 'Nothing new to commit here.'
        : `The commit was made here (${result.commit.shortSha}) and did not leave this machine.`
    throw journey.refusal({
      code: 'push_failed',
      // git's own words, whole: they are what a person can search for.
      message: result.push.error,
      hint:
        `${committed} ${result.push.advice}` +
        // The one place this has to be said plainly, because it is the place
        // somebody discovers that a link did not let them in.
        (result.push.kind === 'auth' || result.push.kind === 'host-key'
          ? ` Being on this team is being able to push to ${origin.remote}; the invitation carried no ` +
            'permission and could not, so this is between you and whoever controls that repository.'
          : ''),
      data: { projectId: project.id, publish: result }
    })
  }

  // Two separate facts, and they were being reported as one. "This made no new
  // commit" is about this machine; "the remote already had it" is `push`'s own
  // verdict, and a branch carrying the user's own unpushed commits makes the
  // first true and the second false.
  const made =
    result.commit === null
      ? 'Nothing new to commit here'
      : `Committed ${result.commit.shortSha} — “${result.commit.message}”`
  const sent = result.push.alreadyUpToDate
    ? `${result.remote} already had ${result.branch}`
    : `pushed ${result.branch} to ${result.remote}${
        result.push.setUpstream ? `, and set ${result.push.upstream} as its upstream` : ''
      }`
  journey.note('publish', `${made}; ${sent}.`)
  return result
}

/**
 * Waits for the reconcile a new project sets off.
 *
 * Polled rather than subscribed because this is a one-shot wait inside a command
 * that is about to exit, and a subscription would be a second thing to unwind on
 * every refusal below it.
 */
async function waitUntilRead(context: CommandContext, journey: Journey, project: Project): Promise<TeamworkRead> {
  const deadline = Date.now() + READ_TIMEOUT_MS
  for (;;) {
    const status = await context.client.call('teamwork.status', { projectId: project.id })
    if (status.state === 'read') return status
    if (Date.now() >= deadline) {
      throw journey.refusal({
        code: 'not_read_yet',
        message: `teamree has not read ${project.name}’s relay, roster or origin after ${Math.round(READ_TIMEOUT_MS / 1000)} seconds.`,
        hint:
          'The project was added and nothing else was changed. Run this again in a moment — every step it has ' +
          'already done it will find done.',
        data: { projectId: project.id }
      })
    }
    await sleep(READ_POLL_MS)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((done) => {
    const timer = setTimeout(done, ms)
    timer.unref?.()
  })
}

/**
 * What has been done so far, and the only way out of this flow.
 *
 * Every refusal carries the steps that came before it. A command that stops
 * halfway and reports only the stop leaves somebody unable to tell a clone that
 * never happened from a key that is written and unpushed — which is the
 * difference between running it again and going to look at a repository.
 */
class Journey {
  readonly steps: AcceptStep[] = []

  note(step: AcceptStep['step'], outcome: string): void {
    this.steps.push({ step, outcome })
  }

  /**
   * Any other failure, with the steps put back on it.
   *
   * A refusal this file wrote already carries them and is returned untouched;
   * anything else — a runtime error, a socket that went away — keeps its own
   * code, message, hint and exit code and gains the list.
   */
  attach(thrown: unknown): CliError {
    const error = asCliError(thrown)
    const data: unknown = error.data
    if (typeof data === 'object' && data !== null && 'steps' in data) return error
    return new CliError({
      code: error.code,
      message: error.message,
      exitCode: error.exitCode,
      ...(error.hint === undefined ? {} : { hint: error.hint }),
      data: { steps: this.steps, ...(data === undefined ? {} : { detail: data }) }
    })
  }

  refusal(init: { code: string; message: string; hint: string; data?: Record<string, unknown> }): CliError {
    return new CliError({
      code: init.code,
      message: init.message,
      exitCode: ExitCode.Failure,
      hint: init.hint,
      data: { steps: this.steps, ...init.data }
    })
  }
}
