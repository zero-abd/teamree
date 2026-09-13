// What teamree calls a person, as a rule both sides can apply.
//
// A handle is two things at once: a filename committed to a repository, and the
// name a teammate reads beside a pane. The first constraint is why it is
// sanitised this hard — it has to survive every filesystem the team uses, and a
// name that works on one machine and not another would split the roster.
//
// It lives in shared for the reason `branchName.ts` does: the runtime writes
// the file and the setup panel tells somebody which file the button will write,
// at the moment they are typing the name. Two copies of this rule would drift,
// and the drift shows up as the panel promising a filename nobody gets.

import { isWindowsDeviceName } from './windowsNames'

/**
 * Long enough for a real address's local part, short enough that a roster row
 * is a name rather than a paragraph.
 */
export const MAX_HANDLE_LENGTH = 48

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
