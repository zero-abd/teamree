// What Open Branch and Open Pull Request list, as rows: one title, one detail
// line, and what `worktree.create` is handed when a row is chosen.

import type { BranchEntry, PullRequestEntry } from '@shared/entities'

export type OpenableRow = {
  key: string
  title: string
  detail: string
  /** What the worktree is called: the branch's last commit subject, or the pull request's title. */
  name: string
  checkout: string
  base: string
}

export function branchRows(branches: readonly BranchEntry[], base: string, now: number): OpenableRow[] {
  return branches.map((branch) => ({
    key: branch.checkout,
    title: branch.name,
    detail: [branch.subject, branch.author, ageLabel(branch.updatedAt, now)].filter(Boolean).join(' · '),
    name: branch.subject || branch.name,
    checkout: branch.checkout,
    base
  }))
}

export function pullRequestRows(pulls: readonly PullRequestEntry[], now: number): OpenableRow[] {
  return pulls.map((pull) => ({
    key: `#${pull.number}`,
    title: [`#${pull.number} ${pull.title}`, pull.author].filter(Boolean).join(' · '),
    detail: [pull.branch, ageLabel(pull.updatedAt, now)].filter(Boolean).join(' · '),
    name: pull.title || pull.branch,
    checkout: pull.checkout,
    base: pull.base
  }))
}

export function filterRows(rows: readonly OpenableRow[], query: string): OpenableRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...rows]
  return rows.filter((row) => {
    const text = `${row.title} ${row.detail}`.toLowerCase()
    return words.every((word) => text.includes(word))
  })
}

export function ageLabel(at: number | null, now: number): string {
  if (at === null) return ''
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

/** The first prompt a reviewer agent is offered, editable before it starts. */
export function reviewPrompt(base: string): string {
  return `Review this branch against ${base}`
}
