// A file as a pane: a path bar, then the viewer its content calls for, or its
// working-tree diff.

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { FileContent, WorktreeDiff } from '@shared/entities'
import { filePaneName } from '@shared/filePane'
import type { FilePaneProps } from '../panes/FilePane'
import { PaneCloseButton } from '../panes/PaneCloseButton'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { RowMenu, type RowMenuAnchor } from '../sidebar/RowMenu'
import { useWorkspaceStore } from '../state/workspaceStore'
import { PatchView } from '../workspace/PatchView'
import type { CodeEditorHandle } from './CodeEditor'
import { dropDraft, fileSize, keepDraft, takeDraft, type FileDraft } from './fileDrafts'
import { ImageView } from './ImageView'

// Its own chunk, so the window does not load an editor until a file is opened.
const CodeEditor = lazy(() => import('./CodeEditor').then((module) => ({ default: module.CodeEditor })))

type Diffs = { working: WorktreeDiff; staged: WorktreeDiff }

export function FileView({
  paneId,
  worktreeId,
  path,
  focused,
  onFocus,
  onClose,
  searchToken = 0
}: FilePaneProps): React.JSX.Element {
  const worktreePath = useWorkspaceStore((state) => state.worktrees.find((entry) => entry.id === worktreeId)?.path)
  const unsaved = useWorkspaceStore((state) => state.unsavedFiles[paneId] === true)
  const setFileUnsaved = useWorkspaceStore((state) => state.setFileUnsaved)
  const filesEpoch = useWorkspaceStore((state) => state.worktreeFilesEpoch)
  const fontSize = useWorkspaceStore((state) => state.terminalFontSize)
  const diffLayout = useWorkspaceStore((state) => state.diffLayout)
  const copyToClipboard = useWorkspaceStore((state) => state.copyToClipboard)
  const revealInFinder = useWorkspaceStore((state) => state.revealInFinder)
  const openInDefaultApp = useWorkspaceStore((state) => state.openInDefaultApp)

  const [content, setContent] = useState<FileContent | null>(null)
  const [draft] = useState<FileDraft | undefined>(() => takeDraft(paneId))
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [showDiff, setShowDiff] = useState(false)
  const [diffs, setDiffs] = useState<Diffs | null>(null)
  const [menuAt, setMenuAt] = useState<RowMenuAnchor | null>(null)
  const more = useRef<HTMLButtonElement | null>(null)
  const editor = useRef<CodeEditorHandle | null>(null)
  // What this pane last knows to be on disk, for the stale-save check and the draft.
  const known = useRef<{ text: string; modifiedAt: number } | null>(null)
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

  useEffect(() => {
    if (!showDiff) return
    let alive = true
    void Promise.all([
      runtimeClient.call('worktree.diff', { worktreeId, path }),
      runtimeClient.call('worktree.diff', { worktreeId, path, staged: true })
    ])
      .then(([working, staged]) => {
        if (alive) setDiffs({ working, staged })
      })
      .catch((failure: unknown) => {
        if (alive) setError(failure instanceof Error ? failure.message : String(failure))
      })
    return () => {
      alive = false
    }
  }, [showDiff, worktreeId, path, filesEpoch])

  // Edits outlive the editor: a worktree switch unmounts it.
  useEffect(
    () => () => {
      const text = editor.current?.text()
      const base = known.current
      if (unsavedRef.current && text !== undefined && base !== null) {
        keepDraft(paneId, { text, savedText: base.text, modifiedAt: base.modifiedAt })
      }
    },
    [paneId]
  )

  const save = useCallback(
    async (text: string, overwrite = false): Promise<void> => {
      if (content === null || content.view !== undefined) return
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
        dropDraft(paneId)
        setConflict(false)
        setError(null)
      } catch (failure) {
        if ((failure as { code?: string } | null)?.code === 'conflict') setConflict(true)
        else setError(failure instanceof Error ? failure.message : String(failure))
      }
    },
    [content, worktreeId, path, paneId]
  )

  const reload = async (): Promise<void> => {
    const next = await runtimeClient.call('file.read', { worktreeId, path, viewer: true })
    if (next.view !== undefined) return
    known.current = { text: next.content, modifiedAt: next.modifiedAt }
    editor.current?.replace(next.content)
    setContent(next)
    setConflict(false)
  }

  const onDirtyChange = useCallback((dirty: boolean) => setFileUnsaved(paneId, dirty), [paneId, setFileUnsaved])

  const openDefault = (): void => void openInDefaultApp(absolute, name)
  const reveal = (): void => void revealInFinder(absolute, name)

  return (
    <section
      className={`pane file${focused ? ' pane--focused' : ''}`}
      aria-label={name}
      onMouseDownCapture={onFocus}
      style={{ ['--file-font-size' as string]: `${fontSize}px` }}
    >
      <header className="pane__bar file__bar">
        <FileGlyph />
        <span className="pane__title file__path" title={absolute}>
          <span className="file__dir">{path.slice(0, path.length - name.length)}</span>
          {name}
        </span>
        {unsaved ? <span className="file__unsaved" title="Unsaved" aria-label="Unsaved" /> : null}
        <span className="file__spacer" />
        <button
          type="button"
          className={`file__tool${showDiff ? ' file__tool--on' : ''}`}
          aria-pressed={showDiff}
          onClick={() => setShowDiff((current) => !current)}
        >
          Diff
        </button>
        <button
          type="button"
          ref={more}
          className="file__tool file__more"
          aria-label={`More for ${name}`}
          title="More"
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect()
            setMenuAt((current) => (current ? null : { x: box.right, y: box.bottom + 4, align: 'right' }))
          }}
        >
          ⋯
        </button>
        <PaneCloseButton name={name} onClose={onClose} />
      </header>

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

      <div className="file__body">
        {showDiff ? <DiffBody diffs={diffs} layout={diffLayout} /> : null}
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
                onSave={(text) => void save(text)}
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

      {menuAt === null ? null : (
        <RowMenu
          label={`Actions for ${path}`}
          anchor={menuAt}
          opener={more.current}
          onClose={() => {
            setMenuAt(null)
            more.current?.focus()
          }}
          items={[
            { label: 'Copy path', onChoose: () => void copyToClipboard(absolute, `the path to ${path}`) },
            { label: 'Reveal in Finder', onChoose: reveal },
            { label: 'Open in default app', onChoose: openDefault }
          ]}
        />
      )}
    </section>
  )
}

function DiffBody({
  diffs,
  layout
}: {
  diffs: Diffs | null
  layout: Parameters<typeof PatchView>[0]['layout']
}): React.JSX.Element {
  if (diffs === null) return <p className="file__state">Reading…</p>
  const parts = [diffs.staged, diffs.working].filter((diff) => diff.patch !== '')
  if (parts.length === 0) return <p className="file__state">No changes</p>
  return (
    <div className="file__diff">
      {parts.map((diff) => (
        <PatchView
          key={diff.staged ? 'staged' : 'working'}
          patch={diff.patch}
          truncated={diff.truncated}
          layout={layout}
        />
      ))}
    </div>
  )
}

export function FileGlyph(): React.JSX.Element {
  return (
    <svg className="file__glyph" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3 1.5 H7.5 L10 4 V10.5 H3 Z M7.5 1.5 V4 H10" />
    </svg>
  )
}
