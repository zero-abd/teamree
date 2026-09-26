// Advisory claims on the coordination ledger: path globs a worktree says it owns.
// Merged into the contract through taskMethods.ts. Claims never lock anything.

import { z } from 'zod'

/** Most globs one worktree may claim. */
export const MAX_CLAIM_GLOBS = 50

const Id = z.string().min(1).max(256)
const Glob = z.string().trim().min(1).max(512)

export const LedgerParams = {
  memoryClaim: z.object({ worktreeId: Id, globs: z.array(Glob).min(1).max(MAX_CLAIM_GLOBS) }),
  /** Without `globs`, every claim goes. */
  memoryUnclaim: z.object({ worktreeId: Id, globs: z.array(Glob).max(MAX_CLAIM_GLOBS).optional() })
} as const

/** A worktree's claims after the change, repo-relative globs. */
export type WorktreeClaims = { worktreeId: string; globs: string[] }

type P = typeof LedgerParams

export type LedgerMethodContract = {
  'memory.claim': { params: z.infer<P['memoryClaim']>; result: WorktreeClaims }
  'memory.unclaim': { params: z.infer<P['memoryUnclaim']>; result: WorktreeClaims }
}
