// Worktrees handed to teammates, and the offers this machine took or dismissed. Kept in
// `<userData>/handoffs.json`, so an offer and its answer both outlive a restart.

import { z } from 'zod'
import type { Project, Worktree } from '../../shared/entities'
import { Params, type ParamsOf } from '../../shared/methods'
import { MAX_HANDOFF_NOTE_CHARS, MAX_HANDOFFS } from '../../shared/presenceExtras'
import type { MemoryNote } from '../../shared/memory'
import type { PeerHandoff } from '../../shared/tasks'
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
    kept.push({ ...entry, note: entry.note.slice(0, MAX_HANDOFF_NOTE_CHARS) })
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
      .map(({ id, to, from, worktreeName, branch, note, at }) => ({
        id,
        to,
        ...(from === undefined ? {} : { from }),
        worktreeName,
        branch,
        note,
        at
      }))
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

  registry.register('teamwork.handOff', Params.teamworkHandOff, async ({ worktreeId, to, note }) => {
    const worktree = ports.worktree(worktreeId)
    if (!worktree) throw notFound(`no worktree with id ${worktreeId}`)
    // Before the push: nothing leaves this machine for someone who is not on the roster.
    ports.peers.handoffTarget(worktree.projectId, to)
    await ports.push(worktree.id)
    return ports.peers.offerHandoff({ worktree, to, note })
  })

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
          if (ready.state === 'ready') ports.startAgent(ready.id, agent, note === '' ? undefined : note)
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
    // Each source is a nicety: one that cannot be read leaves its part out.
    const [notes, commits] = await Promise.all([
      ports.notes(worktree).catch(() => []),
      ports.commits(worktreeId).catch(() => [])
    ])
    const mine = notes.filter((note) => note.worktreeId === worktreeId)
    return {
      note: handoffDraft({
        task: worktree.task,
        decisions: mine.filter((note) => note.kind === 'decision').map((note) => note.text),
        questions: mine.filter((note) => note.kind === 'question' && note.open === true).map((note) => note.text),
        commits: commits.slice(0, DRAFT_COMMITS)
      })
    }
  })
}

const DRAFT_COMMITS = 5

/** The task, then what the ledger decided and left open, then the latest commits; clipped to the note's bound. */
export function handoffDraft(sources: {
  task: string | undefined
  decisions: readonly string[]
  questions: readonly string[]
  commits: readonly string[]
}): string {
  const list = (title: string, lines: readonly string[]): string[] =>
    lines.length === 0 ? [] : [`${title}:\n${lines.map((line) => `- ${line}`).join('\n')}`]
  return [
    ...(sources.task?.trim() ? [sources.task.trim()] : []),
    ...list('Decided', sources.decisions),
    ...list('Open', sources.questions),
    ...list('Commits', sources.commits)
  ]
    .join('\n\n')
    .slice(0, MAX_HANDOFF_NOTE_CHARS)
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
