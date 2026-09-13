// What teamree calls a person.
//
// A handle is two things at once: a filename committed to a repository, and the
// name a teammate reads beside a pane. The first constraint is why it is
// sanitised this hard — it has to survive every filesystem the team uses, and a
// name that works on one machine and not another would split the roster. The
// second is why it is derived from the email rather than invented: people
// already recognise each other by what their commits say.

import { isWindowsDeviceName } from '../git/worktreeNaming'

/**
 * Long enough for a real address's local part, short enough that a roster row
 * is a name rather than a paragraph.
 */
export const MAX_HANDLE_LENGTH = 48

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

/**
 * Returns undefined rather than inventing a name out of something unusable. A
 * derived handle nobody recognises is worse than asking for one: the file is
 * committed, and the whole team reads it.
 */
export function sanitiseHandle(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const cleaned = raw
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    // Any run of separators becomes one dash, which is what turns a path
    // somebody pasted in — `ada/../lovelace` — into a name rather than into a
    // souvenir of the traversal it was trying to be.
    .replace(/[-._]{2,}/g, '-')
    .slice(0, MAX_HANDLE_LENGTH)
    // Trimmed after the cut as well as before it, so a truncation cannot leave
    // a trailing separator — or, on Windows, a trailing dot the filesystem
    // silently drops, which would file the key under a name nobody asked for.
    .replace(/^[-._]+/, '')
    .replace(/[-._]+$/, '')
  if (!cleaned) return undefined
  // `nul.pub` cannot be created on Windows whatever the extension, and a member
  // file the whole team can read except one person is not a roster.
  if (isWindowsDeviceName(cleaned)) return undefined
  return cleaned
}

function localPart(email: string | undefined): string | undefined {
  if (email === undefined) return undefined
  const at = email.indexOf('@')
  return at === -1 ? email : email.slice(0, at)
}
