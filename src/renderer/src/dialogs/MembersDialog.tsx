// Who is on a project, where they meet, and how to become one of them.
//
// The dialog has one job beyond listing names: to be honest about what adding
// yourself does. It writes a file. It does not stage it, commit it or push it,
// and the button says so before it is pressed and the panel says so afterwards,
// because the commit is not a formality — being able to push that file is the
// entire definition of membership, and an app that did it silently would be
// claiming an authority it cannot have.
//
// The relay is here for the same reason the roster is here: both are facts
// about a team rather than settings on a machine, both are files in the
// repository, and both take effect when somebody pushes them. Writing a
// heredoc into `.teamree/relay` by hand was a step in the runbook only because
// this panel did not exist; the app's own template for that file was exported
// and called by nothing.

import { useEffect, useState } from 'react'
import type { Member, MemberList, RelaySetting } from '@shared/entities'
import { Modal } from './Modal'
import { useWorkspaceStore } from '../state/workspaceStore'

export function MembersDialog({ projectId }: { projectId: string }): React.JSX.Element {
  const project = useWorkspaceStore((state) => state.projects.find((entry) => entry.id === projectId))
  const list = useWorkspaceStore((state) => state.members[projectId])
  const relay = useWorkspaceStore((state) => state.relays[projectId])
  const pending = useWorkspaceStore((state) => state.membersPending)
  const relayPending = useWorkspaceStore((state) => state.relayPending)
  const relayError = useWorkspaceStore((state) => state.relayError)
  const loadMembers = useWorkspaceStore((state) => state.loadMembers)
  const loadRelay = useWorkspaceStore((state) => state.loadRelay)
  const setRelay = useWorkspaceStore((state) => state.setRelay)
  const joinProject = useWorkspaceStore((state) => state.joinProject)
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)

  // Both read on open. The runtime watches `.teamree` and says when it moves,
  // so this is belt and braces rather than the only way either is refreshed —
  // and it is what covers a project whose watch could not be set up.
  useEffect(() => {
    void loadMembers(projectId)
    void loadRelay(projectId)
  }, [loadMembers, loadRelay, projectId])

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
            <Freshness list={list} />
            <SelfPanel list={list} pending={pending} onJoin={(handle) => void joinProject(projectId, handle)} />
          </>
        )}
        <RelayPanel
          relay={relay}
          pending={relayPending}
          error={relayError}
          onSet={(url) => void setRelay(projectId, url)}
        />
        <PushPanel list={list} relay={relay} />
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

/**
 * Whether this list will stay true on its own.
 *
 * Said only when it will not. A roster that follows the file needs no
 * reassurance; one that nothing is watching is a list that was true when it was
 * read, and somebody about to believe it deserves to know which of the two they
 * are looking at.
 */
function Freshness({ list }: { list: MemberList }): React.JSX.Element | null {
  if (list.watched) return null
  return (
    <p className="members__stale">
      teamree could not watch this project’s files, so this list is only as fresh as this read. Open this dialog again
      after a pull to see what it brought in.
    </p>
  )
}

/**
 * The relay, which is the other team-wide fact and has the same bargain: the
 * app writes the file, and pushing it is the part that means something.
 */
function RelayPanel({
  relay,
  pending,
  error,
  onSet
}: {
  relay: RelaySetting | undefined
  pending: boolean
  error: string | null
  onSet: (url: string) => void
}): React.JSX.Element | null {
  const [draft, setDraft] = useState('')
  // Absent is not "no relay": nothing has looked yet, and rendering that as
  // "this team has none" would be the app claiming something it has not read.
  if (relay === undefined) return null

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    const typed = draft.trim()
    if (typed) onSet(typed)
  }

  return (
    <form className="members__relay" onSubmit={submit}>
      <p className="members__relay-head">Relay</p>
      {relay.url === null ? (
        <p className="members__relay-none">{relay.problem}</p>
      ) : (
        <p className="members__relay-current">
          <code>{relay.url}</code>
          <span className="members__relay-source">
            {relay.source === 'environment' ? `from ${relay.override.name}` : `from ${relay.file}`}
          </span>
        </p>
      )}
      {relay.source === 'environment' && relay.committed.url !== null ? (
        <p className="members__relay-note">
          <code>{relay.file}</code> says <code>{relay.committed.url}</code>, and the environment is beating it for this
          run.
        </p>
      ) : null}
      <Override relay={relay} />
      <label className="field">
        <span className="field__label">Set the relay for this project</span>
        <input
          className="field__input field__input--mono"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="wss://your-relay.example/v1/relay"
          autoComplete="off"
          spellCheck={false}
        />
        <span className="field__hint">
          A <code>ws://</code> or <code>wss://</code> URL, ending in the path your relay serves.{' '}
          {relay.committed.url === null ? 'Writes' : 'Replaces'} <code>{relay.file}</code>. See{' '}
          <code>relay/README.md</code>.
        </span>
      </label>
      {error === null ? null : <p className="members__relay-error">{error}</p>}
      <button type="submit" className="button" disabled={pending || draft.trim() === ''}>
        {pending ? 'Writing…' : 'Write relay file'}
      </button>
    </form>
  )
}

/**
 * What the environment said, including when it said nothing.
 *
 * "I set TEAMREE_RELAY_URL and nothing happened" is a predictable question on
 * macOS, where an app opened from Finder or the dock inherits none of a
 * shell's environment. The app cannot fix that — it is how the platform starts
 * programs — but it can say whether it saw an override at all, which is the one
 * thing nobody outside the process can check.
 */
function Override({ relay }: { relay: RelaySetting }): React.JSX.Element {
  if (relay.override.value === null) {
    return (
      <p className="members__relay-note">
        No <code>{relay.override.name}</code> in this app’s environment. An app opened from Finder or the dock does not
        inherit your shell’s, so that override only applies when teamree is started from a terminal that has it set.
      </p>
    )
  }
  return (
    <p className="members__relay-note">
      <code>{relay.override.name}</code> is set to <code>{relay.override.value}</code> in this app’s environment. It is
      per-machine and lasts as long as this process: commit the real relay when you are done testing.
    </p>
  )
}

/**
 * The one step the app will not take, said once for both files it wrote.
 *
 * Two runbook steps told people to commit and push these separately. They are
 * one commit, and saying so here is the difference between a person doing it
 * and a person doing half of it.
 */
function PushPanel({
  list,
  relay
}: {
  list: MemberList | undefined
  relay: RelaySetting | undefined
}): React.JSX.Element | null {
  const mine = list?.enrolled && list.selfFile ? list.selfFile : null
  const theirs = relay?.committed.url ? relay.file : null
  const files = [mine, theirs].filter((file): file is string => file !== null)
  if (files.length === 0) return null

  const message = mine === null ? 'Meet on our relay' : theirs === null ? 'Add my key to the team' : 'Set up teamwork'
  return (
    <div className="members__push">
      <p className="members__caveat">
        {files.map((file, index) => (
          <span key={file}>
            {index > 0 ? ' and ' : ''}
            <code>{file}</code>
          </span>
        ))}{' '}
        {files.length === 1 ? 'is in this checkout' : 'are in this checkout'}. Anything here that is not committed and
        pushed yet, nobody else can see — and teamree will not push it for you, because being able to push is the whole
        of what membership means.
      </p>
      <pre className="members__push-commands">{`git add .teamree\ngit commit -m "${message}"\ngit push`}</pre>
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
    // What is still owed — committing and pushing it — is said once, below,
    // where it can name the relay file in the same breath.
    return (
      <p className="members__self">
        Your key is in this repository as <strong>{list.self.handle}</strong>.
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
