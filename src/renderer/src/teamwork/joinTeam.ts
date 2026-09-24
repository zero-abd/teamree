// Joining from an invitation in one press: clone (or use the checkout already
// here), add the project, write this machine's key, push it. The link grants
// nothing; the push is what asks the team, and a teammate's pull is the answer.

import type { Project, TeamworkPublish, TeamworkRead } from '@shared/entities'
import type { Invitation } from '@shared/invitation'
import type { MethodName, ParamsOf, ResultOf } from '@shared/methods'
import { checkOrigin, normaliseRemote } from '@shared/origin'

export type JoinCall = <M extends MethodName>(method: M, params: ParamsOf<M>) => Promise<ResultOf<M>>

/** A fresh clone into `clone`, or a project already here with the invitation's origin. */
export type JoinTarget = { clone: string } | { projectId: string }

export type JoinStage = 'clone' | 'read' | 'key' | 'push'

export type JoinOutcome =
  | { ok: true; project: Project; publish: TeamworkPublish }
  /** `project` once there is one, so a failed push still leaves somewhere to go. */
  | { ok: false; stage: JoinStage; error: string; project?: Project; publish?: TeamworkPublish }

/** How long a just-added project may take to be read: `project.add` answers before teamwork has looked. */
const READ_TIMEOUT_MS = 15_000
const READ_POLL_MS = 250

export async function joinTeam(
  call: JoinCall,
  invitation: Invitation,
  target: JoinTarget,
  onStage: (stage: JoinStage) => void = () => undefined
): Promise<JoinOutcome> {
  let stage: JoinStage = 'clone'
  let project: Project | undefined
  const fail = (error: unknown, publish?: TeamworkPublish): JoinOutcome => ({
    ok: false,
    stage,
    error: error instanceof Error ? error.message : String(error),
    ...(project === undefined ? {} : { project }),
    ...(publish === undefined ? {} : { publish })
  })
  try {
    const origin = checkOrigin(invitation.origin)
    if (!origin.ok) return fail(`Not a repository teamree can use: ${origin.reason}`)

    onStage(stage)
    if ('clone' in target) {
      project = await call('project.clone', { url: origin.remote, path: target.clone, name: invitation.project })
    } else {
      project = (await call('project.list', {})).find((entry) => entry.id === target.projectId)
      if (project === undefined) return fail('That project is gone')
    }

    stage = 'read'
    onStage(stage)
    const status = await readProject(call, project.id)
    // Refused, never corrected: a found checkout pointing elsewhere is another project.
    if (!status.origin.ok) return fail(`${project.name} has no origin: ${status.origin.reason}`)
    if (normaliseRemote(status.origin.url) !== origin.normalised) {
      return fail(`${project.name}’s origin is ${status.origin.url}, not ${origin.remote}`)
    }
    // A link from `teamree team invite` may name the relay; the repository's own file wins.
    if (invitation.relay !== undefined && status.relay === null) {
      await call('teamwork.setRelay', { projectId: project.id, url: invitation.relay })
    }

    stage = 'key'
    onStage(stage)
    const list = await call('members.list', { projectId: project.id })
    if (!list.enrolled) await call('members.join', { projectId: project.id })

    stage = 'push'
    onStage(stage)
    const plan = await call('teamwork.publishPlan', { projectId: project.id })
    if (plan.blocker !== null) return fail(plan.blocker)
    const publish = await call('teamwork.publish', { projectId: project.id })
    if (!publish.push.ok) return fail(publish.push.error, publish)
    return { ok: true, project, publish }
  } catch (error) {
    return fail(error)
  }
}

async function readProject(call: JoinCall, projectId: string): Promise<TeamworkRead> {
  const deadline = Date.now() + READ_TIMEOUT_MS
  for (;;) {
    const status = await call('teamwork.status', { projectId })
    if (status.state === 'read') return status
    if (Date.now() >= deadline) throw new Error('teamree has not read the project yet · try again')
    await new Promise((resolve) => setTimeout(resolve, READ_POLL_MS))
  }
}
