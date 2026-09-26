// "<name> shared <title>" in the corner, one per unseen note, oldest first. Never takes the focus.

import { useSharedNotes, notePopups } from './sharedNotesStore'
import { useWorkspaceStore } from '../state/workspaceStore'

export function SharedNotePopups(): React.JSX.Element | null {
  const inbox = useSharedNotes((state) => state.inbox)
  const openNote = useSharedNotes((state) => state.open)
  const closeNote = useSharedNotes((state) => state.close)
  const popups = notePopups(inbox)
  if (popups.length === 0) return null
  return (
    <div className="notices" role="status" aria-live="polite">
      {popups.map((note) => (
        <div className="notice notice--info shared-note" key={note.shareId}>
          <span className="notice__text">
            {note.handle} shared <strong>{note.title}</strong>
          </span>
          <button
            type="button"
            className="notice__action"
            onClick={() => {
              void openNote(note.shareId)
              void useWorkspaceStore.getState().openSharedNote(note.projectId, note.shareId, note.title)
            }}
          >
            View
          </button>
          <button type="button" className="notice__action" onClick={() => void closeNote(note.shareId)}>
            Close
          </button>
        </div>
      ))}
    </div>
  )
}
