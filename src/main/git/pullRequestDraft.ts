// A pull request's prefilled title and body: the agent's report, else the commits, closing the issue it came from.

import { closesIssue } from '../../shared/issueClosing'

export type DraftCommit = { subject: string; body: string }

/** One commit's title and body; several are listed under the task's first line, else the name. */
export function pullRequestDraft(input: {
  /** A succeeded report's summary. */
  report?: string
  task?: string
  name: string
  issue?: number
  /** Oldest first. */
  commits: readonly DraftCommit[]
}): { title: string; body: string } {
  const report = input.report?.trim() ?? ''
  const only = input.commits.length === 1 ? input.commits[0] : undefined
  const draft =
    report !== ''
      ? commitOf(report)
      : only !== undefined
        ? only
        : {
            subject: taskLine(input.task, input.issue) || input.name,
            body: input.commits.map((commit) => `- ${commit.subject}`).join('\n')
          }
  const issue = input.issue
  const closed = issue === undefined || closesIssue(`${draft.subject}\n${draft.body}`, issue)
  const body = closed ? draft.body : draft.body === '' ? `Closes #${issue}` : `${draft.body}\n\nCloses #${issue}`
  return { title: draft.subject, body }
}

/** A commit message split into its subject line and the body after it. */
export function commitOf(message: string): DraftCommit {
  const [subject = '', ...rest] = message.trim().split('\n')
  return { subject: subject.trim(), body: rest.join('\n').trim() }
}

function taskLine(task: string | undefined, issue: number | undefined): string {
  const line =
    (task ?? '')
      .split('\n')
      .find((each) => each.trim() !== '')
      ?.trim() ?? ''
  return issue !== undefined && line.startsWith(`#${issue} `) ? line.slice(`#${issue} `.length).trim() : line
}
