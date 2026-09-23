// A markdown file as a pane: the bar every pane wears, the page under it, and
// the file kept in step — written as the typing pauses, re-read when it moves.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FileContent } from '@shared/entities'
import { filePaneName } from '@shared/filePane'
import type { FilePaneProps } from '../panes/FilePane'
import { PaneCloseButton } from '../panes/PaneCloseButton'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { openInBrowser } from '../shell/openInBrowser'
import { useWorkspaceStore } from '../state/workspaceStore'
import { NEW_CHAT_URL } from './artifactUrl'
import { createAutosave } from './autosave'
import { MarkdownEditor, type MarkdownEditorHandle } from './MarkdownEditor'

type Loaded = { content: string; modifiedAt: number; encoding?: 'utf-8' | 'utf-8-bom' }

function loadedFrom(file: FileContent): Loaded {
  return {
    content: file.content,
    modifiedAt: file.modifiedAt,
    ...(file.encoding === undefined ? {} : { encoding: file.encoding })
  }
}

export function MarkdownPane({
  paneId,
  worktreeId,
  path,
  focused,
  onFocus,
  onClose,
  onHeaderMenu
}: FilePaneProps): React.JSX.Element {
  const worktreePath = useWorkspaceStore((state) => state.worktrees.find((entry) => entry.id === worktreeId)?.path)
  const dirty = useWorkspaceStore((state) => state.unsavedFiles[paneId] === true)
  const setFileUnsaved = useWorkspaceStore((state) => state.setFileUnsaved)
  const setEditingMarkdown = useWorkspaceStore((state) => state.setEditingMarkdown)
  const copyToClipboard = useWorkspaceStore((state) => state.copyToClipboard)
  const filesEpoch = useWorkspaceStore((state) => state.worktreeFilesEpoch)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The file moved under an edited page; the person picks which wins.
  const [onDisk, setOnDisk] = useState<Loaded | null>(null)
  const editor = useRef<MarkdownEditorHandle | null>(null)
  // What this pane last knows to be on disk.
  const known = useRef<Loaded>({ content: '', modifiedAt: 0 })
  const name = filePaneName(path)

  const autosave = useMemo(
    () =>
      createAutosave({
        save: async (content) => {
          if (content === known.current.content) {
            setFileUnsaved(paneId, false)
            return
          }
          try {
            const { encoding } = known.current
            const written = await runtimeClient.call('file.write', {
              worktreeId,
              path,
              content,
              ...(encoding === undefined ? {} : { encoding })
            })
            known.current = { ...known.current, content, modifiedAt: written.modifiedAt }
            setFileUnsaved(paneId, false)
            setError(null)
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure))
          }
        }
      }),
    [paneId, path, setFileUnsaved, worktreeId]
  )

  useEffect(() => {
    let alive = true
    runtimeClient
      .call('file.read', { worktreeId, path })
      .then((file) => {
        if (!alive) return
        known.current = loadedFrom(file)
        setLoaded(known.current)
      })
      .catch((failure: unknown) => {
        if (alive) setError(failure instanceof Error ? failure.message : String(failure))
      })
    const flush = (): void => void autosave.flush()
    window.addEventListener('beforeunload', flush)
    return () => {
      alive = false
      window.removeEventListener('beforeunload', flush)
      flush()
      setFileUnsaved(paneId, false)
      setEditingMarkdown(false)
    }
  }, [autosave, paneId, path, setEditingMarkdown, setFileUnsaved, worktreeId])

  // The keyboard follows the focus here, so a new page can be typed on at once.
  useEffect(() => {
    if (focused && loaded !== null) editor.current?.focus()
  }, [focused, loaded])

  // A change reported by the worktree is taken when the page has nothing of its own to lose.
  useEffect(() => {
    if (loaded === null) return
    let alive = true
    void runtimeClient
      .call('file.read', { worktreeId, path })
      .then((file) => {
        if (!alive || file.modifiedAt === known.current.modifiedAt || file.content === known.current.content) return
        const next = loadedFrom(file)
        if (autosave.pending() || useWorkspaceStore.getState().unsavedFiles[paneId] === true) {
          setOnDisk(next)
          return
        }
        known.current = next
        editor.current?.setMarkdown(file.content)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesEpoch])

  const reload = (): void => {
    if (onDisk === null) return
    autosave.cancel()
    known.current = onDisk
    editor.current?.setMarkdown(onDisk.content)
    setFileUnsaved(paneId, false)
    setOnDisk(null)
  }

  const onChange = useCallback(
    (markdown: string) => {
      if (markdown === known.current.content) {
        autosave.cancel()
        setFileUnsaved(paneId, false)
        return
      }
      setFileUnsaved(paneId, true)
      autosave.change(markdown)
    },
    [autosave, paneId, setFileUnsaved]
  )

  const openAsArtifact = async (): Promise<void> => {
    await copyToClipboard(editor.current?.getMarkdown() ?? known.current.content, name)
    openInBrowser(NEW_CHAT_URL)
  }

  const resolveImage = useCallback(
    (src: string): string => {
      if (/^[a-z]+:/i.test(src) || worktreePath === undefined) return src
      return `file://${worktreePath}/${src.replace(/^\/+/, '')}`
    },
    [worktreePath]
  )

  return (
    <section
      className={`pane pane--markdown${focused ? ' pane--focused' : ''}`}
      aria-label={name}
      onMouseDownCapture={onFocus}
    >
      <header className="pane__bar" onContextMenu={onHeaderMenu}>
        <span
          className={`md-dot${dirty ? ' md-dot--unsaved' : ''}`}
          title={dirty ? 'Unsaved' : 'Saved'}
          aria-hidden="true"
        />
        <span className="pane__title" title={path}>
          {name}
        </span>
        {error === null ? null : (
          <span className="chip pane__exit" title={error}>
            not saved
          </span>
        )}
        {onDisk === null ? null : (
          <button type="button" className="pane__again" onClick={reload}>
            Reload
          </button>
        )}
        <button
          type="button"
          className="pane__again md-artifact-button"
          title="Copy, then open claude.ai"
          onClick={() => void openAsArtifact()}
        >
          Open as artifact
        </button>
        <PaneCloseButton name={name} onClose={onClose} />
      </header>
      {loaded === null ? (
        <div className="md-frame" />
      ) : (
        <MarkdownEditor
          ref={editor}
          initial={loaded.content}
          onChange={onChange}
          onFocusChange={setEditingMarkdown}
          onOpenUrl={openInBrowser}
          resolveImage={resolveImage}
        />
      )}
    </section>
  )
}
