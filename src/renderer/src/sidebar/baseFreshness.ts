// What the window says about a project's base when the last fetch failed or is old.

import { fetchFailureWords } from '@shared/baseFetchWords'
import type { Project } from '@shared/entities'
import { agoLabel } from './agentRows'

/** Past this, a base fetched without trouble still reads as old. */
export const STALE_AFTER_MS = 60 * 60_000

type Fetched = Pick<Project, 'baseRef' | 'fetch'>

/** `can't reach origin`, `sign-in failed` or `fetched 3h ago`; null while the base is fresh or was never fetched. */
export function baseFreshness(project: Fetched, now: number): string | null {
  const fetch = project.fetch
  if (fetch?.failure !== undefined) return fetchFailureWords(fetch.failure, project.baseRef)
  if (fetch?.fetchedAt === undefined || now - fetch.fetchedAt < STALE_AFTER_MS) return null
  return `fetched ${agoLabel(now - fetch.fetchedAt)}`
}

/** The composer's note beside Start from on the base: `fetched 3h ago`, or why it has no date. */
export function startPointAge(project: Fetched, now: number): string | null {
  const words = baseFreshness(project, now)
  const at = project.fetch?.fetchedAt
  if (words === null || at === undefined) return words
  return `fetched ${agoLabel(now - at)}`
}
