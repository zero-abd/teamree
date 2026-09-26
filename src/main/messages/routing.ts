// Who a message goes to: an address made concrete against the worktrees and panes
// there are now. `children` and `siblings` fan out; a parent that cannot answer is you.

import type { Terminal, Worktree } from '../../shared/entities'
import type { MessageAddress, MessageKind, MessageParty } from '../../shared/messages'
import { conflict, notFound } from '../runtime/runtimeError'

export type Directory = {
  worktrees: readonly Worktree[]
  terminals: readonly Terminal[]
}

/** The sender with its worktree filled in from its pane, or refused when either is unknown. */
export function senderOf(from: MessageParty, directory: Directory): MessageParty {
  if (from.you === true && from.worktreeId === undefined && from.terminalId === undefined) return { you: true }
  const pane = from.terminalId === undefined ? undefined : directory.terminals.find((t) => t.id === from.terminalId)
  if (from.terminalId !== undefined && pane === undefined) throw notFound(`no pane ${from.terminalId}`)
  const worktreeId = from.worktreeId ?? pane?.worktreeId
  if (worktreeId === undefined || !directory.worktrees.some((worktree) => worktree.id === worktreeId)) {
    throw notFound(`no worktree ${worktreeId ?? ''}`.trim())
  }
  return { worktreeId, ...(from.terminalId === undefined ? {} : { terminalId: from.terminalId }) }
}

export function recipientsOf(
  from: MessageParty,
  to: MessageAddress,
  kind: MessageKind,
  directory: Directory
): MessageParty[] {
  if ('relation' in to) return related(from, to.relation, kind, directory)
  if (to.you === true) return [{ you: true }]
  if (to.terminalId !== undefined) {
    const pane = directory.terminals.find((terminal) => terminal.id === to.terminalId)
    if (pane === undefined) throw notFound(`no pane ${to.terminalId}`)
    if (!runsAgent(pane)) throw conflict(`${pane.id} runs no agent`)
    return [{ worktreeId: pane.worktreeId, terminalId: pane.id }]
  }
  const worktree = directory.worktrees.find((entry) => entry.id === to.worktreeId)
  if (worktree === undefined) throw notFound(`no worktree ${to.worktreeId ?? ''}`.trim())
  return [{ worktreeId: worktree.id }]
}

function related(
  from: MessageParty,
  relation: 'parent' | 'children' | 'siblings',
  kind: MessageKind,
  directory: Directory
): MessageParty[] {
  const me = directory.worktrees.find((worktree) => worktree.id === from.worktreeId)
  if (me === undefined) throw conflict(`${relation} of whom? not sent from a worktree`)
  if (relation === 'parent') {
    const parent = directory.worktrees.find((worktree) => worktree.id === me.parentId)
    if (parent === undefined) return [{ you: true }]
    // A question nobody can read would wait forever; `done` waits on the parent's row instead.
    if (kind !== 'done' && !hasAgent(parent.id, directory)) return [{ you: true }]
    return [{ worktreeId: parent.id }]
  }
  const found = directory.worktrees.filter((worktree) =>
    relation === 'children'
      ? worktree.parentId === me.id
      : worktree.id !== me.id && worktree.projectId === me.projectId && worktree.parentId === me.parentId
  )
  if (found.length === 0) throw notFound(`"${me.name}" has no ${relation}`)
  return found.map((worktree) => ({ worktreeId: worktree.id }))
}

/** A pane an agent is running in, started as one or typed into its shell. */
export function runsAgent(terminal: Terminal): boolean {
  return (terminal.agent ?? terminal.foregroundAgent) !== undefined
}

function hasAgent(worktreeId: string, directory: Directory): boolean {
  return directory.terminals.some(
    (terminal) => terminal.worktreeId === worktreeId && terminal.running && runsAgent(terminal)
  )
}
