// The graph answers as the few lines an agent or a person reads, and the ledger's own
// answer to "why is this file like this" when the add-on is off: its last commits.

import type { ConflictRisk, FileWhy, RiskRow, WhyTask } from '../../shared/graphMemory'
import type { GitRunner } from '../git/gitProcess'

const RISKS_SHOWN = 6
const COMMITS_READ = 5
const TIMEOUT_MS = 10_000

/** `src/api.ts usually changes with src/db.ts (3 of 4 commits), which pool-sizes is changing.` */
export function likelyLine(row: RiskRow): string {
  const who = row.owner === 'me' ? row.name : `${row.owner}'s ${row.name}`
  const count = row.together !== undefined && row.of !== undefined ? ` (${row.together} of ${row.of} commits)` : ''
  return `${row.via ?? ''} usually changes with ${row.path}${count}, which ${who} is changing.`
}

export function riskText(rows: readonly RiskRow[], predicted: ConflictRisk['predicted']): string {
  const lines = rows.slice(0, RISKS_SHOWN).map((row) => {
    if (row.kind === 'co-change') return likelyLine(row)
    const who = row.owner === 'me' ? row.name : `${row.owner}'s ${row.name}`
    if (row.kind === 'conflict') return `${who} also changes ${row.path} — would conflict.`
    return row.kind === 'claimed' ? `${who} claims ${row.path}.` : `${who} also changes ${row.path}.`
  })
  if (rows.length > RISKS_SHOWN) lines.push(`(+${rows.length - RISKS_SHOWN} more)`)
  const likely = predicted.filter((guess) => !rows.some((row) => row.path === guess.path)).slice(0, 3)
  if (likely.length > 0) lines.push(`likely also: ${likely.map((guess) => guess.path).join(', ')}`)
  return lines.join('\n')
}

export function whyText(why: Omit<FileWhy, 'text'>): string {
  const lines: string[] = []
  for (const task of why.tasks) {
    lines.push(`${taskLabel(task)}: ${task.goal}`)
    for (const reason of task.reasons) if (reason !== task.goal) lines.push(`  - ${reason}`)
  }
  for (const decision of why.decisions) {
    lines.push(`decided${decision.worktree === '' ? '' : ` in ${decision.worktree}`}: ${decision.text}`)
  }
  if (why.people.length > 0) lines.push(`by ${why.people.map((who) => `${who.name} (${who.commits})`).join(', ')}`)
  return lines.join('\n')
}

function taskLabel(task: WhyTask): string {
  const when = task.at > 0 ? ` ${new Date(task.at * 1000).toISOString().slice(0, 10)}` : ''
  return task.pr > 0 ? `#${task.pr} ${task.name}${when}` : `${task.name.slice(0, 80)}${when}`
}

/** The last commits to touch `path` in this checkout, as tasks of one commit each. */
export async function commitWhy(
  runner: GitRunner,
  cwd: string,
  path: string
): Promise<Pick<FileWhy, 'changes' | 'tasks' | 'people'>> {
  const empty = { changes: 0, tasks: [], people: [] }
  const run = { cwd, readOnly: true, timeoutMs: TIMEOUT_MS } as const
  try {
    const log = await runner.tryRun({
      args: ['log', `-n${COMMITS_READ}`, '--format=%H%x1f%an%x1f%at%x1f%s', '--', path],
      ...run
    })
    const counted = await runner.tryRun({ args: ['rev-list', '--count', 'HEAD', '--', path], ...run })
    if (log.exitCode !== 0) return empty
    const people = new Map<string, number>()
    const tasks: WhyTask[] = log.stdout
      .split('\n')
      .filter((line) => line.includes('\x1f'))
      .map((line) => {
        const [sha = '', author = '', at = '0', subject = ''] = line.split('\x1f')
        people.set(author, (people.get(author) ?? 0) + 1)
        const pr = /\(#(\d+)\)$/.exec(subject)?.[1]
        return {
          key: `commit:${sha.slice(0, 12)}`,
          name: subject,
          branch: '',
          pr: pr === undefined ? 0 : Number(pr),
          goal: subject,
          at: Number(at) || 0,
          outcome: 'merged',
          reasons: []
        }
      })
    return {
      changes: counted.exitCode === 0 ? Number(counted.stdout.trim()) || tasks.length : tasks.length,
      tasks,
      people: [...people].map(([name, commits]) => ({ name, commits })).sort((a, b) => b.commits - a.commits)
    }
  } catch {
    return empty
  }
}
