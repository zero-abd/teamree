// The commit message and Commit, at the top of the Changes tab. An agent's suggested message is offered, never
// typed in; Commit's menu pushes or lands after it, or switches to amending the last commit.

import { useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useWorkspaceStore } from '../../state/workspaceStore'
import { Button } from '../../ui/Button'
import { Textarea } from '../../ui/Input'
import { Menu, type MenuAnchor, type MenuItem } from '../../ui/Menu'
import { CommitBlocked } from './CommitBlocked'
import { useCommitDrafts, useCommitMessage } from './commitMessage'
import type { LandOffer } from './landOffer'
import { commitChoices, commitLabel, type CommitChoice, type Sections } from './sourceControl'

export function CommitBox({
  worktreeId,
  shown,
  land,
  remote,
  amend,
  lastMessage,
  onLand
}: {
  worktreeId: string
  shown: Sections
  land: LandOffer | null
  remote: boolean
  /** Why Amend is off, or null. */
  amend: string | null
  /** The last commit's whole message, which an Amend starts from. */
  lastMessage: string
  onLand: () => void
}): React.JSX.Element {
  const committing = useWorkspaceStore((state) => state.committing)
  const commitStaged = useWorkspaceStore((state) => state.commitStaged)
  const pushActiveWorktree = useWorkspaceStore((state) => state.pushActiveWorktree)
  const { typed, suggestion, setMessage } = useCommitMessage(worktreeId)
  const amendText = useCommitDrafts((state) => state.amends[worktreeId])
  const setAmend = useCommitDrafts((state) => state.setAmend)
  const [menuAt, setMenuAt] = useState<{ at: MenuAnchor; opener: HTMLElement } | null>(null)
  const amending = amend === null && amendText !== undefined
  const text = amending ? amendText : typed
  const ready = text.trim() !== '' && !committing

  const run = (kind: CommitChoice['kind']): void => {
    if (!ready) return
    // The message is the one thing the app cannot reconstruct; only a commit that landed clears it.
    void commitStaged(text, amending).then((landed) => {
      if (!landed) return
      if (amending) setAmend(worktreeId, null)
      else setMessage('')
      if (kind === 'push') void pushActiveWorktree(worktreeId)
      else if (kind === 'land') onLand()
    })
  }
  const choose = (kind: CommitChoice['kind']): void => {
    if (kind !== 'amend') return run(kind)
    setAmend(worktreeId, lastMessage)
    menuAt?.opener.closest('.changes__commit')?.querySelector('textarea')?.focus()
  }
  const offered = !amending && suggestion !== null && typed !== suggestion.text ? suggestion.text : null
  const choices: MenuItem[] = amending
    ? [{ label: 'Cancel Amend', onChoose: () => setAmend(worktreeId, null) }]
    : commitChoices({ land, remote, amend }).map((choice) => ({
        label: choice.label,
        onChoose: () => choose(choice.kind),
        ...(choice.disabled !== undefined
          ? { disabled: true, hint: choice.disabled }
          : choice.kind !== 'amend' && !ready
            ? { disabled: true }
            : {})
      }))

  return (
    <div className="changes__commit">
      <Textarea
        className="changes__message"
        rows={1}
        value={text}
        placeholder="Message (⌘↩ to commit)"
        aria-label="Commit message"
        disabled={committing}
        onChange={(event) => (amending ? setAmend(worktreeId, event.target.value) : setMessage(event.target.value))}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && amending) {
            event.preventDefault()
            event.stopPropagation()
            setAmend(worktreeId, null)
            return
          }
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
          {committing ? 'Committing…' : amending ? 'Amend Last Commit' : commitLabel(shown)}
        </Button>
        <Button
          variant="primary"
          className="changes__commitMore"
          aria-label="Commit Actions"
          aria-haspopup="menu"
          aria-expanded={menuAt !== null}
          aria-disabled={committing}
          onClick={(event) => {
            if (committing) return
            const rect = event.currentTarget.getBoundingClientRect()
            const at: MenuAnchor = { x: rect.right, y: rect.bottom + 4, align: 'right' }
            setMenuAt(menuAt === null ? { at, opener: event.currentTarget } : null)
          }}
        >
          <Icon name="chevron-down" size={14} />
        </Button>
      </div>
      <CommitBlocked worktreeId={worktreeId} />
      {menuAt === null ? null : (
        <Menu
          label="Commit Actions"
          anchor={menuAt.at}
          opener={menuAt.opener}
          onClose={() => setMenuAt(null)}
          items={choices}
        />
      )}
    </div>
  )
}
