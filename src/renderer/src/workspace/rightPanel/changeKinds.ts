// The one letter and the one word for each kind of change.
//
// Here rather than in the changes tab because the files tab prints the same
// letter beside a changed file, and two tables would be how a file comes to be
// `M` on one tab and `modified` on the other.

import type { WorktreeChange } from '@shared/entities'

/** One letter per kind, the way git itself abbreviates them. */
export const KIND_LETTER: Record<WorktreeChange['kind'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  typeChanged: 'T',
  untracked: '?',
  conflicted: '!'
}

export const KIND_LABEL: Record<WorktreeChange['kind'], string> = {
  modified: 'Modified',
  added: 'Added',
  deleted: 'Deleted',
  renamed: 'Renamed',
  copied: 'Copied',
  typeChanged: 'Type changed',
  untracked: 'Untracked',
  conflicted: 'Conflicted'
}
