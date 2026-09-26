// A worktree whose folder is gone from disk, or holds something else now: the three ways back.

import type { Worktree } from '@shared/entities'
import { useWorkspaceStore } from '../state/workspaceStore'

export function CheckoutMissing({ worktree }: { worktree: Pick<Worktree, 'id' | 'path'> }): React.JSX.Element {
  const recreateCheckout = useWorkspaceStore((state) => state.recreateCheckout)
  const locateCheckout = useWorkspaceStore((state) => state.locateCheckout)
  const removeFromTeamree = useWorkspaceStore((state) => state.removeFromTeamree)
  return (
    <section className="checkout-missing" aria-label="Checkout missing">
      <span className="checkout-missing__label">Checkout missing</span>
      <code className="checkout-missing__path" title={worktree.path}>
        {worktree.path}
      </code>
      <div className="checkout-missing__actions">
        <button
          type="button"
          className="button button--primary button--small"
          onClick={() => void recreateCheckout(worktree.id)}
        >
          Restore
        </button>
        <button type="button" className="button button--small" onClick={() => void locateCheckout(worktree.id)}>
          Locate…
        </button>
        <button
          type="button"
          className="button button--small"
          onClick={() => void removeFromTeamree({ worktreeId: worktree.id })}
        >
          Remove from teamree…
        </button>
      </div>
    </section>
  )
}
