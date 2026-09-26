// Open GitHub issues through the user's own `gh`: a task can start from one.
// Never a token of ours; without a signed-in `gh` the answer is `available: false`.

import { execFile } from 'node:child_process'
import type { IssueEntry } from '../../shared/entities'

/** Enough for a task's text, which keeps less; bounds what one listing carries. */
export const MAX_ISSUE_BODY_CHARS = 8_000
const LIMIT = 100
const FIELDS = 'number,title,url,labels,body,updatedAt'

export type IssueRead = { available: boolean; reason: string | null; issues: IssueEntry[] }

export async function listIssues(gh: string | null, root: string): Promise<IssueRead> {
  if (gh === null) return { available: false, reason: 'Needs gh', issues: [] }
  let stdout: string
  try {
    stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        gh,
        ['issue', 'list', '--state', 'open', '--limit', String(LIMIT), '--json', FIELDS],
        {
          cwd: root,
          timeout: 20_000,
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' }
        },
        (error, out, err) => (error ? reject(new Error(String(err || error.message))) : resolve(out))
      )
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('gh auth login')) return { available: false, reason: 'Needs gh auth login', issues: [] }
    return { available: false, reason: message.trim().split('\n')[0] ?? '', issues: [] }
  }
  const issues = parseIssues(stdout)
  if (issues === null) return { available: false, reason: 'gh printed something that is not a list', issues: [] }
  return { available: true, reason: null, issues }
}

/** `gh issue list --json` output, or null when it is not a list; malformed entries are skipped. */
export function parseIssues(stdout: string): IssueEntry[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  return parsed.flatMap((entry: Record<string, unknown>) => {
    const { number, title, url, labels, body, updatedAt } = entry ?? {}
    if (typeof number !== 'number' || typeof title !== 'string' || typeof url !== 'string') return []
    const at = typeof updatedAt === 'string' ? Date.parse(updatedAt) : Number.NaN
    return [
      {
        number,
        title,
        url,
        labels: Array.isArray(labels)
          ? labels.flatMap((label: { name?: unknown }) => (typeof label?.name === 'string' ? [label.name] : []))
          : [],
        body: typeof body === 'string' ? body.replace(/\r\n?/g, '\n').slice(0, MAX_ISSUE_BODY_CHARS) : '',
        updatedAt: Number.isNaN(at) ? null : at
      }
    ]
  })
}
