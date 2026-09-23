// Deciding what "start this work from" means, and offering the choices. Git's
// own DWIM prefers a tag over a branch of the same name, so this classifies the
// string itself and hands `worktree add` a concrete sha. PRECEDENCE, highest first:
//   1. `HEAD`                          the primary checkout's current commit
//   2. a full ref path (`refs/...`)    exact, no interpretation at all
//   3. a local branch                  refs/heads/<name>
//   4. a tag                           refs/tags/<name>
//   5. a remote-tracking branch        refs/remotes/<name>, e.g. origin/main
//   6. the same name on some remote    refs/remotes/*/<name>
//   7. a commit sha, full or short
//   8. a remote branch not fetched yet fetched on demand, then (5)
// A bare name on two remotes at two different commits is refused, not guessed.

import { ErrorCode } from '../../shared/protocol'
import { GitServiceError } from './errors'
import type { GitRunner } from './gitProcess'
import { assertRefShape } from './repository'

export type StartPointKind = 'localBranch' | 'remoteBranch' | 'tag' | 'commit' | 'head'

/** One row of the picker. */
export type StartPointOption = {
  /** The spelling to pass back as `startedFrom`; short and human. */
  ref: string
  kind: StartPointKind
  sha: string
  /** Git's own abbreviation, so it stays unique as the repo grows. */
  shortSha: string
  /** Full ref name; absent for the synthetic detached-HEAD row. */
  refName?: string
  /** This is the project's configured base ref. */
  isBase: boolean
  /** Checked out in the primary checkout right now. */
  isCurrent: boolean
  /** Commit or tag time in seconds, which is what recency ordering uses. */
  updatedAt: number
}

export type StartPointList = {
  baseRef: string
  options: StartPointOption[]
  /** Candidates the repository has, counted before the cap. */
  total: number
  limit: number
  /** True when `total` exceeded `limit` and the tail was dropped. */
  truncated: boolean
}

/** A same-named ref that resolves somewhere else and was not chosen. */
export type StartPointAlternative = { kind: StartPointKind; refName: string; sha: string }

export type ResolvedStartPoint = {
  /** Exactly what the caller asked for. */
  requested: string
  kind: StartPointKind
  sha: string
  shortSha: string
  refName?: string
  /** The remote-tracking ref this is, e.g. `origin/main`. Where the work began, not an upstream: branches are created `--no-track`. */
  track?: string
  /** True when the ref had to be fetched before it could be resolved. */
  fetched: boolean
  alternatives: StartPointAlternative[]
  /** One line naming the rule that was applied, for the UI and for logs. */
  interpretation: string
}

export type ResolveStartPointOptions = {
  root: string
  requested: string
  signal?: AbortSignal
  /** Ceiling for an on-demand `git fetch`; it goes over the network. */
  fetchTimeoutMs?: number
}

export const DEFAULT_START_POINT_LIMIT = 200
const DEFAULT_FETCH_TIMEOUT_MS = 120_000

const HEADS = 'refs/heads/'
const REMOTES = 'refs/remotes/'
const TAGS = 'refs/tags/'

// A ref name can never contain these, so seeing one means the string is not a
// ref and must not reach for-each-ref, where it would be read as a glob.
const GLOB_CHARACTERS = /[*?[\\]/

type RefRow = {
  refName: string
  sha: string
  shortSha: string
  updatedAt: number
  current: boolean
}

// -------------------------------------------------------------------- reading

/** One process for every ref; anything per-ref hangs the picker on a monorepo with thousands of them. */
async function readRefs(
  runner: GitRunner,
  root: string,
  patterns: readonly string[],
  signal?: AbortSignal
): Promise<RefRow[]> {
  const format = [
    '%(refname)',
    '%(objectname)',
    '%(objectname:short)',
    // An annotated tag's own object is not a commit; the peeled fields are.
    '%(*objectname)',
    '%(*objectname:short)',
    '%(creatordate:unix)',
    '%(HEAD)'
  ].join('%00')

  const { stdout } = await runner.run({
    args: ['for-each-ref', `--format=${format}`, ...patterns],
    cwd: root,
    readOnly: true,
    signal,
    timeoutMs: 60_000
  })

  const rows: RefRow[] = []
  for (const line of stdout.split('\n')) {
    if (!line) continue
    const fields = line.split('\0')
    const refName = fields[0]
    if (!refName) continue
    const sha = fields[3] || fields[1] || ''
    const shortSha = fields[4] || fields[2] || sha.slice(0, 7)
    if (!sha) continue
    rows.push({
      refName,
      sha,
      shortSha,
      updatedAt: Number(fields[5] ?? '0') || 0,
      current: fields[6] === '*'
    })
  }
  return rows
}

async function readRemotes(runner: GitRunner, root: string): Promise<string[]> {
  const result = await runner.tryRun({ args: ['remote'], cwd: root, readOnly: true, timeoutMs: 30_000 })
  if (result.exitCode !== 0) return []
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function kindOf(refName: string): StartPointKind {
  if (refName.startsWith(HEADS)) return 'localBranch'
  if (refName.startsWith(REMOTES)) return 'remoteBranch'
  if (refName.startsWith(TAGS)) return 'tag'
  return 'commit'
}

/** The spelling a person recognizes: `main`, `origin/main`, `v1.2.0`. */
function shortNameOf(refName: string): string {
  for (const prefix of [HEADS, REMOTES, TAGS]) {
    if (refName.startsWith(prefix)) return refName.slice(prefix.length)
  }
  return refName
}

// ------------------------------------------------------------------ resolving

export async function resolveStartPoint(
  runner: GitRunner,
  options: ResolveStartPointOptions
): Promise<ResolvedStartPoint> {
  const { root, signal } = options
  const requested = options.requested.trim()
  assertRefShape(requested, 'start point')

  if (requested === 'HEAD') return resolveHead(runner, root, signal)
  if (requested.startsWith('refs/')) return resolveExactRef(runner, root, requested, signal)

  const candidates = GLOB_CHARACTERS.test(requested) ? [] : await lookupCandidates(runner, root, requested, signal)
  if (candidates.length > 0) return chooseCandidate(requested, candidates, false)

  const bySha = await resolveAsCommit(runner, root, requested, signal)
  if (bySha) return bySha

  const fetched = await fetchRemoteBranch(runner, root, requested, options.fetchTimeoutMs, signal)
  if (fetched) {
    const afterFetch = await lookupCandidates(runner, root, requested, signal)
    if (afterFetch.length > 0) return chooseCandidate(requested, afterFetch, true)
  }

  throw await unresolvableError(runner, root, requested)
}

async function resolveHead(runner: GitRunner, root: string, signal?: AbortSignal): Promise<ResolvedStartPoint> {
  const sha = await revParse(runner, root, 'HEAD', signal)
  if (!sha) {
    throw new GitServiceError(
      ErrorCode.NotFound,
      'HEAD does not point at a commit yet; this repository has no history',
      {
        requested: 'HEAD'
      }
    )
  }
  const branch = await runner.tryRun({ args: ['symbolic-ref', '--short', 'HEAD'], cwd: root, readOnly: true, signal })
  const on = branch.exitCode === 0 && branch.stdout.trim() ? ` (on ${branch.stdout.trim()})` : ' (detached)'
  return {
    requested: 'HEAD',
    kind: 'head',
    sha,
    shortSha: await abbreviate(runner, root, sha, signal),
    fetched: false,
    alternatives: [],
    interpretation: `HEAD of the primary checkout${on}`
  }
}

/** A `refs/...` path is a statement, not a name to interpret. */
async function resolveExactRef(
  runner: GitRunner,
  root: string,
  refName: string,
  signal?: AbortSignal
): Promise<ResolvedStartPoint> {
  const rows = await readRefs(runner, root, [refName], signal)
  const row = rows.find((candidate) => candidate.refName === refName)
  if (!row) {
    throw new GitServiceError(ErrorCode.NotFound, `start point "${refName}" is not a ref in this repository`, {
      requested: refName
    })
  }
  const kind = kindOf(refName)
  return {
    requested: refName,
    kind,
    sha: row.sha,
    shortSha: row.shortSha,
    refName,
    ...(kind === 'remoteBranch' ? { track: shortNameOf(refName) } : {}),
    fetched: false,
    alternatives: [],
    interpretation: `the ref ${refName}`
  }
}

/**
 * Every ref the name could mean, in one call. The glob over-matches (`*` crosses
 * slashes), so results are filtered to exact names.
 */
async function lookupCandidates(
  runner: GitRunner,
  root: string,
  name: string,
  signal?: AbortSignal
): Promise<RefRow[]> {
  const patterns = [`${HEADS}${name}`, `${TAGS}${name}`, `${REMOTES}${name}`, `${REMOTES}*/${name}`]
  const rows = await readRefs(runner, root, patterns, signal)
  const wanted = new Set([`${HEADS}${name}`, `${TAGS}${name}`, `${REMOTES}${name}`])
  return rows.filter((row) => wanted.has(row.refName) || isRemoteNamed(row.refName, name))
}

/** `refs/remotes/<one segment>/<name>`, so `origin/x` counts but `origin/old/x` does not. */
function isRemoteNamed(refName: string, name: string): boolean {
  if (!refName.startsWith(REMOTES) || !refName.endsWith(`/${name}`)) return false
  const remote = refName.slice(REMOTES.length, refName.length - name.length - 1)
  return remote.length > 0 && !remote.includes('/')
}

function chooseCandidate(requested: string, candidates: readonly RefRow[], fetched: boolean): ResolvedStartPoint {
  const local = candidates.find((row) => row.refName === `${HEADS}${requested}`)
  const tag = candidates.find((row) => row.refName === `${TAGS}${requested}`)
  const qualifiedRemote = candidates.find((row) => row.refName === `${REMOTES}${requested}`)
  const remotesByName = candidates.filter(
    (row) => row.refName !== `${REMOTES}${requested}` && row.refName.startsWith(REMOTES)
  )

  let winner: RefRow
  let rule: string
  if (local) {
    winner = local
    rule = `the local branch ${requested}`
  } else if (tag) {
    winner = tag
    rule = `the tag ${requested}`
  } else if (qualifiedRemote) {
    winner = qualifiedRemote
    rule = `the remote-tracking branch ${requested}`
  } else {
    winner = pickSingleRemote(requested, remotesByName)
    rule = `the remote-tracking branch ${shortNameOf(winner.refName)}`
  }

  const alternatives = candidates
    .filter((row) => row.refName !== winner.refName && row.sha !== winner.sha)
    .map((row) => ({ kind: kindOf(row.refName), refName: row.refName, sha: row.sha }))

  const kind = kindOf(winner.refName)
  const passedOver = alternatives.length
    ? `; ignored ${alternatives.map((alternative) => alternative.refName).join(', ')}`
    : ''
  return {
    requested,
    kind,
    sha: winner.sha,
    shortSha: winner.shortSha,
    refName: winner.refName,
    ...(kind === 'remoteBranch' ? { track: shortNameOf(winner.refName) } : {}),
    fetched,
    alternatives,
    interpretation: `${fetched ? 'fetched and used ' : 'used '}${rule}${passedOver}`
  }
}

/**
 * No rule orders one remote against another: disagreeing remotes are refused,
 * agreeing ones take the first, stable since for-each-ref returns name order.
 */
function pickSingleRemote(requested: string, rows: readonly RefRow[]): RefRow {
  const first = rows[0]
  if (!first) {
    // Unreachable: chooseCandidate is only called with a non-empty candidate set.
    throw new GitServiceError(ErrorCode.NotFound, `start point "${requested}" does not resolve to a commit`)
  }
  const disagreeing = rows.filter((row) => row.sha !== first.sha)
  if (disagreeing.length === 0) return first
  const names = rows.map((row) => shortNameOf(row.refName)).sort()
  throw new GitServiceError(
    ErrorCode.Conflict,
    `"${requested}" exists on more than one remote at different commits (${names.join(', ')}); name the remote you mean`,
    { requested, candidates: rows.map((row) => ({ ref: shortNameOf(row.refName), sha: row.sha })) }
  )
}

/** Full or abbreviated sha. Git refuses an abbreviation that is ambiguous. */
async function resolveAsCommit(
  runner: GitRunner,
  root: string,
  requested: string,
  signal?: AbortSignal
): Promise<ResolvedStartPoint | null> {
  if (!/^[0-9a-fA-F]{4,64}$/.test(requested)) return null
  const result = await runner.tryRun({
    args: ['rev-parse', '--verify', '--quiet', `${requested}^{commit}`],
    cwd: root,
    readOnly: true,
    signal
  })
  const sha = result.stdout.trim()
  if (result.exitCode !== 0 || !sha) {
    if (/ambiguous/i.test(result.stderr)) {
      throw new GitServiceError(ErrorCode.Conflict, `"${requested}" matches more than one object; use a longer sha`, {
        requested
      })
    }
    return null
  }
  return {
    requested,
    kind: 'commit',
    sha,
    shortSha: await abbreviate(runner, root, sha, signal),
    fetched: false,
    alternatives: [],
    interpretation:
      sha === requested.toLowerCase() ? `the commit ${sha}` : `the commit ${sha}, from the abbreviation ${requested}`
  }
}

/**
 * `origin/feature` for a branch nobody has fetched. The refspec is explicit so the
 * remote-tracking ref exists afterwards.
 */
async function fetchRemoteBranch(
  runner: GitRunner,
  root: string,
  requested: string,
  timeoutMs: number | undefined,
  signal?: AbortSignal
): Promise<boolean> {
  const slash = requested.indexOf('/')
  if (slash <= 0) return false
  const remote = requested.slice(0, slash)
  const branch = requested.slice(slash + 1)
  if (!branch) return false
  if (!(await readRemotes(runner, root)).includes(remote)) return false

  const result = await runner.tryRun({
    args: ['fetch', '--no-tags', remote, `+${HEADS}${branch}:${REMOTES}${remote}/${branch}`],
    cwd: root,
    timeoutMs: timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    signal
  })
  return result.exitCode === 0
}

async function unresolvableError(runner: GitRunner, root: string, requested: string): Promise<GitServiceError> {
  const remotes = await readRemotes(runner, root).catch(() => [] as string[])
  const hint = remotes.length
    ? ` (looked for a local branch, a tag, a commit, and a branch on ${remotes.join(', ')})`
    : ' (looked for a local branch, a tag, and a commit; this repository has no remotes)'
  return new GitServiceError(
    ErrorCode.NotFound,
    `start point "${requested}" does not name a branch, tag, or commit in this repository${hint}`,
    { requested, remotes }
  )
}

async function revParse(
  runner: GitRunner,
  root: string,
  revision: string,
  signal?: AbortSignal
): Promise<string | null> {
  const result = await runner.tryRun({
    args: ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`],
    cwd: root,
    readOnly: true,
    signal
  })
  const sha = result.stdout.trim()
  return result.exitCode === 0 && sha ? sha : null
}

/** Git decides how short is still unique; a fixed slice would not stay unique. */
async function abbreviate(runner: GitRunner, root: string, sha: string, signal?: AbortSignal): Promise<string> {
  const result = await runner.tryRun({
    args: ['rev-parse', '--short', sha],
    cwd: root,
    readOnly: true,
    signal
  })
  const short = result.stdout.trim()
  return result.exitCode === 0 && short ? short : sha.slice(0, 7)
}

// -------------------------------------------------------------------- listing

export type ListStartPointsOptions = {
  root: string
  baseRef: string
  /** Cap on rows returned. Defaults to `DEFAULT_START_POINT_LIMIT`. */
  limit?: number
}

/**
 * Everything the picker can offer: base ref, current branch, then local branches,
 * remote branches and tags, most recently touched first. The cap is a hard
 * requirement (ten thousand tags would cross the wire); `truncated` says a tail was dropped.
 */
export async function listStartPoints(runner: GitRunner, options: ListStartPointsOptions): Promise<StartPointList> {
  const { root, baseRef } = options
  const limit = Math.max(1, options.limit ?? DEFAULT_START_POINT_LIMIT)

  const rows = await readRefs(runner, root, ['refs/heads', 'refs/remotes', 'refs/tags'])
  const baseNames = baseRefSpellings(baseRef)

  const candidates: StartPointOption[] = []
  for (const row of rows) {
    // `origin/HEAD` is a pointer at another row in this same list.
    if (row.refName.startsWith(REMOTES) && row.refName.endsWith('/HEAD')) continue
    const ref = shortNameOf(row.refName)
    candidates.push({
      ref,
      kind: kindOf(row.refName),
      sha: row.sha,
      shortSha: row.shortSha,
      refName: row.refName,
      isBase: baseNames.has(row.refName) || baseNames.has(ref),
      isCurrent: row.current,
      updatedAt: row.updatedAt
    })
  }

  await addDetachedHead(runner, root, rows, baseNames, candidates)
  if (!candidates.some((option) => option.isBase)) await addMissingBase(runner, root, baseRef, candidates)

  candidates.sort(compareOptions)
  return {
    baseRef,
    options: candidates.slice(0, limit),
    total: candidates.length,
    limit,
    truncated: candidates.length > limit
  }
}

/** A base ref is stored short (`origin/main`) but matched against full names too. */
function baseRefSpellings(baseRef: string): Set<string> {
  const names = new Set([baseRef])
  if (!baseRef.startsWith('refs/')) {
    names.add(`${HEADS}${baseRef}`)
    names.add(`${REMOTES}${baseRef}`)
    names.add(`${TAGS}${baseRef}`)
  }
  return names
}

/** Only worth a row when HEAD is not already one of the branches listed. */
async function addDetachedHead(
  runner: GitRunner,
  root: string,
  rows: readonly RefRow[],
  baseNames: ReadonlySet<string>,
  into: StartPointOption[]
): Promise<void> {
  if (rows.some((row) => row.current)) return
  const sha = await revParse(runner, root, 'HEAD')
  if (!sha) return
  into.push({
    ref: 'HEAD',
    kind: 'head',
    sha,
    shortSha: await abbreviate(runner, root, sha),
    isBase: baseNames.has('HEAD'),
    isCurrent: true,
    updatedAt: await commitTime(runner, root, sha)
  })
}

/** The configured base can be a revision no ref in the list spells out. */
async function addMissingBase(
  runner: GitRunner,
  root: string,
  baseRef: string,
  into: StartPointOption[]
): Promise<void> {
  const resolved = await resolveStartPoint(runner, { root, requested: baseRef }).catch(() => null)
  if (!resolved) return
  const existing = into.find((option) => option.sha === resolved.sha && option.ref === baseRef)
  if (existing) {
    existing.isBase = true
    return
  }
  into.push({
    ref: baseRef,
    kind: resolved.kind,
    sha: resolved.sha,
    shortSha: resolved.shortSha,
    ...(resolved.refName ? { refName: resolved.refName } : {}),
    isBase: true,
    isCurrent: false,
    updatedAt: await commitTime(runner, root, resolved.sha)
  })
}

async function commitTime(runner: GitRunner, root: string, sha: string): Promise<number> {
  const result = await runner.tryRun({
    args: ['show', '--no-patch', '--format=%ct', sha],
    cwd: root,
    readOnly: true,
    timeoutMs: 30_000
  })
  return result.exitCode === 0 ? Number(result.stdout.trim()) || 0 : 0
}

const KIND_RANK: Record<StartPointKind, number> = {
  head: 2,
  localBranch: 3,
  remoteBranch: 4,
  tag: 5,
  commit: 6
}

function rankOf(option: StartPointOption): number {
  if (option.isBase) return 0
  if (option.isCurrent) return 1
  return KIND_RANK[option.kind]
}

function compareOptions(a: StartPointOption, b: StartPointOption): number {
  return rankOf(a) - rankOf(b) || b.updatedAt - a.updatedAt || a.ref.localeCompare(b.ref)
}
