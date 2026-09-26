// What a screen reader hears for a row: plain words joined by commas, from the models the chips draw.

import type { WorktreeMergePreview, WorktreeStatus } from '@shared/entities'
import type { RunState } from '@shared/runCommands'
import { dotTone, TONE_LABEL, type AgentRow, type DotTone } from './agentRows'
import type { OverlapChip } from './overlapChip'
import { summarizeWorktreeStatus } from './worktreeStatusSummary'

export type RowFacts = {
  tone?: DotTone | null
  /** The question an asking row shows. */
  question?: string | null
  /** The child task a folded row's tone comes from. */
  from?: string
  unread?: boolean
  /** Drawn only when it says more than the name. */
  branch?: string
  status?: WorktreeStatus
  /** Behind counts against the parent. */
  child?: boolean
  ignored?: number
  landed?: 'merged' | 'merged, not pushed' | 'landed'
  merge?: WorktreeMergePreview
  pullRequest?: number
  issue?: number
  ports?: readonly number[]
  overlap?: OverlapChip | null
  tests?: RunState
  claims?: readonly string[]
  tally?: { done: number; total: number }
  handoff?: string | null
  lifecycle?: 'creating' | 'failed' | 'missing'
  /** The row's `✓ …` or `✗ …` line. */
  report?: string | null
}

const SHOWN_FILES = 3

export function rowSpeech(facts: RowFacts): string {
  const summary = summarizeWorktreeStatus(facts.status, facts.child === true)
  const counts = summary?.description.split(' · ').filter((part) => part !== 'clean, in sync') ?? []
  const ports = facts.ports ?? []
  return [
    facts.lifecycle,
    facts.tone ? stateWord(facts.tone, facts.question ?? null) + (facts.from ? ` in ${facts.from}` : '') : null,
    facts.unread ? 'unread' : null,
    facts.branch === undefined ? null : `branch ${facts.branch}`,
    ...counts,
    facts.ignored ? `${facts.ignored} ignored` : null,
    facts.landed ?? (facts.merge === undefined ? null : mergeWords(facts.merge)),
    facts.pullRequest === undefined ? null : `PR ${facts.pullRequest}`,
    facts.issue === undefined ? null : `issue ${facts.issue}`,
    ports.length === 0 ? null : `${ports.length === 1 ? 'port' : 'ports'} ${ports.join(', ')}`,
    facts.overlap ? overlapWords(facts.overlap) : null,
    facts.tests === undefined || facts.tests === 'stopped' ? null : `tests ${facts.tests}`,
    facts.claims?.length ? `claims ${facts.claims.join(', ')}` : null,
    facts.tally ? `${facts.tally.done} of ${facts.tally.total} children done` : null,
    facts.handoff ? lowerFirst(facts.handoff) : null,
    facts.report ? reportWords(facts.report) : null
  ]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(', ')
}

/** A pane row: its name, its state with the line it shows, then who else is on it. */
export function paneRowSpeech(
  row: AgentRow,
  extra: { unread?: boolean; hands?: string | null; muted?: boolean } = {}
): string {
  return [
    row.label,
    lineWord(dotTone(row.activity, row.agent), row.evidence),
    extra.unread ? 'unread' : null,
    extra.hands ?? null,
    extra.muted ? 'muted' : null
  ]
    .filter(Boolean)
    .join(', ')
}

/** An All Panes row, which also names its worktree unless the pane already goes by it. */
export function boardRowSpeech(row: AgentRow & { worktreeName: string }, unread = false): string {
  return [
    row.label,
    row.label === row.worktreeName ? null : row.worktreeName,
    lineWord(dotTone(row.activity, row.agent), row.evidence),
    unread ? 'unread' : null
  ]
    .filter(Boolean)
    .join(', ')
}

/** The board's Tasks row, column by column. */
export function taskRowSpeech(row: {
  title: string
  stage: string
  tally?: { done: number; total: number }
  overlap?: OverlapChip | null
  panes: readonly { label: string; tone: DotTone }[]
  added: number | null
  removed: number | null
  ahead: number
  tokens?: string | null
  age: string
}): string {
  return [
    row.title,
    row.stage,
    row.tally ? `${row.tally.done} of ${row.tally.total} children done` : null,
    row.overlap ? overlapWords(row.overlap) : null,
    // A task's only agent goes by the task, and its state is the stage already said.
    ...row.panes.filter((pane) => pane.label !== row.title).map((pane) => `${pane.label} ${TONE_LABEL[pane.tone]}`),
    row.added ? `${row.added} added` : null,
    row.removed ? `${row.removed} removed` : null,
    row.ahead > 0 ? `${row.ahead} ahead` : null,
    row.tokens ?? null,
    `${row.age} old`
  ]
    .filter(Boolean)
    .join(', ')
}

function stateWord(tone: DotTone, question: string | null): string {
  return tone === 'waiting' && question ? `asking: ${question}` : TONE_LABEL[tone]
}

function lineWord(tone: DotTone, line: string | null): string {
  return line ? `${TONE_LABEL[tone]}: ${line}` : TONE_LABEL[tone]
}

function mergeWords(preview: WorktreeMergePreview): string | null {
  if (preview.state === 'clean') return 'merges cleanly'
  if (preview.state !== 'conflicts') return null
  return `would conflict with ${preview.baseRef} in ${files(preview.conflicts)}`
}

function overlapWords(chip: OverlapChip): string {
  const first = chip.entries[0]
  const who = first === undefined ? '' : ` ${first.name}`
  return chip.tone === 'conflict' ? `would conflict with${who} in ${chip.label}` : `overlaps${who} in ${chip.label}`
}

function files(paths: readonly string[]): string {
  const names = paths.slice(0, SHOWN_FILES).map((path) => path.slice(path.lastIndexOf('/') + 1))
  const rest = paths.length - names.length
  return rest > 0 ? `${names.join(', ')} and ${rest} more` : names.join(', ')
}

function reportWords(line: string): string {
  const failed = line.startsWith('✗')
  const text = line.replace(/^[✓✗]\s*/, '')
  return `${failed ? 'reported failure' : 'reported'}: ${text}`
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1)
}
