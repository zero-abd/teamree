// A worktree whose folder is gone from disk, or holds something else now: the three ways back.

import type { Worktree } from '@shared/entities'
import { useWorkspaceStore } from '../state/workspaceStore'
import { Button } from '../ui/Button'

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
        <Button variant="primary" size="sm" onClick={() => void recreateCheckout(worktree.id)}>
          Restore
        </Button>
        <Button size="sm" onClick={() => void locateCheckout(worktree.id)}>
          Locate…
        </Button>
        <Button size="sm" onClick={() => void removeFromTeamree({ worktreeId: worktree.id })}>
          Remove from teamree…
        </Button>
      </div>
    </section>
  )
}
