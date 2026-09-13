// Reading `.teamree/members` off disk.
//
// The governing rule is that one bad file costs one member and never the list.
// A roster is read to answer "who is on this team", and there is no answer
// worse than a wrong empty one: it reads as "nobody", which is a statement
// about the team rather than about a typo in a file.
//
// So every failure is local. A file that cannot be read, cannot be parsed,
// disagrees with its own name, or duplicates a key already claimed becomes a
// problem with a reason attached, and the other eight members list normally.

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MemberProblem } from '../../shared/entities'
import { sanitiseHandle } from './handle'
import { MEMBER_FILE_SUFFIX, MEMBERS_DIR_SEGMENTS, parseMemberFile } from './memberFile'

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

/**
 * How a member file is named in the UI and in an error. Always with forward
 * slashes: it is how git spells the path, and it is the spelling somebody will
 * paste into a command.
 */
export function memberFileName(handle: string): string {
  return [...MEMBERS_DIR_SEGMENTS, `${handle}${MEMBER_FILE_SUFFIX}`].join('/')
}

export async function readRoster(projectPath: string): Promise<Roster> {
  const directory = membersDirectory(projectPath)
  const files = await listMemberFiles(directory)

  const entries: RosterEntry[] = []
  const problems: MemberProblem[] = []
  const claimed = new Map<string, string>()

  for (const file of files) {
    const relative = [...MEMBERS_DIR_SEGMENTS, file].join('/')
    const reject = (reason: string): void => {
      problems.push({ file: relative, reason })
    }

    const stem = file.slice(0, file.length - MEMBER_FILE_SUFFIX.length)
    if (sanitiseHandle(stem) !== stem) {
      reject('the file name is not a handle teamree would have written')
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
    // The filename is what a reviewer sees in a diff, so it is what decides who
    // the key belongs to. A file whose contents name somebody else is not a
    // member teamree is willing to guess about.
    if (parsed.value.handle !== stem) {
      reject(`names "${parsed.value.handle}" but is filed under "${stem}"`)
      continue
    }

    const owner = claimed.get(parsed.value.publicKey)
    if (owner !== undefined) {
      // Two handles on one key would make a peer ambiguous the moment anything
      // looks one up by key, which is exactly what a handshake does.
      reject(`has the same key as "${owner}"`)
      continue
    }
    claimed.set(parsed.value.publicKey, stem)
    entries.push({ ...parsed.value, file: relative })
  }

  return { entries, problems }
}

/**
 * Sorted, so the roster does not depend on the order a filesystem hands out
 * directory entries — and so the duplicate-key check above blames the same file
 * on every machine.
 */
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
