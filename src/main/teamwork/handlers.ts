// THE SEAM: the whole surface the runtime wires up, from `registerHandlers.ts`. `dataDir` is the app's own
// data directory and not optional: the private key goes there, never inside a repository. Handlers get
// validated params and throw only TeamworkError or RuntimeError, so the dispatcher preserves the ErrorCode.

import { Params } from '../../shared/methods'
import type { ParamsOf, ResultOf } from '../../shared/methods'
import type { MethodRegistry } from '../runtime/methodRegistry'
import type { TeamworkService } from './teamworkService'

export const TEAMWORK_METHODS = [
  'members.list',
  'members.join',
  'teamwork.relay',
  'teamwork.setRelay',
  'teamwork.setOrigin',
  'teamwork.publishPlan',
  'teamwork.publish',
  'teamwork.publishProgress',
  'teamwork.cancelPublish'
] as const

export type TeamworkMethodName = (typeof TEAMWORK_METHODS)[number]

export type TeamworkHandlers = {
  [M in TeamworkMethodName]: (params: ParamsOf<M>) => Promise<ResultOf<M>>
}

export function createTeamworkHandlers(service: TeamworkService): TeamworkHandlers {
  return {
    'members.list': (params) => service.listMembers(params),
    'members.join': (params) => service.joinProject(params),
    'teamwork.relay': (params) => service.readRelay(params),
    'teamwork.setRelay': (params) => service.setRelay(params),
    'teamwork.setOrigin': (params) => service.setOrigin(params),
    'teamwork.publishPlan': (params) => service.publishPlan(params),
    'teamwork.publish': (params) => service.publish(params),
    'teamwork.publishProgress': (params) => service.publishProgress(params),
    'teamwork.cancelPublish': (params) => service.cancelPublish(params)
  }
}

export function registerTeamworkHandlers(registry: MethodRegistry, service: TeamworkService): TeamworkService {
  const handlers = createTeamworkHandlers(service)
  registry.register('members.list', Params.membersList, handlers['members.list'])
  registry.register('members.join', Params.membersJoin, handlers['members.join'])
  registry.register('teamwork.relay', Params.teamworkRelay, handlers['teamwork.relay'])
  registry.register('teamwork.setRelay', Params.teamworkSetRelay, handlers['teamwork.setRelay'])
  registry.register('teamwork.setOrigin', Params.teamworkSetOrigin, handlers['teamwork.setOrigin'])
  registry.register('teamwork.publishPlan', Params.teamworkPublishPlan, handlers['teamwork.publishPlan'])
  registry.register('teamwork.publish', Params.teamworkPublish, handlers['teamwork.publish'])
  registry.register('teamwork.publishProgress', Params.teamworkPublishProgress, handlers['teamwork.publishProgress'])
  registry.register('teamwork.cancelPublish', Params.teamworkCancelPublish, handlers['teamwork.cancelPublish'])
  return service
}
