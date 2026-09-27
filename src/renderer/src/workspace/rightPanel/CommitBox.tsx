// The commit message and Commit, at the top of the Changes tab. An agent's suggested message is offered, never
// typed in; Commit's menu pushes, lands or amends after it.

import { useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useWorkspaceStore } from '../../state/workspaceStore'
import { Button } from '../../ui/Button'
import { Textarea } from '../../ui/Input'
import { Menu, type MenuAnchor } from '../../ui/Menu'
import { useCommitMessage } from './commitMessage'
import type { LandOffer } from './landOffer'
import { commitChoices, commitLabel, type CommitChoice, type Sections } from './sourceControl'

export function CommitBox({
  worktreeId,
  shown,
  land,
  remote,
  amend,
  onLand
}: {
  worktreeId: string
  shown: Sections
  land: LandOffer | null
  remote: boolean
  /** Why Amend is off, or null. */
  amend: string | null
  onLand: () => void
}): React.JSX.Element {
  const committing = useWorkspaceStore((state) => state.committing)
  const commitStaged = useWorkspaceStore((state) => state.commitStaged)
  const pushActiveWorktree = useWorkspaceStore((state) => state.pushActiveWorktree)
  const { typed, suggestion, setMessage } = useCommitMessage(worktreeId)
  const [menuAt, setMenuAt] = useState<{ at: MenuAnchor; opener: HTMLElement } | null>(null)
  const ready = typed.trim() !== '' && !committing

  const run = (kind: CommitChoice['kind']): void => {
    if (!ready) return
    // The message is the one thing the app cannot reconstruct; only a commit that landed clears it.
    void commitStaged(typed, kind === 'amend').then((landed) => {
      if (!landed) return
      setMessage('')
      if (kind === 'push') void pushActiveWorktree(worktreeId)
      else if (kind === 'land') onLand()
    })
  }
  const offered = suggestion !== null && typed !== suggestion.text ? suggestion.text : null

  return (
    <div className="changes__commit">
      <Textarea
        className="changes__message"
        rows={1}
        value={typed}
        placeholder="Message (⌘↩ to commit)"
        aria-label="Commit message"
        disabled={committing}
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
          event.preventDefault()
          run('commit')
        }}
      />
      {offered === null ? null : (
        <button
          type="button"
          className="chip changes__suggest"
          title={offered}
          aria-label={`Use: ${offered.split('\n')[0]}`}
          onClick={() => setMessage(offered)}
        >
          <span className="changes__suggestUse">Use:</span>
          <span className="changes__suggestText">{offered.split('\n')[0]}</span>
        </button>
      )}
      <div className="changes__commitRow">
        <Button
          variant="primary"
          className="changes__commitButton"
          aria-disabled={!ready}
          loading={committing}
          onClick={() => run('commit')}
        >
          {committing ? 'Committing…' : commitLabel(shown)}
        </Button>
        <Button
          variant="primary"
          className="changes__commitMore"
          aria-label="Commit Actions"
          aria-haspopup="menu"
          aria-expanded={menuAt !== null}
          aria-disabled={!ready}
          onClick={(event) => {
            if (!ready) return
            const rect = event.currentTarget.getBoundingClientRect()
            const at: MenuAnchor = { x: rect.right, y: rect.bottom + 4, align: 'right' }
            setMenuAt(menuAt === null ? { at, opener: event.currentTarget } : null)
          }}
        >
          <Icon name="chevron-down" size={14} />
        </Button>
      </div>
      {menuAt === null ? null : (
        <Menu
          label="Commit Actions"
          anchor={menuAt.at}
          opener={menuAt.opener}
          onClose={() => setMenuAt(null)}
          items={commitChoices({ land, remote, amend }).map((choice) => ({
            label: choice.label,
            onChoose: () => run(choice.kind),
            ...(choice.disabled === undefined ? {} : { disabled: true, hint: choice.disabled })
          }))}
        />
      )}
    </div>
  )
}
