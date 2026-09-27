// The Jac Graph Memory add-on's answers: conflict risk one co-change hop out, why a file is
// as it is, and earlier work like a task. Validated at the boundary; the ledger answers without it.

import { z } from 'zod'

const Id = z.string().min(1).max(256)
const Path = z.string().min(1).max(4096)
const Text = (max: number) => z.string().max(max)

/** What the add-on answers with over the provider protocol, and what teamree asks it. */
export type GraphAsk =
  | { walker: 'conflict_risk'; worktreeId: string; paths: string[]; teammates?: GraphTeammate[] }
  | { walker: 'why_file'; path: string }
  | { walker: 'related_work'; worktreeId: string; query?: string }

/** A teammate's live worktree as presence carries it: paths only. */
export type GraphTeammate = { handle: string; worktreeId: string; name?: string; paths: string[] }

/** Why a file matters to another worktree: it touches or claims it, or it usually changes with one you plan to. */
export type RiskKind = 'conflict' | 'touched' | 'claimed' | 'co-change'

const RiskRowSchema = z.object({
  path: Path,
  kind: z.enum(['conflict', 'touched', 'claimed', 'co-change']),
  worktreeId: Text(256),
  name: Text(512),
  owner: Text(256),
  score: z.number().optional(),
  /** Co-change: the planned file this one usually changes with. */
  via: Path.optional(),
  together: z.number().int().nonnegative().optional(),
  of: z.number().int().nonnegative().optional()
})

export type RiskRow = z.infer<typeof RiskRowSchema>

const PredictedSchema = z.object({
  path: Path,
  with: Path,
  together: z.number().int().nonnegative(),
  of: z.number().int().nonnegative()
})

const WhyTaskSchema = z.object({
  key: Text(256),
  name: Text(512),
  branch: Text(512),
  pr: z.number().int().nonnegative(),
  goal: Text(512),
  at: z.number(),
  outcome: Text(32),
  reasons: z.array(Text(512)).max(5)
})

const WhyDecisionSchema = z.object({ text: Text(1024), at: z.number(), worktree: Text(512), outcome: Text(32) })

export const RelatedTaskSchema = z.object({
  key: Text(256),
  name: Text(512),
  branch: Text(512),
  pr: z.number().int().nonnegative(),
  goal: Text(512),
  at: z.number(),
  outcome: Text(32),
  score: z.number(),
  files: z.array(Path).max(10),
  terms: z.array(Text(64)).max(10),
  decisions: z.array(Text(512)).max(5)
})

export type RelatedTask = z.infer<typeof RelatedTaskSchema>

/** One walker's answer; anything else from the add-on is a failure. */
export const GraphAnswerSchema = z.discriminatedUnion('walker', [
  z.object({
    walker: z.literal('conflict_risk'),
    rows: z.array(RiskRowSchema).max(50),
    predicted: z.array(PredictedSchema).max(20)
  }),
  z.object({
    walker: z.literal('why_file'),
    path: Path,
    changes: z.number().int().nonnegative(),
    tasks: z.array(WhyTaskSchema).max(20),
    decisions: z.array(WhyDecisionSchema).max(20),
    people: z.array(z.object({ name: Text(256), commits: z.number().int().nonnegative() })).max(10)
  }),
  z.object({ walker: z.literal('related_work'), tasks: z.array(RelatedTaskSchema).max(10) })
])

export type GraphAnswer = z.infer<typeof GraphAnswerSchema>

export type WhyTask = z.infer<typeof WhyTaskSchema>
export type WhyDecision = z.infer<typeof WhyDecisionSchema>

/** `source` says who answered: the add-on, or the ledger alone when it is off, failed or slow. */
export type GraphSource = 'jac-memory' | 'ledger'

export type ConflictRisk = {
  worktreeId: string
  source: GraphSource
  /** Most telling first. */
  rows: RiskRow[]
  /** Files the plan will likely need besides its own, from history. */
  predicted: z.infer<typeof PredictedSchema>[]
  text: string
}

export type FileWhy = {
  path: string
  source: GraphSource
  /** Commits that changed it, as far as history was read. */
  changes: number
  /** Newest first. */
  tasks: WhyTask[]
  decisions: WhyDecision[]
  people: { name: string; commits: number }[]
  text: string
}

export const GraphParams = {
  /** Without `paths`, the worktree's own touched files. */
  memoryRisk: z.object({ worktreeId: Id, paths: z.array(Path).max(50).optional() }),
  memoryWhy: z.object({ worktreeId: Id, path: Path })
} as const

type P = typeof GraphParams

export type GraphMethodContract = {
  'memory.risk': { params: z.infer<P['memoryRisk']>; result: ConflictRisk }
  'memory.why': { params: z.infer<P['memoryWhy']>; result: FileWhy }
}
