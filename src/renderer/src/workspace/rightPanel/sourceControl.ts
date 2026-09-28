// The Changes tab as data: the section each change sits in, the folder tree a section can show, and what
// Commit and its menu do. Staged is what the next commit takes: git's index plus the paths ticked here.

import type { WorktreeChange, WorktreeChanges, WorktreeLog, WorktreeStatus } from '@shared/entities'
import type { LandOffer } from './landOffer'

export type CommitScope = 'ticked' | 'staged' | 'all'

/**
 * What Commit takes: the ticked paths plus the index, else the index alone, else every change.
 * Every row of a cut-off list ticked is All: the rows past the cap cannot be ticked.
 */
export function commitScope(
  ticked: readonly string[],
  changes: readonly WorktreeChange[],
  truncated = false
): CommitScope {
  if (ticked.length > 0) {
    const tickable = changes.filter((change) => change.kind !== 'conflicted' && (change.unstaged || !change.staged))
    return truncated && tickable.every((change) => ticked.includes(change.path)) ? 'all' : 'ticked'
  }
  return changes.some((change) => change.staged) ? 'staged' : 'all'
}

/** An unstaged change git can put back, or an untracked file the Trash can take. Intent-to-add is refused. */
export function canDiscard(change: WorktreeChange): boolean {
  if (!change.unstaged || change.kind === 'conflicted') return false
  return !(change.kind === 'added' && !change.staged)
}

/** Git holds part of the file and the rest waits; ticking it takes the whole file. */
export function isPartlyStaged(change: WorktreeChange, ticked: ReadonlySet<string>): boolean {
  return change.staged && change.unstaged && !ticked.has(change.path)
}

export type Sections = {
  conflicts: WorktreeChange[]
  staged: WorktreeChange[]
  unstaged: WorktreeChange[]
  /** On the branch against its base and in no uncommitted row. */
  committed: WorktreeChange[]
  /** Past the list's cap: counted by git, never listed; with Staged once all of it is. */
  unlisted: number
  unlistedIn: 'staged' | 'unstaged'
  committedUnlisted: number
  scope: CommitScope
}

export function sections(
  changes: WorktreeChanges | undefined,
  branch: WorktreeChanges | undefined,
  ticked: readonly string[]
): Sections {
  const listed = changes?.changes ?? []
  const rows = listed.filter((change) => change.kind !== 'conflicted')
  const held = new Set(ticked)
  const unlisted = changes === undefined ? 0 : Math.max(0, changes.total - listed.length)
  const scope = commitScope(ticked, rows, unlisted > 0)
  const uncommitted = new Set(
    listed.flatMap((change) => (change.from === undefined ? [change.path] : [change.path, change.from]))
  )
  const branchRows = branch?.changes ?? []
  return {
    conflicts: listed.filter((change) => change.kind === 'conflicted'),
    staged: rows.filter((change) => change.staged || held.has(change.path)),
    unstaged: rows.filter((change) => !change.staged && !held.has(change.path)),
    committed: branchRows.filter((change) => !uncommitted.has(change.path)),
    unlisted,
    unlistedIn: scope === 'all' && ticked.length > 0 ? 'staged' : 'unstaged',
    committedUnlisted: branch === undefined ? 0 : Math.max(0, branch.total - branchRows.length),
    scope
  }
}

/** Files, not rows: a folded folder of new files counts every file in it. */
export function sectionCount(shown: Sections, section: 'staged' | 'unstaged'): number {
  return filesIn(shown[section]) + (shown.unlistedIn === section ? shown.unlisted : 0)
}

function filesIn(rows: readonly WorktreeChange[]): number {
  return rows.reduce((sum, change) => sum + (change.files ?? 1), 0)
}

/** `Commit 2` for what is staged, `Commit All 6` when nothing is and everything goes. */
export function commitLabel(shown: Sections): string {
  if (shown.scope === 'all')
    return `Commit All ${counted(filesIn(shown.staged) + filesIn(shown.unstaged) + shown.unlisted)}`
  return `Commit ${counted(sectionCount(shown, 'staged'))}`
}

export type CommitChoice = {
  kind: 'commit' | 'push' | 'land' | 'amend'
  label: string
  /** Why it cannot run now. */
  disabled?: string
}

/** The Commit button's menu: plain, then pushed, then landed the way this branch lands, then amended. */
export function commitChoices(input: {
  land: LandOffer | null
  remote: boolean
  amend: string | null
}): CommitChoice[] {
  const { land } = input
  const landing: CommitChoice[] =
    land?.kind === 'merge'
      ? [{ kind: 'land', label: `Commit & Merge into ${land.into}…` }]
      : land?.kind === 'create-pr'
        ? [{ kind: 'land', label: 'Commit & Create Pull Request…' }]
        : []
  const blocked = land !== null && 'blocked' in land ? land.blocked : undefined
  return [
    { kind: 'commit', label: 'Commit' },
    ...(input.remote ? [{ kind: 'push' as const, label: 'Commit & Push' }] : []),
    ...landing.map((choice) => (blocked === undefined ? choice : { ...choice, disabled: blocked })),
    { kind: 'amend', label: 'Amend Last Commit', ...(input.amend === null ? {} : { disabled: input.amend }) }
  ]
}

/** Why the last commit cannot be rewritten here: it is the base's, or a remote has it. Null when it can. */
export function amendBlocker(status: WorktreeStatus | undefined, log: WorktreeLog | undefined): string | null {
  if (status === undefined || log === undefined || log.commits.length === 0) return 'No commit on this branch'
  if (status.upstream !== null && status.upstream !== undefined && status.ahead === 0) return 'Already pushed'
  return null
}

export type TreeRow =
  | { kind: 'folder'; path: string; name: string; depth: number; open: boolean }
  | { kind: 'file'; change: WorktreeChange; depth: number }

type Folder = { folders: Map<string, Folder>; files: WorktreeChange[] }

/** Folders first, then files, by name; a chain of lone folders is one row, `docs/guide/intro`. */
export function changeTree(changes: readonly WorktreeChange[], folded: (path: string) => boolean): TreeRow[] {
  const root: Folder = { folders: new Map(), files: [] }
  for (const change of changes) {
    let at = root
    const parts = withoutSlash(change.path).split('/')
    for (const part of parts.slice(0, -1)) {
      let next = at.folders.get(part)
      if (next === undefined) {
        next = { folders: new Map(), files: [] }
        at.folders.set(part, next)
      }
      at = next
    }
    at.files.push(change)
  }
  const rows: TreeRow[] = []
  const walk = (folder: Folder, prefix: string, depth: number): void => {
    for (const [first, start] of [...folder.folders].sort(([a], [b]) => byName(a, b))) {
      let name = first
      let node = start
      while (node.files.length === 0 && node.folders.size === 1) {
        const [[next, child]] = [...node.folders] as [[string, Folder]]
        name = `${name}/${next}`
        node = child
      }
      const path = `${prefix}${name}`
      const open = !folded(path)
      rows.push({ kind: 'folder', path, name, depth, open })
      if (open) walk(node, `${path}/`, depth + 1)
    }
    for (const change of [...folder.files].sort((a, b) => byName(fileNameOf(a.path), fileNameOf(b.path)))) {
      rows.push({ kind: 'file', change, depth })
    }
  }
  walk(root, '', 0)
  return rows
}

function byName(a: string, b: string): number {
  return a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true })
}

/** A long name cut before its last ten characters, so the extension survives an ellipsis in the middle. */
export function nameParts(name: string): [string, string] {
  if (name.length <= 16) return [name, '']
  const cut = Math.max(name.length - 10, Math.ceil(name.length / 2))
  return [name.slice(0, cut), name.slice(cut)]
}

/** `cart-totals → main · ↑1 ↓2`; a zero arrow is left out, and a remote's name is dropped from the base. */
export function refLine(branch: string, base: string | undefined, ahead: number, behind: number): string {
  const arrows = [ahead > 0 ? `↑${ahead}` : '', behind > 0 ? `↓${behind}` : ''].filter((arrow) => arrow !== '')
  const into = base === undefined ? '' : ` → ${shortRef(base)}`
  return `${branch}${into}${arrows.length === 0 ? '' : ` · ${arrows.join(' ')}`}`
}

/** `main` for `origin/main`; a local branch, slashes and all, as it is. */
export function shortRef(ref: string): string {
  return ref.startsWith('origin/') ? ref.slice('origin/'.length) : ref
}

/** `2,000`: a count past the list's cap is read at a glance. */
export function counted(count: number): string {
  return count.toLocaleString('en-US')
}

/** The folder a path sits in, `src/cart` for `src/cart/totals.ts` or `src/cart/gen/`; empty at the root. */
export function directoryOf(path: string): string {
  const cut = withoutSlash(path).lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

/** `totals.ts`, or `gen` for a folder git lists as `src/gen/`. */
export function fileNameOf(path: string): string {
  const bare = withoutSlash(path)
  return bare.slice(bare.lastIndexOf('/') + 1)
}

function withoutSlash(path: string): string {
  return path.endsWith('/') ? path.slice(0, -1) : path
}
