// A file as a pane: a path bar, then the viewer its content calls for, or its
// working-tree diff.

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { FileContent } from '@shared/entities'
import { filePaneName } from '@shared/filePane'
import type { FilePaneProps } from '../panes/FilePane'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from '../state/workspaceStore'
import type { CodeEditorHandle } from './CodeEditor'
import { FileBar } from './FileBar'
import { DiffBody, DiffTools, useFileDiff } from './FileDiff'
import { draftFor, dropDraft, fileSize, keepDraft, registerSaver, type FileDraft } from './fileDrafts'
import { ImageView } from './ImageView'

/** How long typing may run before the draft in the profile catches up. */
const DRAFT_DELAY_MS = 400

// Its own chunk, so the window does not load an editor until a file is opened.
const CodeEditor = lazy(() => import('./CodeEditor').then((module) => ({ default: module.CodeEditor })))

export function FileView({
  paneId,
  worktreeId,
  path,
  focused,
  onFocus,
  onClose,
  onHeaderMenu,
  onMenu,
  searchToken = 0
}: FilePaneProps): React.JSX.Element {
  const worktreePath = useWorkspaceStore((state) => state.worktrees.find((entry) => entry.id === worktreeId)?.path)
  const unsaved = useWorkspaceStore((state) => state.unsavedFiles[paneId] === true)
  const setFileEdited = useWorkspaceStore((state) => state.setFileEdited)
  const filesEpoch = useWorkspaceStore((state) => state.worktreeFilesEpoch)
  const fontSize = useWorkspaceStore((state) => state.terminalFontSize)
  const revealInFinder = useWorkspaceStore((state) => state.revealInFinder)
  const openInDefaultApp = useWorkspaceStore((state) => state.openInDefaultApp)

  const [content, setContent] = useState<FileContent | null>(null)
  const [draft] = useState<FileDraft | undefined>(() => draftFor(paneId, worktreeId, path))
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const diff = useFileDiff(paneId, worktreeId, path)
  const showDiff = diff.shown
  const editor = useRef<CodeEditorHandle | null>(null)
  // What this pane last knows to be on disk, for the stale-save check and the draft.
  const known = useRef<{ text: string; modifiedAt: number } | null>(null)
  const encoding = useRef<FileDraft['encoding']>(draft?.encoding)
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const unsavedRef = useRef(unsaved)
  unsavedRef.current = unsaved

  const name = filePaneName(path)
  const view = content?.view
  const absolute = worktreePath === undefined ? path : `${worktreePath}/${path}`

  useEffect(() => {
    let alive = true
    runtimeClient
      .call('file.read', { worktreeId, path, viewer: true })
      .then((next) => {
        if (!alive) return
        setError(null)
        if (next.view === undefined) {
          encoding.current = next.encoding
          if (known.current === null) {
            // A kept draft saves against the version it was edited from.
            known.current = draft
              ? { text: draft.savedText, modifiedAt: draft.modifiedAt }
              : { text: next.content, modifiedAt: next.modifiedAt }
          } else if (!unsavedRef.current && next.modifiedAt !== known.current.modifiedAt) {
            known.current = { text: next.content, modifiedAt: next.modifiedAt }
            editor.current?.replace(next.content)
          }
        }
        setContent(next)
      })
      .catch((failure: unknown) => {
        if (alive) setError(failure instanceof Error ? failure.message : String(failure))
      })
    return () => {
      alive = false
    }
  }, [worktreeId, path, filesEpoch, draft])

  /** Writes the edits to the profile now, while the store still calls them unsaved. */
  const keep = useRef<() => void>(() => {})
  keep.current = () => {
    if (draftTimer.current !== null) clearTimeout(draftTimer.current)
    draftTimer.current = null
    const text = editor.current?.text()
    const base = known.current
    // Read live: a pane closed with Don't Save unmounts before it renders clean.
    if (text === undefined || base === null || useWorkspaceStore.getState().editedFiles[paneId] === undefined) return
    keepDraft(paneId, {
      worktreeId,
      path,
      text,
      savedText: base.text,
      modifiedAt: base.modifiedAt,
      ...(encoding.current === undefined ? {} : { encoding: encoding.current })
    })
  }

  // Edits outlive the editor: a worktree switch unmounts it, and a reload or quit ends the page.
  useEffect(() => {
    const flush = (): void => keep.current()
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      flush()
    }
  }, [])

  const save = useCallback(
    async (text: string, overwrite = false): Promise<boolean> => {
      if (content === null || content.view !== undefined) return false
      try {
        const written = await runtimeClient.call('file.write', {
          worktreeId,
          path,
          content: text,
          encoding: content.encoding ?? 'utf-8',
          ...(overwrite || known.current === null ? {} : { expectedModifiedAt: known.current.modifiedAt })
        })
        known.current = { text, modifiedAt: written.modifiedAt }
        editor.current?.markSaved(text)
        setConflict(false)
        setError(null)
        return true
      } catch (failure) {
        if ((failure as { code?: string } | null)?.code === 'conflict') setConflict(true)
        else setError(failure instanceof Error ? failure.message : String(failure))
        return false
      }
    },
    [content, worktreeId, path]
  )

  const saveEdits = useRef(save)
  saveEdits.current = save
  useEffect(
    () =>
      registerSaver(paneId, () => {
        const text = editor.current?.text() ?? draft?.text
        return text === undefined ? Promise.resolve(false) : saveEdits.current(text)
      }),
    [paneId, draft]
  )

  const reload = async (): Promise<void> => {
    const next = await runtimeClient.call('file.read', { worktreeId, path, viewer: true })
    if (next.view !== undefined) return
    known.current = { text: next.content, modifiedAt: next.modifiedAt }
    editor.current?.replace(next.content)
    setContent(next)
    setConflict(false)
  }

  const onDirtyChange = useCallback(
    (dirty: boolean) => {
      setFileEdited(paneId, dirty ? { worktreeId, path } : null)
      if (dirty) keep.current()
      else dropDraft(paneId)
    },
    [paneId, worktreeId, path, setFileEdited]
  )

  const onEdit = useCallback(() => {
    if (draftTimer.current === null) draftTimer.current = setTimeout(() => keep.current(), DRAFT_DELAY_MS)
  }, [])

  const openDefault = (): void => void openInDefaultApp(absolute, name)
  const reveal = (): void => void revealInFinder(absolute, name)

  return (
    <section
      className={`pane file${focused ? ' pane--focused' : ''}`}
      aria-label={name}
      onMouseDownCapture={onFocus}
      style={{ ['--file-font-size' as string]: `${fontSize}px` }}
    >
      <FileBar
        path={path}
        name={name}
        title={absolute}
        unsaved={unsaved}
        onHeaderMenu={onHeaderMenu}
        onMenu={onMenu}
        onClose={onClose}
      >
        <DiffTools diff={diff} />
      </FileBar>

      {conflict ? (
        <div className="file__notice" role="alert">
          <span>Changed on disk</span>
          <button type="button" onClick={() => void reload()}>
            Reload
          </button>
          <button type="button" onClick={() => void save(editor.current?.text() ?? '', true)}>
            Overwrite
          </button>
        </div>
      ) : error !== null ? (
        <div className="file__notice" role="alert">
          <span>{error}</span>
        </div>
      ) : null}

      <div className="file__body" ref={diff.body}>
        {showDiff ? <DiffBody worktreeId={worktreeId} diff={diff} /> : null}
        <div className="file__view" hidden={showDiff}>
          {content === null ? (
            error === null ? (
              <p className="file__state">Reading…</p>
            ) : null
          ) : view === undefined ? (
            <Suspense fallback={null}>
              <CodeEditor
                key={`${paneId}:${content.lineEnding ?? '\n'}`}
                ref={editor}
                path={path}
                savedText={known.current?.text ?? content.content}
                {...(draft === undefined ? {} : { draftText: draft.text })}
                lineEnding={content.lineEnding ?? '\n'}
                focused={focused && !showDiff}
                searchToken={searchToken}
                onDirtyChange={onDirtyChange}
                onEdit={onEdit}
              />
            </Suspense>
          ) : view.kind === 'image' ? (
            <ImageView url={view.url} name={name} />
          ) : view.kind === 'pdf' ? (
            <iframe className="file__frame" src={view.url} title={name} />
          ) : view.kind === 'media' ? (
            view.mime.startsWith('audio/') ? (
              <div className="file__media">
                <audio src={view.url} controls />
              </div>
            ) : (
              <div className="file__media">
                <video src={view.url} controls />
              </div>
            )
          ) : (
            <div className="file__state">
              <p>
                {view.kind === 'binary' ? 'Binary' : 'Too large'} · {fileSize(content.size)}
              </p>
              <div className="file__actions">
                <button type="button" onClick={openDefault}>
                  Open in default app
                </button>
                <button type="button" onClick={reveal}>
                  Reveal in Finder
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
