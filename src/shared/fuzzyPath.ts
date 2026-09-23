// Go-to-file matching: the query's characters in order anywhere in the path, ranked by tier (`matchTier`),
// then so a match in the file name, at word starts and in one run beats one scattered across directories.

const WORD_START = 8
const IN_NAME = 3
const RUN = 10
/** Above any in-tier score, so a better tier always wins. */
const TIER = 10_000

/** 3: the file name is the query (with or without extension); 2: it starts with it; 1: the path holds it in one run; 0: fuzzy. */
export function matchTier(path: string, query: string): number {
  const wanted = query.toLowerCase().replace(/\s+/g, '')
  const lower = path.toLowerCase()
  const name = lower.slice(lower.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  if (name === wanted || (dot > 0 && name.slice(0, dot) === wanted)) return 3
  if (name.startsWith(wanted)) return 2
  return lower.includes(wanted) ? 1 : 0
}

/** How well `query` matches `path`, higher is better; null when its characters are not all there in order. */
export function fuzzyPathScore(path: string, query: string): number | null {
  const wanted = query.toLowerCase().replace(/\s+/g, '')
  if (wanted === '') return 0
  const lower = path.toLowerCase()
  if (!isSubsequence(lower, wanted)) return null

  const nameStart = path.lastIndexOf('/') + 1
  const bonus = (index: number): number => {
    const before = path[index - 1]
    const start =
      index === 0 ||
      before === '/' ||
      before === '-' ||
      before === '_' ||
      before === '.' ||
      before === ' ' ||
      (/[a-z0-9]/.test(before as string) && /[A-Z]/.test(path[index] as string))
    return (start ? WORD_START : 0) + (index >= nameStart ? IN_NAME : 0) + 1
  }

  // best[i]: the best score with the current query character placed at path index i.
  let best = new Float64Array(lower.length).fill(-Infinity)
  for (let step = 0; step < wanted.length; step += 1) {
    const next = new Float64Array(lower.length).fill(-Infinity)
    let earlier = -Infinity
    for (let index = 0; index < lower.length; index += 1) {
      if (index >= 2) earlier = Math.max(earlier, best[index - 2] as number)
      if (lower[index] !== wanted[step]) continue
      const from = step === 0 ? 0 : Math.max(earlier, index >= 1 ? (best[index - 1] as number) + RUN : -Infinity)
      if (from !== -Infinity) next[index] = from + bonus(index)
    }
    best = next
  }

  // Shorter paths win ties: `math.ts` over `lib/math/index.ts`.
  return matchTier(path, wanted) * TIER + Math.max(...best) - path.length / 100
}

/** The best `limit` of `paths` for `query`, best first; ties in path order. */
export function rankPaths(
  paths: Iterable<string>,
  query: string,
  limit: number
): { paths: string[]; truncated: boolean } {
  const scored: { path: string; points: number }[] = []
  for (const path of paths) {
    const points = fuzzyPathScore(path, query)
    if (points !== null) scored.push({ path, points })
  }
  scored.sort((left, right) => right.points - left.points || (left.path < right.path ? -1 : 1))
  return { paths: scored.slice(0, limit).map((entry) => entry.path), truncated: scored.length > limit }
}

function isSubsequence(text: string, wanted: string): boolean {
  let at = 0
  for (let index = 0; index < text.length && at < wanted.length; index += 1) {
    if (text[index] === wanted[at]) at += 1
  }
  return at === wanted.length
}
