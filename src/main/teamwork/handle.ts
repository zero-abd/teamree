// Who a person is called here, and which source that name is taken from.
//
// A handle is derived from the email rather than invented, because people
// already recognise each other by what their commits say. That policy stays
// here, where the sources are. The rule that turns a name into a filename is in
// shared: the setup panel has to show which file the button will write while
// somebody is still typing the name, and a second copy of that rule would drift
// into promising a filename nobody gets.

import { sanitiseHandle } from '../../shared/handle'

// Re-exported so the rest of the runtime still asks this module what a handle
// is, the way it asked before the rule moved.
export { MAX_HANDLE_LENGTH, sanitiseHandle } from '../../shared/handle'

export type HandleSource = {
  /** What the user typed, when they typed one. */
  override?: string | undefined
  /** `git config user.email` in the project, when git has one. */
  gitEmail?: string | undefined
}

/**
 * THE HANDLE POLICY. It lives in this one expression because it is a policy and
 * not a fact: an explicit override wins, and failing that a person is called
 * what their commits already call them. Changing who teamree names people after
 * is changing the line below and nothing else in the codebase.
 */
export function resolveHandle(source: HandleSource): string | undefined {
  return sanitiseHandle(source.override ?? localPart(source.gitEmail))
}

function localPart(email: string | undefined): string | undefined {
  if (email === undefined) return undefined
  const at = email.indexOf('@')
  return at === -1 ? email : email.slice(0, at)
}
