// Who a person is called here, and which source that name is taken from: derived from the email, because
// people already recognise each other by what their commits say. The filename rule lives in shared, so the
// setup panel can show which file the button will write while somebody is still typing.

import { sanitiseHandle } from '../../shared/handle'

// Re-exported so the rest of the runtime still asks this module what a handle is.
export { MAX_HANDLE_LENGTH, sanitiseHandle } from '../../shared/handle'

export type HandleSource = {
  /** What the user typed, when they typed one. */
  override?: string | undefined
  /** `git config user.email` in the project, when git has one. */
  gitEmail?: string | undefined
}

/**
 * THE HANDLE POLICY, in one expression: an explicit override wins, else a person is called what their
 * commits call them. Changing who teamree names people after is changing the line below and nothing else.
 */
export function resolveHandle(source: HandleSource): string | undefined {
  return sanitiseHandle(source.override ?? localPart(source.gitEmail))
}

function localPart(email: string | undefined): string | undefined {
  if (email === undefined) return undefined
  const at = email.indexOf('@')
  return at === -1 ? email : email.slice(0, at)
}
