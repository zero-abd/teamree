// Advisory claims on the coordination ledger: path globs a worktree says it owns.
// Merged into the contract through taskMethods.ts. Claims never lock anything.

import { z } from 'zod'
import type { MemoryNote } from './memory'

/** Most globs one worktree may claim. */
export const MAX_CLAIM_GLOBS = 50

const Id = z.string().min(1).max(256)
const Glob = z.string().trim().min(1).max(512)

export const LedgerParams = {
  memoryClaim: z.object({ worktreeId: Id, globs: z.array(Glob).min(1).max(MAX_CLAIM_GLOBS) }),
  /** Without `globs`, every claim goes. */
  memoryUnclaim: z.object({ worktreeId: Id, globs: z.array(Glob).max(MAX_CLAIM_GLOBS).optional() }),
  /** One of `worktreeId` or `terminalId`. `hook`: asked before an agent's edit, so logged and said once. */
  memoryCheck: z.object({
    worktreeId: Id.optional(),
    terminalId: Id.optional(),
    path: z.string().min(1).max(4096),
    hook: z.boolean().optional()
  }),
  memoryList: z.object({ projectId: Id })
} as const

/** A worktree's claims after the change, repo-relative globs. */
export type WorktreeClaims = { worktreeId: string; globs: string[] }

/** Why a sibling matters to one file: a merge-tree conflict, its claim, or its changes. */
export type EditOverlapKind = 'conflict' | 'claimed' | 'changed'

/** Siblings sharing one file; `text` is the one to three lines an agent is told, empty when nothing new. */
export type EditCheck = {
  worktreeId: string
  /** Repo-relative, or as given when outside the worktree. */
  path: string
  siblings: { worktreeId: string; name: string; goal: string; kind: EditOverlapKind }[]
  text: string
}

/** A project's ledger for the window: each live worktree's claims and touched paths, and every note. */
export type ProjectMemory = {
  projectId: string
  revision: number
  worktrees: { worktreeId: string; claims: string[]; touched: string[] }[]
  notes: MemoryNote[]
}

type P = typeof LedgerParams

export type LedgerMethodContract = {
  'memory.claim': { params: z.infer<P['memoryClaim']>; result: WorktreeClaims }
  'memory.unclaim': { params: z.infer<P['memoryUnclaim']>; result: WorktreeClaims }
  'memory.check': { params: z.infer<P['memoryCheck']>; result: EditCheck }
  'memory.list': { params: z.infer<P['memoryList']>; result: ProjectMemory }
}
