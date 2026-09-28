// The commit message a worktree's boxes start with: the agent's done report, else its task. Only a
// suggestion; one typed is never replaced, and the draft is shared by the Changes box and the merge dialog.

import { useMemo } from 'react'
import { create } from 'zustand'
import type { Worktree } from '@shared/entities'
import { closesIssue } from '@shared/issueClosing'
import { useWorkspaceStore } from '../../state/workspaceStore'

const SUBJECT_MAX = 72
const BODY_WIDTH = 72
/** A body line this short is kept as written: the report may be a list or hand-wrapped. */
const KEEP_WIDTH = 80

export type CommitSuggestion = { text: string; from: 'report' | 'task' }

/** The report's first line as the subject and the rest as the body; else the task's first line; with `Closes #N` for an issue. */
export function commitSuggestion(
  worktree: Pick<Worktree, 'report' | 'task' | 'issue'> | undefined
): CommitSuggestion | null {
  if (worktree === undefined) return null
  const issue = worktree.issue?.number
  const summary = worktree.report?.outcome === 'succeeded' ? worktree.report.summary.trim() : ''
  if (summary !== '') return { text: closing(commitMessageOf(summary), issue), from: 'report' }
  let line = firstLine(worktree.task ?? '')
  if (issue !== undefined && line.startsWith(`#${issue} `)) line = line.slice(`#${issue} `.length).trim()
  return line === '' ? null : { text: closing(commitMessageOf(line), issue), from: 'task' }
}

/** Subject of at most 72, a blank line, then the body with lines past 80 wrapped at 72. */
export function commitMessageOf(text: string): string {
  const lines = text.trim().split('\n')
  const [subject, carried] = splitSubject((lines[0] ?? '').trim())
  const body = [...(carried === '' ? [] : [carried]), ...lines.slice(1)]
    .map((line) => line.trimEnd())
    .flatMap((line) => (line.length <= KEEP_WIDTH ? [line] : wrap(line)))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return body === '' ? subject : `${subject}\n\n${body}`
}

function splitSubject(line: string): [string, string] {
  if (line.length <= SUBJECT_MAX) return [line, '']
  const sentence = line.slice(0, SUBJECT_MAX + 1).match(/^.*[.!?](?=\s)/)?.[0]
  if (sentence !== undefined) return [sentence, line.slice(sentence.length).trim()]
  const space = line.lastIndexOf(' ', SUBJECT_MAX - 1)
  const cut = space > 0 ? space : SUBJECT_MAX - 1
  return [`${line.slice(0, cut).trimEnd()}…`, `…${line.slice(cut).trimStart()}`]
}

/** Greedy word wrap at the body width; a list item's continuation hangs under its text, and no word is broken. */
function wrap(line: string): string[] {
  const marker = line.match(/^\s*(?:(?:[-*+]|\d+[.)])\s+)?/)?.[0] ?? ''
  const hang = ' '.repeat(marker.length)
  const [first = '', ...words] = line.slice(marker.length).trim().split(/\s+/)
  const out: string[] = []
  let current = `${marker}${first}`
  for (const word of words) {
    if (current.length + 1 + word.length <= BODY_WIDTH) current = `${current} ${word}`
    else {
      out.push(current)
      current = `${hang}${word}`
    }
  }
  return [...out, current]
}

function closing(message: string, issue: number | undefined): string {
  if (issue === undefined) return message
  return closesIssue(message, issue) ? message : `${message}\n\nCloses #${issue}`
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
  )
}

/** What was typed, and the suggestion on offer when it was typed. */
export type CommitDraft = { text: string; seed: string | null }

/** The suggestion until something is typed; a new one replaces only an empty box or its own untouched text. */
export function shownDraft(
  stored: CommitDraft | undefined,
  suggestion: CommitSuggestion | null
): { text: string; from: CommitSuggestion['from'] | null } {
  const offer = { text: suggestion?.text ?? '', from: suggestion?.from ?? null }
  if (stored === undefined) return offer
  const fresh = stored.seed !== (suggestion?.text ?? null)
  if (fresh && (stored.text === '' || stored.text === stored.seed)) return offer
  return { text: stored.text, from: suggestion !== null && stored.text === suggestion.text ? suggestion.from : null }
}

type DraftState = {
  drafts: Record<string, CommitDraft>
  /** The message an Amend under way will write, kept apart so leaving it gives the draft back. */
  amends: Record<string, string>
  setDraft: (worktreeId: string, draft: CommitDraft) => void
  /** Starts or edits an Amend's message; null leaves Amend. */
  setAmend: (worktreeId: string, text: string | null) => void
}

export const useCommitDrafts = create<DraftState>((set) => ({
  drafts: {},
  amends: {},
  setDraft: (worktreeId, draft) => set((state) => ({ drafts: { ...state.drafts, [worktreeId]: draft } })),
  setAmend: (worktreeId, text) =>
    set((state) => {
      const { [worktreeId]: _left, ...amends } = state.amends
      return { amends: text === null ? amends : { ...amends, [worktreeId]: text } }
    })
}))

/**
 * One worktree's commit message, kept across tab changes; `from` is set while it is still the suggestion.
 * `typed` is only what was typed or taken, for a box that offers the suggestion rather than starting with it.
 */
export function useCommitMessage(worktreeId: string | null): {
  message: string
  from: CommitSuggestion['from'] | null
  typed: string
  suggestion: CommitSuggestion | null
  setMessage: (text: string) => void
} {
  const worktree = useWorkspaceStore((state) => state.worktrees.find((entry) => entry.id === worktreeId))
  const { report, task, issue } = worktree ?? {}
  const suggestion = useMemo(() => commitSuggestion({ report, task, issue }), [report, task, issue])
  const stored = useCommitDrafts((state) => (worktreeId === null ? undefined : state.drafts[worktreeId]))
  const setDraft = useCommitDrafts((state) => state.setDraft)
  const shown = shownDraft(stored, suggestion)
  return {
    message: shown.text,
    from: shown.from,
    typed: stored?.text ?? '',
    suggestion,
    setMessage: (text) => {
      if (worktreeId !== null) setDraft(worktreeId, { text, seed: suggestion?.text ?? null })
    }
  }
}
