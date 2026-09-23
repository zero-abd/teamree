// The one rule for turning a task name into a branch name; the runtime creates
// it and the create dialog previews it. Collision handling is not here: the
// runtime appends `-2`, `-3` and so on once it knows what is taken.

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
 * Several attempts at one task, told apart. A lone agent keeps the task's own
 * name; from two up every run carries its agent plus a counter once that agent
 * comes round again (naming only the runs after the first gave `task`,
 * `task codex`, `task claude 2`: a second attempt with no first on screen).
 * An empty selection is still one worktree, so one name rather than none.
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
