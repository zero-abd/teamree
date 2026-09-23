// Reading `.teamree/members` off disk. One bad file costs one member and never
// the list: a wrong empty roster reads as "nobody", a statement about the team
// rather than about a typo. Every failure becomes a problem with a reason.

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MemberProblem } from '../../shared/entities'
import { sanitiseHandle } from './handle'
import { MEMBER_FILE_SUFFIX, MEMBERS_DIR_SEGMENTS, parseMemberFile, quote } from './memberFile'

export type RosterEntry = {
  handle: string
  publicKey: string
  addedAt: string
  /** Path relative to the project root, POSIX-separated, as a diff would show it. */
  file: string
}

export type Roster = {
  /** Sorted by handle. */
  entries: RosterEntry[]
  problems: MemberProblem[]
}

export function membersDirectory(projectPath: string): string {
  return join(projectPath, ...MEMBERS_DIR_SEGMENTS)
}

export function memberFilePath(projectPath: string, handle: string): string {
  return join(membersDirectory(projectPath), `${handle}${MEMBER_FILE_SUFFIX}`)
}

/** How a member file is named in the UI and in an error: forward slashes, as git spells the path. */
export function memberFileName(handle: string): string {
  return [...MEMBERS_DIR_SEGMENTS, `${handle}${MEMBER_FILE_SUFFIX}`].join('/')
}

export async function readRoster(projectPath: string): Promise<Roster> {
  const directory = membersDirectory(projectPath)
  const files = await listMemberFiles(directory)

  const entries: RosterEntry[] = []
  const problems: MemberProblem[] = []
  const claimed = new Map<string, string>()
  const claimedHandles = new Map<string, string>()

  for (const file of files) {
    const relative = [...MEMBERS_DIR_SEGMENTS, file].join('/')
    const reject = (reason: string): void => {
      problems.push({ file: relative, reason })
    }

    // Listing is case-insensitive so `bob.PUB` is *seen* and reported; matching
    // is exact so it is never a member. A case-insensitive match would let
    // anyone with push access file a key under a colleague's name, and on macOS
    // and Windows `bob.pub` and `bob.PUB` in one commit fold to a single file.
    if (!file.endsWith(MEMBER_FILE_SUFFIX)) {
      reject(`the name does not end in "${MEMBER_FILE_SUFFIX}" exactly, so teamree will not read it as a member`)
      continue
    }

    const stem = file.slice(0, file.length - MEMBER_FILE_SUFFIX.length)
    if (sanitiseHandle(stem) !== stem) {
      reject('the file name is not a handle teamree would have written')
      continue
    }

    // Belt and braces: the two rules above already make this impossible, but
    // "one handle names one person" is the property attribution rests on and
    // must not hold only as a consequence of two other rules.
    const namesake = claimedHandles.get(stem)
    if (namesake !== undefined) {
      reject(`claims the handle "${quote(stem)}", which ${namesake} already holds`)
      continue
    }

    let text: string
    try {
      text = await readFile(join(directory, file), 'utf8')
    } catch (error) {
      reject(`could not be read: ${(error as NodeJS.ErrnoException).code ?? 'unknown error'}`)
      continue
    }

    const parsed = parseMemberFile(text)
    if (!parsed.ok) {
      reject(parsed.reason)
      continue
    }
    // The filename is what a reviewer sees in a diff, so it decides who the key belongs to.
    if (parsed.value.handle !== stem) {
      reject(`names "${quote(parsed.value.handle)}" but is filed under "${quote(stem)}"`)
      continue
    }

    const owner = claimed.get(parsed.value.publicKey)
    if (owner !== undefined) {
      // Two handles on one key would make a peer ambiguous the moment anything
      // looks one up by key, which is exactly what a handshake does.
      reject(`has the same key as "${quote(owner)}"`)
      continue
    }
    claimed.set(parsed.value.publicKey, stem)
    claimedHandles.set(stem, quote(relative))
    entries.push({ ...parsed.value, file: relative })
  }

  return { entries, problems }
}

/** Sorted, so the roster and the duplicate-key blame do not depend on the filesystem's order. */
async function listMemberFiles(directory: string): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    // A project nobody has joined yet has no directory, which is not a fault.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return names.filter((name) => name.toLowerCase().endsWith(MEMBER_FILE_SUFFIX)).sort()
}
