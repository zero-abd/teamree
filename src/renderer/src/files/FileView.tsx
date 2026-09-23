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
import type { DiffLayout } from '../state/preferences'
import { fitLayout, PatchView } from '../workspace/PatchView'
import type { CodeEditorHandle } from './CodeEditor'
import { draftFor, dropDraft, fileSize, keepDraft, registerSaver, type FileDraft } from './fileDrafts'
import { ImageView } from './ImageView'

/** How long typing may run before the draft in the profile catches up. */
const DRAFT_DELAY_MS = 400

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
  onHeaderMenu,
  searchToken = 0
}: FilePaneProps): React.JSX.Element {
  const worktreePath = useWorkspaceStore((state) => state.worktrees.find((entry) => entry.id === worktreeId)?.path)
  const unsaved = useWorkspaceStore((state) => state.unsavedFiles[paneId] === true)
  const setFileEdited = useWorkspaceStore((state) => state.setFileEdited)
  const filesEpoch = useWorkspaceStore((state) => state.worktreeFilesEpoch)
  const fontSize = useWorkspaceStore((state) => state.terminalFontSize)
  const diffLayout = useWorkspaceStore((state) => state.diffLayout)
  const setDiffLayout = useWorkspaceStore((state) => state.setDiffLayout)
  const showDiff = useWorkspaceStore((state) => state.diffPanes[paneId] === true)
  const setPaneDiff = useWorkspaceStore((state) => state.setPaneDiff)
  const copyToClipboard = useWorkspaceStore((state) => state.copyToClipboard)
  const revealInFinder = useWorkspaceStore((state) => state.revealInFinder)
  const openInDefaultApp = useWorkspaceStore((state) => state.openInDefaultApp)

  const [content, setContent] = useState<FileContent | null>(null)
  const [draft] = useState<FileDraft | undefined>(() => draftFor(paneId, worktreeId, path))
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [diffs, setDiffs] = useState<Diffs | null>(null)
  const [changed, setChanged] = useState<boolean | null>(null)
  const [menuAt, setMenuAt] = useState<RowMenuAnchor | null>(null)
  const more = useRef<HTMLButtonElement | null>(null)
  const body = useRef<HTMLDivElement | null>(null)
  const bodyWidth = useWidth(body, showDiff)
  const layout = fitLayout(diffLayout, bodyWidth)
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

  useEffect(() => {
    let alive = true
    runtimeClient
      .call('worktree.changes', { worktreeId, path, limit: 1 })
      .then((changes) => {
        if (alive && changes) setChanged(changes.total > 0)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [worktreeId, path, filesEpoch])

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
      <header className="pane__bar file__bar" onContextMenu={onHeaderMenu}>
        <FileGlyph />
        <span className="pane__title file__path" title={absolute}>
          <span className="file__dir">{path.slice(0, path.length - name.length)}</span>
          {name}
        </span>
        {unsaved ? <span className="file__unsaved" title="Unsaved" aria-label="Unsaved" /> : null}
        <span className="file__spacer" />
        {showDiff ? (
          <>
            <button
              type="button"
              className={`file__tool${layout === 'inline' ? ' file__tool--on' : ''}`}
              aria-pressed={layout === 'inline'}
              onClick={() => setDiffLayout('inline')}
            >
              Inline
            </button>
            <button
              type="button"
              className={`file__tool${layout === 'split' ? ' file__tool--on' : ''}`}
              aria-pressed={layout === 'split'}
              disabled={fitLayout('split', bodyWidth) !== 'split'}
              onClick={() => setDiffLayout('split')}
            >
              Side by side
            </button>
          </>
        ) : null}
        <button
          type="button"
          className={`file__tool${showDiff ? ' file__tool--on' : ''}`}
          aria-pressed={showDiff}
          // Left enabled while open, so a diff emptied by a discard can still be closed.
          disabled={changed === false && !showDiff}
          onClick={() => setPaneDiff(paneId, !showDiff)}
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

      <div className="file__body" ref={body}>
        {showDiff ? <DiffBody worktreeId={worktreeId} diffs={diffs} layout={layout} /> : null}
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
  worktreeId,
  diffs,
  layout
}: {
  worktreeId: string
  diffs: Diffs | null
  layout: DiffLayout
}): React.JSX.Element {
  const busy = useWorkspaceStore((state) => state.hunkPending)
  const applyHunk = useWorkspaceStore((state) => state.applyHunk)
  const openDialog = useWorkspaceStore((state) => state.openDialog)
  if (diffs === null) return <p className="file__state">Reading…</p>
  const staged = diffs.staged.patch === '' ? null : diffs.staged
  const working = diffs.working.patch === '' ? null : diffs.working
  if (staged === null && working === null) return <p className="file__state">No changes</p>
  // Halves are named only when both are there; the staged one first, as the next commit's.
  return (
    <div className="file__diff">
      {staged === null ? null : (
        <>
          {working === null ? null : <h3 className="patch__half">Staged</h3>}
          <PatchView
            patch={staged.patch}
            truncated={staged.truncated}
            layout={layout}
            action="Unstage"
            busy={busy}
            onHunk={(file, hunk) => void applyHunk(worktreeId, file.path, hunk, false)}
          />
        </>
      )}
      {working === null ? null : (
        <>
          {staged === null ? null : <h3 className="patch__half">Unstaged</h3>}
          <PatchView
            patch={working.patch}
            truncated={working.truncated}
            layout={layout}
            action="Stage"
            busy={busy}
            onHunk={(file, hunk) => void applyHunk(worktreeId, file.path, hunk, true)}
            onDiscard={(file, hunk) => openDialog({ kind: 'confirm-discard', worktreeId, path: file.path, hunk })}
          />
        </>
      )}
    </div>
  )
}

/** The element's width while `active`, kept current as it resizes; null until measured. */
function useWidth(ref: React.RefObject<HTMLElement | null>, active: boolean): number | null {
  const [width, setWidth] = useState<number | null>(null)
  useEffect(() => {
    const element = ref.current
    if (!active || element === null) return
    setWidth(element.clientWidth)
    const observer = new ResizeObserver(() => setWidth(element.clientWidth))
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, active])
  return width
}

export function FileGlyph(): React.JSX.Element {
  return (
    <svg className="file__glyph" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3 1.5 H7.5 L10 4 V10.5 H3 Z M7.5 1.5 V4 H10" />
    </svg>
  )
}
