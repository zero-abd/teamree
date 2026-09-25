// Settings › Agents › Trust New Worktrees: whether a worktree teamree makes gets the
// folder trust claude and codex already give its main checkout.

import { Params } from '../../../shared/methods'
import { trustNewWorktree } from '../../agentTrust'
import type { WorkspaceStore } from '../../store/workspaceStore'
import type { MethodRegistry } from '../methodRegistry'

export function registerAgentTrustHandlers(registry: MethodRegistry): void {
  const store = registry.context.store
  registry.register('agents.trust', Params.agentsTrust, () => ({ trustNewWorktrees: store.trustNewWorktrees() }))
  registry.register('agents.setTrust', Params.agentsSetTrust, (params) => {
    store.setTrustNewWorktrees(params.trustNewWorktrees)
    return { trustNewWorktrees: store.trustNewWorktrees() }
  })
}

/** GitService's `trustCheckout`: nothing while the setting is off; turning it off removes nothing. */
export function trustCheckoutFor(
  store: Pick<WorkspaceStore, 'trustNewWorktrees'>,
  trust: typeof trustNewWorktree = trustNewWorktree
): (input: { projectPath: string; worktreePath: string }) => Promise<string[]> {
  return async ({ projectPath, worktreePath }) =>
    store.trustNewWorktrees() ? trust({ mainCheckout: projectPath, worktree: worktreePath }) : []
}
