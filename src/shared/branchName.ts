// The branch naming rules the runtime applies and the create dialog previews:
// slug, collision suffix (`-2`, `-3`) and the refusal of names git would reject.

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

/**
 * git stores branches as files, so `feature` and `feature/login` cannot both
 * exist. Case-insensitive because loose refs live on case-insensitive filesystems.
 */
export function branchCollides(candidate: string, taken: ReadonlySet<string>): boolean {
  const lower = candidate.toLowerCase()
  if (taken.has(lower)) return true
  for (const name of taken) {
    if (name.startsWith(`${lower}/`) || lower.startsWith(`${name}/`)) return true
  }
  return false
}

export function allocateBranchName(taskName: string, existingBranches: readonly string[]): string {
  const taken = new Set(existingBranches.map((branch) => branch.toLowerCase()))
  const base = slugifyBranchName(taskName)
  if (!branchCollides(base, taken)) return base
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!branchCollides(candidate, taken)) return candidate
  }
  return `${base}-${Date.now().toString(36)}`
}

const BRANCH_FORBIDDEN = /[\s~^:?*[\\]|^-|^\.|\.\.|@\{|\.lock$|^\/|\/$|\/\/|\/\./

/** A name `git branch` accepts; control characters are checked apart so the regex holds no literals. */
export function isValidBranchName(name: string): boolean {
  if (!name || BRANCH_FORBIDDEN.test(name)) return false
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}
