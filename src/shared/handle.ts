// What teamree calls a person, as a rule both sides can apply. A handle is a
// filename committed to a repository as well as a name beside a pane, so it has
// to survive every filesystem the team uses or the roster splits.

import { isWindowsDeviceName } from './windowsNames'

/** Long enough for a real address's local part, short enough for a roster row. */
export const MAX_HANDLE_LENGTH = 48

/** Returns undefined rather than inventing a name: the file is committed and the whole team reads it. */
export function sanitiseHandle(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const cleaned = raw
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    // A run of separators becomes one dash, so a pasted `ada/../lovelace` is a
    // name rather than a traversal.
    .replace(/[-._]{2,}/g, '-')
    .slice(0, MAX_HANDLE_LENGTH)
    // Trimmed after the cut too: a truncation must not leave a trailing
    // separator, or a trailing dot Windows silently drops.
    .replace(/^[-._]+/, '')
    .replace(/[-._]+$/, '')
  if (!cleaned) return undefined
  // `nul.pub` cannot be created on Windows whatever the extension.
  if (isWindowsDeviceName(cleaned)) return undefined
  return cleaned
}
