// Joining a team in one command: clone, add project, relay file, key, push.
// The link is not a credential: nothing here puts somebody on a roster without
// pushing a key. Finishing is not connecting. Running it twice is safe: every
// step finds its work already done and says so, or does it.

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
 * How long to wait for teamree to read a project it has only just been given:
 * `project.add` returns before the reconcile that reads `.teamree`, origin and roster.
 */
const READ_TIMEOUT_MS = 15_000
const READ_POLL_MS = 250

export async function acceptInvitation(context: CommandContext): Promise<CommandOutput> {
  const journey = new Journey()
  try {
    return await accept(context, journey)
  } catch (thrown) {
    // Every way out carries what was already done, including failures this file
    // did not write, or a roster refusal reads like a refusal at the first step.
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

  // Both addresses are checked before anything touches the disk.
  const origin = checkOrigin(invitation.origin)
  if (!origin.ok) {
    throw journey.refusal({
      code: 'bad_invitation_origin',
      message: `The invitation names a repository teamree cannot use: ${origin.reason}.`,
      hint: 'Ask whoever sent it to run `teamree team invite <project>` again — it refuses to write one of these.',
      data: { invitation }
    })
  }
  // The same allowlist again, on the spelling `checkOrigin` handed back: this is
  // where a string somebody was sent becomes an argument to git, and a flow that
  // is correct only because of a check in another layer breaks quietly.
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

  // Origin, established rather than assumed. A checkout naming a different
  // repository is a refusal, never a correction.
  if (status.origin.ok) {
    const here = normaliseRemote(status.origin.url)
    if (here !== origin.normalised) {
      throw journey.refusal({
        code: 'origin_mismatch',
        message:
          `${project.name} at ${project.path} has origin ${status.origin.url}, and the invitation names ` +
          `${origin.remote}. Those are two different projects as far as teamree is concerned.`,
        hint: 'Nothing was changed. Run this again with --into naming somewhere else to clone into.',
        data: { projectId: project.id, here: status.origin.url, invited: origin.remote }
      })
    }
    journey.note('origin', `origin already names ${status.origin.url}.`)
  } else if (found.cloned) {
    // Only ever on a checkout this command made, where nothing else was using it.
    const set = await context.client.call('teamwork.setOrigin', { projectId: project.id, url: origin.remote })
    journey.note(
      'origin',
      set.replaced
        ? `Pointed origin at ${set.url}, replacing the remote the clone came with.`
        : `Added origin ${set.url}.`
    )
  } else {
    // The refusal that matters most here: pointing a found checkout's origin at
    // an address out of a message and pushing would send somebody's whole local
    // branch to a host the link's author chose. Origins are set only on clones.
    throw journey.refusal({
      code: 'origin_missing',
      message:
        `${project.name} at ${project.path} was already on this machine and has no origin teamree can read: ` +
        `${status.origin.reason}. Nothing says it is the repository this invitation names.`,
      hint:
        'Nothing was changed. Run this again with --into naming a path that does not exist yet, or set the ' +
        `remote yourself: \`git -C ${project.path} remote add origin ${origin.remote}\`.`,
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
      `${project.name} is set up and your key is in the repository.`,
      // A key pushed is not a teammate connected.
      `Nobody is known to be connected; \`teamree team status ${project.name}\` is where that is answered.`,
      ...(origin.kind === 'path' ? ['', pathIdentityNote(origin.remote)] : [])
    ].join('\n')
  }
}

/**
 * The checkout this invitation names: the one already here, or a fresh clone.
 * "Already here" is decided on the normalised origin, the same test teamwork uses.
 */
async function findOrFetch(
  context: CommandContext,
  journey: Journey,
  invitation: Invitation,
  /** As `checkOrigin` spells it: `remote` is what git is given, `normalised` what a checkout's origin is compared against. */
  origin: { remote: string; normalised: string }
): Promise<{ project: Project; cloned: boolean }> {
  const projects = await context.client.call('project.list', {})
  const matches: Project[] = []
  const unread: string[] = []
  for (const candidate of projects) {
    const status = await context.client.call('teamwork.status', { projectId: candidate.id })
    // Unread projects have no origin to compare; they are named in the refusals
    // below so a surprising clone has an explanation.
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
      hint: 'Nothing was changed. Remove the ones you do not want.',
      data: { matches: matches.map((project) => ({ id: project.id, name: project.name, path: project.path })) }
    })
  }
  const here = matches[0]
  if (here !== undefined) {
    journey.note('repository', `Found it here: ${here.name} at ${here.path}.`)
    journey.note('project', `${here.name} is already a project.`)
    return { project: here, cloned: false }
  }

  // Say what was not compared before saying what happens instead.
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
    // Not a refusal: "I already cloned it" is ordinary. Whether it is the right
    // repository is settled against its own origin afterwards, and a checkout
    // with none is refused there because `cloned` is false on this path.
    journey.note('repository', `${into} is already here, so nothing was cloned.`)
  } else {
    const cloned = await cloneRepository({
      origin: origin.remote,
      into,
      cwd: context.cwd,
      // git's progress goes to stderr, and never under --json: stderr is where
      // a failure document goes, and a meter in front of it breaks the contract.
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
    // Noted after the clone, so a failed clone is never reported as a copy.
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
  // The invitation's name when free; two projects with one name is an ambiguous
  // selector for every command after this.
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
    // "already tracks" means the checkout became a project a moment too late to
    // have matched on origin.
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
 * Where to clone, as an absolute path. A leading `~` is refused, not resolved:
 * a shell expands one before this sees it, so a survivor was quoted.
 */
function destination(context: CommandContext, journey: Journey, invitation: Invitation): string {
  const asked = readString(context.flags, 'into')
  if (asked !== undefined) {
    // Both resolve to the working directory, which would adopt whatever the caller stands in.
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
 * A directory name for a fresh clone: the one git itself would choose. The
 * project name is only the fallback; it can be "Ledger (rewrite)".
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
      // Two halves of a team dialling two relays never meet, and nothing looks broken.
      throw journey.refusal({
        code: 'relay_mismatch',
        message: `${current.file} in this checkout names ${onDisk.url}, and the invitation names ${wanted}.`,
        hint: 'Nothing was changed. Settle which relay it is, then run this again.',
        data: { projectId: project.id, file: current.file, here: onDisk.url, invited: wanted }
      })
    }
    journey.note('relay', `${current.file} already names ${wanted}.`)
    return
  }

  // An unreadable relay file has no URL to disagree with, so it is replaced,
  // but out loud: the team committed it.
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
        // Where somebody discovers that a link did not let them in.
        (result.push.kind === 'auth' || result.push.kind === 'host-key'
          ? ` You need push access to ${origin.remote}; the invitation grants none.`
          : ''),
      data: { projectId: project.id, publish: result }
    })
  }

  // Two facts: "no new commit" is about this machine, "the remote already had
  // it" is `push`'s verdict, and unpushed local commits split them.
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

/** Waits for the reconcile a new project sets off; polled, since a subscription would need unwinding on every refusal. */
async function waitUntilRead(context: CommandContext, journey: Journey, project: Project): Promise<TeamworkRead> {
  const deadline = Date.now() + READ_TIMEOUT_MS
  for (;;) {
    const status = await context.client.call('teamwork.status', { projectId: project.id })
    if (status.state === 'read') return status
    if (Date.now() >= deadline) {
      throw journey.refusal({
        code: 'not_read_yet',
        message: `teamree has not read ${project.name}’s relay, roster or origin after ${Math.round(READ_TIMEOUT_MS / 1000)} seconds.`,
        hint: 'The project was added and nothing else was changed. Run this again in a moment.',
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
 * What has been done so far, and the only way out of this flow: every refusal
 * carries the steps before it, or a missing clone reads like an unpushed key.
 */
class Journey {
  readonly steps: AcceptStep[] = []

  note(step: AcceptStep['step'], outcome: string): void {
    this.steps.push({ step, outcome })
  }

  /** Any other failure with the steps put back on it; a refusal from this file already carries them. */
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
