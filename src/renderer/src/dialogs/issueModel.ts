// A GitHub issue as a task: the text its agent is handed, the branch it gets, and the picker's filter.

import { slugifyBranchName } from '@shared/branchName'
import type { IssueEntry } from '@shared/entities'

/** Under `MAX_AGENT_ARGS_CHARS`: the task goes on the agent's command line. */
export const MAX_ISSUE_TASK_CHARS = 4000

/** `#123 Title`, a blank line, then the body without template comments; capped, the cut marked. */
export function issueTask(issue: Pick<IssueEntry, 'number' | 'title' | 'body'>): string {
  const head = `#${issue.number} ${issue.title.trim()}`
  const body = issue.body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (body === '') return head
  const whole = `${head}\n\n${body}`
  const characters = Array.from(whole)
  if (characters.length <= MAX_ISSUE_TASK_CHARS) return whole
  return `${characters
    .slice(0, MAX_ISSUE_TASK_CHARS - 1)
    .join('')
    .trimEnd()}…`
}

/** `123-short-title`, by the rule every other branch is named with. */
export function issueBranch(issue: Pick<IssueEntry, 'number' | 'title'>): string {
  return slugifyBranchName(`${issue.number} ${issue.title}`)
}

/** Every word must match the number (with or without `#`), the title or a label. */
export function filterIssues(issues: readonly IssueEntry[], query: string): IssueEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return issues.filter((issue) => {
    const text = `#${issue.number} ${issue.title} ${issue.labels.join(' ')}`.toLowerCase()
    return words.every((word) => text.includes(word))
  })
}
