// Who is on a project, and how to become one of them.
//
// The dialog has one job beyond listing names: to be honest about what adding
// yourself does. It writes a file. It does not stage it, commit it or push it,
// and the button says so before it is pressed and the panel says so afterwards,
// because the commit is not a formality — being able to push that file is the
// entire definition of membership, and an app that did it silently would be
// claiming an authority it cannot have.

import { useEffect, useState } from 'react'
import type { Member, MemberList } from '@shared/entities'
import { Modal } from './Modal'
import { useWorkspaceStore } from '../state/workspaceStore'

export function MembersDialog({ projectId }: { projectId: string }): React.JSX.Element {
  const project = useWorkspaceStore((state) => state.projects.find((entry) => entry.id === projectId))
  const list = useWorkspaceStore((state) => state.members[projectId])
  const pending = useWorkspaceStore((state) => state.membersPending)
  const loadMembers = useWorkspaceStore((state) => state.loadMembers)
  const joinProject = useWorkspaceStore((state) => state.joinProject)
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)

  useEffect(() => {
    void loadMembers(projectId)
  }, [loadMembers, projectId])

  return (
    <Modal
      title="Members"
      description={`Everyone who can push to ${project?.name ?? 'this repository'} is on the team. Their keys are in it.`}
      onClose={closeDialog}
    >
      <div className="members">
        {list === undefined ? (
          <p className="members__empty">{pending ? 'Reading the roster…' : 'Nothing read yet.'}</p>
        ) : (
          <>
            <MemberRoster list={list} />
            <Problems list={list} />
            <SelfPanel list={list} pending={pending} onJoin={(handle) => void joinProject(projectId, handle)} />
          </>
        )}
        <div className="form__actions">
          <button type="button" className="button" onClick={closeDialog}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  )
}

function MemberRoster({ list }: { list: MemberList }): React.JSX.Element {
  if (list.members.length === 0) {
    return <p className="members__empty">No keys committed yet. Whoever adds the first one starts the roster.</p>
  }
  return (
    <ul className="members__list">
      {list.members.map((member) => (
        <MemberRow key={member.file} member={member} />
      ))}
    </ul>
  )
}

function MemberRow({ member }: { member: Member }): React.JSX.Element {
  return (
    <li className={`member${member.isSelf ? ' member--self' : ''}`}>
      <div className="member__line">
        <span className="member__handle">{member.handle}</span>
        {member.isSelf ? <span className="member__you">you</span> : null}
        <span className="member__added">added {member.addedAt}</span>
      </div>
      {/* Shown short: a key is read to compare two of them, never to be typed. */}
      <code className="member__key" title={member.publicKey}>
        {member.publicKey.slice(0, 16)}…
      </code>
    </li>
  )
}

/**
 * Files that are in the directory and are not members. Named rather than
 * counted: a skipped file is somebody's key that is not working, and the only
 * useful version of that message is the one with the path in it.
 */
function Problems({ list }: { list: MemberList }): React.JSX.Element | null {
  if (list.problems.length === 0) return null
  return (
    <div className="members__problems">
      <p className="members__problems-head">
        {list.problems.length} file{list.problems.length === 1 ? '' : 's'} skipped
      </p>
      <ul>
        {list.problems.map((problem) => (
          <li key={problem.file}>
            <code>{problem.file}</code> — {problem.reason}
          </li>
        ))}
      </ul>
    </div>
  )
}

function SelfPanel({
  list,
  pending,
  onJoin
}: {
  list: MemberList
  pending: boolean
  onJoin: (handle?: string) => void
}): React.JSX.Element {
  const [handle, setHandle] = useState('')

  if (list.enrolled) {
    return (
      <p className="members__self">
        Your key is in this repository as <strong>{list.self.handle}</strong>. If it is not committed and pushed yet,
        nobody else can see it.
      </p>
    )
  }

  const chosen = handle.trim() || list.self.handle
  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    const typed = handle.trim()
    onJoin(typed || undefined)
  }

  return (
    <form className="members__self members__self--join" onSubmit={submit}>
      <p className="members__self-head">You are not in this roster yet.</p>
      <label className="field">
        <span className="field__label">Handle</span>
        <input
          className="field__input field__input--mono"
          value={handle}
          onChange={(event) => setHandle(event.target.value)}
          placeholder={list.self.handle ?? 'pick a name'}
          autoComplete="off"
          spellCheck={false}
        />
        <span className="field__hint">
          {list.self.handle === null
            ? 'git has no user.email here, so there is no name to use — choose one.'
            : `Defaults to the local part of your git email. Writes ${
                chosen === null ? '' : `.teamree/members/${chosen}.pub`
              }.`}
        </span>
      </label>
      <button type="submit" className="button button--primary" disabled={pending || chosen === null}>
        {pending ? 'Writing…' : 'Add my key'}
      </button>
      <p className="members__caveat">
        This only writes the file. Committing it and pushing it is yours to do — being able to push it is what makes it
        membership.
      </p>
    </form>
  )
}
