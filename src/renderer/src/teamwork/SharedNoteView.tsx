// A note a teammate shared, as a read-only tab: their text drawn as data, raw HTML as text, no
// image loaded from anywhere, and Save Copy to keep it among this worktree's notes.

import { useEffect, useState } from 'react'
import type { SharedNote } from '@shared/sharedNote'
import { FileBar } from '../files/FileBar'
import { MarkdownEditor } from '../markdown/MarkdownEditor'
import type { FilePaneProps } from '../panes/FilePane'
import { openInBrowser } from '../shell/openInBrowser'
import { useWorkspaceStore } from '../state/workspaceStore'
import { useSharedNotes } from './sharedNotesStore'

/** Only a web page, and only on a click; anything else a received note links to goes nowhere. */
function openWebLink(url: string): void {
  if (/^https?:\/\//i.test(url)) openInBrowser(url)
}

const noImage = (): null => null
const ignore = (): void => {}

export function SharedNoteView({
  shareId,
  worktreeId,
  path: title,
  focused,
  onFocus,
  onClose,
  tabbed,
  onHeaderMenu,
  onMenu
}: FilePaneProps & { shareId: string }): React.JSX.Element {
  const openNote = useSharedNotes((state) => state.open)
  const saveCopy = useSharedNotes((state) => state.saveCopy)
  const [note, setNote] = useState<SharedNote | null | undefined>(undefined)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    void openNote(shareId).then((found) => {
      if (alive) setNote(found)
    })
    return () => {
      alive = false
    }
  }, [openNote, shareId])

  const save = async (): Promise<void> => {
    const { openFilePane, showNotice } = useWorkspaceStore.getState()
    setSaving(true)
    try {
      const path = await saveCopy(shareId, worktreeId)
      showNotice(`Saved ${path}`)
      openFilePane(worktreeId, path)
    } catch (failure) {
      showNotice(failure instanceof Error ? failure.message : String(failure), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section
      className={`pane pane--markdown${focused ? ' pane--focused' : ''}`}
      aria-label={title}
      onMouseDownCapture={onFocus}
    >
      <FileBar
        name={title}
        label={
          <>
            {note ? <span className="file__dir">{note.handle} · </span> : null}
            {title}
          </>
        }
        title={note ? `Shared by ${note.handle}` : title}
        unsaved={false}
        tabbed={tabbed}
        onHeaderMenu={onHeaderMenu}
        onMenu={onMenu}
        onClose={onClose}
      >
        <span className="chip">Read-only</span>
        {note ? (
          <button type="button" className="pane__again" disabled={saving} onClick={() => void save()}>
            Save Copy
          </button>
        ) : null}
      </FileBar>
      <div className="file__body">
        <div className="file__view">
          {note === undefined ? <div className="md-frame" /> : null}
          {note === null ? <div className="md-frame shared-note__gone">Gone</div> : null}
          {note ? (
            <MarkdownEditor
              initial={note.markdown}
              readOnly
              onChange={ignore}
              onFocusChange={ignore}
              onOpenUrl={openWebLink}
              resolveImage={noImage}
            />
          ) : null}
        </div>
      </div>
    </section>
  )
}
