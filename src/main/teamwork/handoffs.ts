// Worktrees handed to teammates, and the offers this machine took or dismissed. Kept in
// `<userData>/handoffs.json`, so an offer and its answer both outlive a restart.

import { z } from 'zod'
import { MAX_AGENT_ARGS_CHARS } from '../../shared/agentLaunch'
import type { Project, Worktree } from '../../shared/entities'
import { Params, type ParamsOf } from '../../shared/methods'
import { MAX_HANDOFF_BRIEF_CHARS, MAX_HANDOFF_NOTE_CHARS, MAX_HANDOFFS } from '../../shared/presenceExtras'
import type { MemoryNote } from '../../shared/memory'
import type { PeerHandoff, WorktreeOverlaps, WorktreeReport } from '../../shared/tasks'
import { GitServiceError } from '../git/errors'
import type { GitRunner } from '../git/gitProcess'
import { assertRefShape } from '../git/repository'
import type { MethodRegistry } from '../runtime/methodRegistry'
import { notFound } from '../runtime/runtimeError'
import { readJsonFile, writeJsonFileAtomically } from '../store/atomicJsonFile'
import type { PeerService } from './peer/peerService'

export const HANDOFFS_FILE = 'handoffs.json'

/** How many answered offers are remembered, so a sender still offering one is not asked again. */
export const MAX_SETTLED_HANDOFFS = MAX_HANDOFFS * 5

type Outgoing = PeerHandoff & { projectId: string; worktreeId: string }

/** An offer answered here; `from` is the sender's public key, since an id is theirs to choose. */
type Settled = { id: string; from: string; how: 'took' | 'dismissed' }

const OutgoingSchema = z.object({
  id: z.string().min(1),
  to: z.string().min(1),
  from: z.string().optional(),
  worktreeName: z.string(),
  branch: z.string().min(1),
  note: z.string().max(MAX_HANDOFF_NOTE_CHARS),
  brief: z.string().max(MAX_HANDOFF_BRIEF_CHARS).optional(),
  at: z.number(),
  projectId: z.string().min(1),
  worktreeId: z.string().min(1),
  takenAt: z.number().optional()
})

const FileSchema = z.object({
  outgoing: z.array(OutgoingSchema).catch([]),
  settled: z
    .array(z.object({ id: z.string().min(1), from: z.string().min(1), how: z.enum(['took', 'dismissed']) }))
    .catch([])
})

export class HandoffBook {
  #outgoing: Outgoing[] = []
  #settled: Settled[] = []
  #writing: Promise<void> = Promise.resolve()
  readonly #path: string | undefined
  readonly #onError: (error: unknown) => void

  constructor(path?: string, onError: (error: unknown) => void = () => {}) {
    this.#path = path
    this.#onError = onError
  }

  /** Reads the file; a missing or damaged one starts empty. */
  async load(): Promise<void> {
    if (this.#path === undefined) return
    const parsed = FileSchema.safeParse(await readJsonFile(this.#path))
    if (!parsed.success) return
    this.#outgoing = parsed.data.outgoing
    this.#settled = parsed.data.settled
  }

  /** Files an offer, replacing an untaken one of the same worktree. The oldest go past the bound, taken ones first. */
  offer(entry: Outgoing): void {
    const kept = this.#outgoing.filter(
      (held) => !(held.worktreeId === entry.worktreeId && held.takenAt === undefined) && held.id !== entry.id
    )
    kept.push({
      ...entry,
      note: entry.note.slice(0, MAX_HANDOFF_NOTE_CHARS),
      ...(entry.brief === undefined ? {} : { brief: entry.brief.slice(0, MAX_HANDOFF_BRIEF_CHARS) })
    })
    const mine = kept.filter((held) => held.projectId === entry.projectId)
    for (let excess = mine.length - MAX_HANDOFFS; excess > 0; excess -= 1) {
      const drop = mine.find((held) => held.takenAt !== undefined) ?? mine[0]
      mine.splice(mine.indexOf(drop as Outgoing), 1)
      kept.splice(kept.indexOf(drop as Outgoing), 1)
    }
    this.#outgoing = kept
    this.#save()
  }

  outgoing(projectId: string): PeerHandoff[] {
    return this.#outgoing
      .filter((held) => held.projectId === projectId)
      .map(({ projectId: _projectId, ...handoff }) => handoff)
  }

  /** What presence carries to one teammate: their untaken offers, without this machine's own ids. */
  sendTo(projectIds: readonly string[], handle: string): PeerHandoff[] {
    return this.#outgoing
      .filter((held) => held.to === handle && held.takenAt === undefined && projectIds.includes(held.projectId))
      .map(({ id, to, from, worktreeName, branch, note, brief, at }) => ({
        id,
        to,
        ...(from === undefined ? {} : { from }),
        worktreeName,
        branch,
        note,
        ...(brief === undefined ? {} : { brief }),
        at
      }))
  }

  /** Worktrees whose offer was taken: the work lives on the teammate's machine now. */
  handedAway(): Set<string> {
    return new Set(this.#outgoing.filter((held) => held.takenAt !== undefined).map((held) => held.worktreeId))
  }

  /** Marks the offers to `handle` among `ids` as taken; whether any was. */
  markTaken(projectIds: readonly string[], handle: string, ids: readonly string[], at: number): boolean {
    let changed = false
    for (const held of this.#outgoing) {
      if (held.takenAt !== undefined || held.to !== handle || !projectIds.includes(held.projectId)) continue
      if (!ids.includes(held.id)) continue
      held.takenAt = at
      changed = true
    }
    if (changed) this.#save()
    return changed
  }

  settle(id: string, from: string, how: Settled['how']): void {
    this.#settled = [...this.#settled.filter((held) => !(held.id === id && held.from === from)), { id, from, how }]
    this.#settled = this.#settled.slice(-MAX_SETTLED_HANDOFFS)
    this.#save()
  }

  isSettled(id: string, from: string): boolean {
    return this.#settled.some((held) => held.id === id && held.from === from)
  }

  /** The offers from one teammate this machine took: presence carries them back so their row can say so. */
  tookFrom(publicKey: string): string[] {
    return this.#settled.filter((held) => held.from === publicKey && held.how === 'took').map((held) => held.id)
  }

  /** Resolves once every change so far is on disk. */
  flush(): Promise<void> {
    return this.#writing
  }

  #save(): void {
    const path = this.#path
    if (path === undefined) return
    const snapshot = { outgoing: this.#outgoing, settled: this.#settled }
    this.#writing = this.#writing
      .then(() => writeJsonFileAtomically(path, snapshot))
      .catch((error: unknown) => this.#onError(error))
  }
}

export type HandoffPorts = {
  peers: Pick<PeerService, 'handoffs' | 'handoffTarget' | 'offerHandoff' | 'incomingHandoff' | 'settleHandoff'>
  worktree: (worktreeId: string) => Worktree | undefined
  project: (projectId: string) => Project | undefined
  /** Push as the Changes tab does: publishes a branch that tracks nothing, refuses with no remote. */
  push: (worktreeId: string) => Promise<unknown>
  /** Commits every change, as the Changes tab's commit with everything staged. */
  commit: (worktreeId: string, message: string) => Promise<unknown>
  /** Interrupts the worktree's running agent panes; how many there were. */
  stopAgents: (worktreeId: string) => Promise<number>
  runner: GitRunner
  create: (params: ParamsOf<'worktree.create'>) => Promise<Worktree>
  /** The worktree once its create has finished, ready or failed. */
  settled: (worktreeId: string) => Promise<Worktree>
  startAgent: (worktreeId: string, command: string, prompt: string | undefined) => void
  /** The ledger's notes on one worktree. */
  notes: (worktree: Worktree) => Promise<readonly MemoryNote[]>
  /** Subjects of the worktree's own commits, newest first. */
  commits: (worktreeId: string) => Promise<readonly string[]>
  onError: (error: unknown) => void
}

export function registerHandoffHandlers(registry: MethodRegistry, ports: HandoffPorts): void {
  registry.register('teamwork.handoffs', Params.teamworkHandoffs, (params) => ports.peers.handoffs(params))

  registry.register(
    'teamwork.handOff',
    Params.teamworkHandOff,
    async ({ worktreeId, to, note, commit, stopAgents }) => {
      const worktree = ports.worktree(worktreeId)
      if (!worktree) throw notFound(`no worktree with id ${worktreeId}`)
      // Before the push: nothing leaves this machine for someone who is not on the roster.
      ports.peers.handoffTarget(worktree.projectId, to)
      // Stopped first, so nothing the agent writes lands after the commit that carries the work.
      if (stopAgents === true) await ports.stopAgents(worktree.id)
      if (commit !== undefined) await commitAll(ports, worktree.id, commit)
      await ports.push(worktree.id)
      const brief = await briefFor(ports, worktree)
      return ports.peers.offerHandoff({ worktree, to, note, ...(brief === '' ? {} : { brief }) })
    }
  )

  registry.register('teamwork.take', Params.teamworkTake, async ({ projectId, id, agent }) => {
    const handoff = ports.peers.incomingHandoff(projectId, id)
    const project = ports.project(projectId)
    if (!project) throw notFound(`no project with id ${projectId}`)
    await fetchBranch(ports.runner, project.path, handoff.branch)
    const note = handoff.note.trim()
    const worktree = await ports.create({
      projectId,
      name: handoff.worktreeName.trim() || handoff.branch,
      checkout: `origin/${handoff.branch}`,
      ...(note === '' ? {} : { task: note })
    })
    ports.peers.settleHandoff(projectId, id, 'took')
    if (agent !== undefined) {
      void ports
        .settled(worktree.id)
        .then((ready) => {
          if (ready.state !== 'ready') return
          const from = handoff.from === undefined ? {} : { from: handoff.from }
          ports.startAgent(ready.id, agent, continuationPrompt({ ...from, note, brief: handoff.brief }))
        })
        .catch(ports.onError)
    }
    return worktree
  })

  registry.register('teamwork.dismissHandoff', Params.teamworkDismissHandoff, ({ projectId, id }) => {
    ports.peers.settleHandoff(projectId, id, 'dismissed')
    return { dismissed: true as const }
  })

  registry.register('teamwork.handoffDraft', Params.teamworkHandoffDraft, async ({ worktreeId }) => {
    const worktree = ports.worktree(worktreeId)
    if (!worktree) throw notFound(`no worktree with id ${worktreeId}`)
    // The ledger is a nicety: unreadable, the draft is the task alone.
    const notes = await ports.notes(worktree).catch(() => [])
    const decisions = notes.filter((note) => note.worktreeId === worktreeId && note.kind === 'decision')
    return {
      note: handoffDraft({ task: worktree.task, decisions: decisions.map((note) => note.text) })
    }
  })

  // A copy handed away and taken is the teammate's work now; its overlaps are with itself.
  const overlaps = registry.lookup('worktree.overlaps')
  if (overlaps !== undefined) {
    registry.register('worktree.overlaps', Params.worktreeOverlaps, async (params, call) => {
      const read = (await overlaps.handler(params as never, call)) as WorktreeOverlaps
      const handed = new Set(
        ports.peers
          .handoffs({ projectId: params.projectId })
          .outgoing.flatMap((held) => (held.takenAt === undefined || !held.worktreeId ? [] : [held.worktreeId]))
      )
      if (handed.size === 0) return read
      const kept = read.overlaps.filter(
        (overlap) =>
          !handed.has(overlap.worktreeId) &&
          !('worktreeId' in overlap.with && handed.has(overlap.with.worktreeId ?? ''))
      )
      return { ...read, overlaps: kept }
    })
  }
}

const BRIEF_FILES = 20

/** The task, then what the ledger decided; clipped to the note's bound. */
export function handoffDraft(sources: { task: string | undefined; decisions: readonly string[] }): string {
  return [...(sources.task?.trim() ? [sources.task.trim()] : []), ...list('Decided', sources.decisions)]
    .join('\n\n')
    .slice(0, MAX_HANDOFF_NOTE_CHARS)
}

/** What the receiver's agent is told besides the note: the task's first line, commits, files, report, open questions. */
export function handoffBrief(sources: {
  task: string | undefined
  base: string
  commits: readonly string[]
  files: readonly string[]
  report?: Pick<WorktreeReport, 'outcome' | 'summary'>
  questions: readonly string[]
}): string {
  const task = sources.task?.trim().split('\n')[0]?.trim()
  const shown = sources.files.slice(0, BRIEF_FILES)
  const more = sources.files.length - shown.length
  return [
    ...(task ? [`Task: ${task}`] : []),
    ...list(`Commits since ${sources.base}`, sources.commits),
    ...list(`Files changed (${sources.files.length})`, more > 0 ? [...shown, `+${more} more`] : shown),
    ...(sources.report?.summary.trim() ? [`Report (${sources.report.outcome}): ${sources.report.summary.trim()}`] : []),
    ...list('Open questions', sources.questions)
  ]
    .join('\n\n')
    .slice(0, MAX_HANDOFF_BRIEF_CHARS)
}

/** The receiver's first prompt: who handed it over, their note, then the brief; within one command line. */
export function continuationPrompt(handoff: { from?: string; note: string; brief: string | undefined }): string {
  const who = handoff.from ?? 'A teammate'
  const note = handoff.note.trim()
  return [
    `${who} handed this task over. Their work is committed on this branch; continue from it.`,
    ...(note === '' ? [] : [`Note from ${handoff.from ?? 'them'}:\n${note}`]),
    ...(handoff.brief?.trim() ? [handoff.brief.trim()] : [])
  ]
    .join('\n\n')
    .slice(0, MAX_AGENT_ARGS_CHARS)
}

function list(title: string, lines: readonly string[]): string[] {
  return lines.length === 0 ? [] : [`${title}:\n${lines.map((line) => `- ${line}`).join('\n')}`]
}

/** A clean worktree has nothing to carry: that refusal is not a failed hand-off. */
async function commitAll(ports: HandoffPorts, worktreeId: string, message: string): Promise<void> {
  try {
    await ports.commit(worktreeId, message)
  } catch (error) {
    if (!(error instanceof GitServiceError && error.message === 'nothing to commit')) throw error
  }
}

/** Read after the push, so it names the commit that carried the work; a source that fails is left out. */
async function briefFor(ports: HandoffPorts, worktree: Worktree): Promise<string> {
  const [commits, files, notes] = await Promise.all([
    ports.commits(worktree.id).catch(() => []),
    changedFiles(ports.runner, worktree).catch(() => []),
    ports.notes(worktree).catch(() => [])
  ])
  const questions = notes.filter(
    (note) => note.worktreeId === worktree.id && note.kind === 'question' && note.open === true
  )
  return handoffBrief({
    task: worktree.task,
    // Named as the user knows it; a worktree records the sha it started from.
    base: worktree.baseRef ?? ports.project(worktree.projectId)?.baseRef ?? worktree.startedFrom,
    commits,
    files,
    ...(worktree.report === undefined ? {} : { report: worktree.report }),
    questions: questions.map((note) => note.text)
  })
}

async function changedFiles(runner: GitRunner, worktree: Worktree): Promise<string[]> {
  assertRefShape(worktree.startedFrom, 'base')
  const { stdout } = await runner.run({
    args: ['diff', '--name-only', `${worktree.startedFrom}...HEAD`, '--'],
    cwd: worktree.path,
    readOnly: true,
    timeoutMs: 60_000
  })
  return stdout.split('\n').filter((line) => line !== '')
}

/** Brings the sender's branch to `origin/<branch>` here, so Open Branch's checkout finds it. */
async function fetchBranch(runner: GitRunner, repoPath: string, branch: string): Promise<void> {
  assertRefShape(branch, 'branch')
  await runner.run({
    args: ['fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
    cwd: repoPath,
    timeoutMs: 10 * 60_000
  })
}
