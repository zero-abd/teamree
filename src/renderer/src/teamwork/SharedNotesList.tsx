// Notes teammates shared in one project, newest first, on its Teamwork page: read in place, saved
// into a worktree, or deleted with an Undo. Nothing is drawn until a note has arrived.

import { agoLabel } from '../sidebar/agentRows'
import { useWorkspaceStore } from '../state/workspaceStore'
import { listedNotes, useSharedNotes } from './sharedNotesStore'
import { SharedNoteText } from './SharedNoteView'

export function SharedNotesList({ projectId }: { projectId: string }): React.JSX.Element | null {
  const inbox = useSharedNotes((state) => state.inbox)
  const deleting = useSharedNotes((state) => state.deleting)
  const bodies = useSharedNotes((state) => state.bodies)
  const expanded = useSharedNotes((state) => state.expanded)
  const expand = useSharedNotes((state) => state.expand)
  const saveCopy = useSharedNotes((state) => state.saveCopy)
  const deleteSharedNote = useWorkspaceStore((state) => state.deleteSharedNote)
  const showNotice = useWorkspaceStore((state) => state.showNotice)
  // Where Save Copy writes: the worktree on screen when it is this project's, else its first ready one.
  const worktreeId = useWorkspaceStore((state) => {
    const active = state.worktrees.find((worktree) => worktree.id === state.activeWorktreeId)
    if (active?.projectId === projectId) return active.id
    return state.worktrees.find((worktree) => worktree.projectId === projectId && worktree.state === 'ready')?.id
  })

  const notes = listedNotes({ inbox, deleting }, projectId)
  if (notes.length === 0) return null
  const unread = notes.filter((note) => note.read !== true).length
  const now = Date.now()

  const save = async (shareId: string, into: string): Promise<void> => {
    try {
      showNotice(`Saved ${await saveCopy(shareId, into)}`)
    } catch (failure) {
      showNotice(failure instanceof Error ? failure.message : String(failure), 'error')
    }
  }

  return (
    <section className="shared-notes" aria-label="Shared Notes">
      <h2 className="shared-notes__head">
        Shared Notes
        {unread > 0 ? <span className="shared-notes__unread">{unread} unread</span> : null}
      </h2>
      <ul className="shared-notes__list">
        {notes.map((note) => {
          const open = expanded === note.shareId
          const body = bodies[note.shareId]
          return (
            <li
              key={note.shareId}
              className={`shared-notes__row${note.read === true ? '' : ' shared-notes__row--unread'}`}
            >
              <div className="shared-notes__line">
                <span className="shared-notes__title">{note.title}</span>
                <span className="shared-notes__meta">
                  {note.handle} · {agoLabel(now - note.receivedAt)}
                </span>
                <button
                  type="button"
                  className="button button--small"
                  aria-expanded={open}
                  onClick={() => expand(note.shareId)}
                >
                  {open ? 'Hide' : 'View'}
                </button>
                <button
                  type="button"
                  className="button button--small"
                  disabled={worktreeId === undefined}
                  title={worktreeId === undefined ? 'No worktree' : undefined}
                  onClick={() => {
                    if (worktreeId !== undefined) void save(note.shareId, worktreeId)
                  }}
                >
                  Save Copy
                </button>
                <button
                  type="button"
                  className="button button--small"
                  onClick={() => deleteSharedNote(note.shareId, note.title)}
                >
                  Delete
                </button>
              </div>
              {open ? (
                <div className="shared-notes__text">
                  {body ? <SharedNoteText markdown={body.markdown} /> : null}
                  {body === null ? <p className="shared-note__gone">Gone</p> : null}
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
