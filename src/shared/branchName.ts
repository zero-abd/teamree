// The one rule for turning a task name into a branch name.
//
// It lives in shared because both sides need it and they must not disagree: the
// runtime creates the branch, and the create dialog previews it at the moment
// the user decides. Two copies of this rule would drift, and the drift would
// show up as the dialog promising a name nobody gets.
//
// Collision handling is NOT here. Only the runtime can know what is taken, and
// it appends `-2`, `-3` and so on. Treat this as the name you get when nothing
// else claims it.

const MAX_SLUG_LENGTH = 60
const FALLBACK_SLUG = 'worktree'

/** Reserved on Windows: neither a directory nor a loose ref file can use these. */
const WINDOWS_DEVICE_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/

export function slugifyBranchName(name: string): string {
  const slug = name
    .normalize('NFKD')
    // Drops combining marks so "Café" becomes "cafe" rather than "caf".
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '')

  if (!slug) return FALLBACK_SLUG
  if (WINDOWS_DEVICE_NAMES.test(slug)) return `${slug}-1`
  // git refuses a ref ending in `.lock`. Unreachable while the rule above turns
  // dots into hyphens; kept so the constraint survives a change to it.
  return slug.replace(/\.lock$/, 'lock')
}

/**
 * Several attempts at one task, told apart.
 *
 * Racing agents is what the product is for, so one description can become
 * several checkouts and each needs its own name before the runtime ever sees
 * one. A lone agent keeps the task's own name — that is the common case, and it
 * should read exactly as it did when there was no other option. From two up,
 * every run is suffixed with the agent that runs in it, plus a counter once
 * that agent comes round again: two runs of claude race each other as often as
 * claude races codex, and `task claude` twice is no answer.
 *
 * Every run carrying its agent is what keeps the set honest. Naming only the
 * runs after the first left the counter counting a run the rule had skipped, so
 * three agents came out as `task`, `task codex`, `task claude 2` — a second
 * attempt with no first anywhere on screen.
 *
 * A task with no agent is still one worktree, which is why an empty selection
 * is one name rather than none.
 */
export function taskNamesForAgents(task: string, agents: readonly string[]): string[] {
  if (agents.length <= 1) return [task]
  const seen = new Map<string, number>()
  return agents.map((agent) => {
    const nth = (seen.get(agent) ?? 0) + 1
    seen.set(agent, nth)
    return nth === 1 ? `${task} ${agent}` : `${task} ${agent} ${nth}`
  })
}
