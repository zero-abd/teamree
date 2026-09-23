// A markdown file as a pane: the bar every pane wears, the page under it, and
// the file kept in step — written as the typing pauses, re-read when it moves.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FileContent } from '@shared/entities'
import { filePaneName } from '@shared/filePane'
import { FileBar } from '../files/FileBar'
import { DiffBody, DiffTools, useFileDiff } from '../files/FileDiff'
import type { FilePaneProps } from '../panes/FilePane'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { openInBrowser } from '../shell/openInBrowser'
import { useWorkspaceStore } from '../state/workspaceStore'
import { createAutosave } from './autosave'
import { MarkdownEditor, type MarkdownEditorHandle } from './MarkdownEditor'
import { registerPage } from './openAsArtifact'

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i

/** The worktree path an image link names, read from the page's folder; null when it leaves the worktree. */
function imagePath(page: string, src: string): string | null {
  const link = src.replace(/[?#].*$/, '')
  let decoded = link
  try {
    decoded = decodeURI(link)
  } catch {}
  const parts = decoded.startsWith('/') ? [] : page.split('/').slice(0, -1)
  for (const part of decoded.split('/')) {
    if (part === '' || part === '.') continue
    if (part !== '..') parts.push(part)
    else if (parts.pop() === undefined) return null
  }
  return parts.length === 0 ? null : parts.join('/')
}

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
  onHeaderMenu,
  onMenu,
  searchToken = 0,
  onCloseSearch
}: FilePaneProps): React.JSX.Element {
  const worktreePath = useWorkspaceStore((state) => state.worktrees.find((entry) => entry.id === worktreeId)?.path)
  const dirty = useWorkspaceStore((state) => state.unsavedFiles[paneId] === true)
  const setFileUnsaved = useWorkspaceStore((state) => state.setFileUnsaved)
  const setEditingMarkdown = useWorkspaceStore((state) => state.setEditingMarkdown)
  const filesEpoch = useWorkspaceStore((state) => state.worktreeFilesEpoch)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The file moved under an edited page; the person picks which wins.
  const [onDisk, setOnDisk] = useState<Loaded | null>(null)
  const editor = useRef<MarkdownEditorHandle | null>(null)
  // What this pane last knows to be on disk.
  const known = useRef<Loaded>({ content: '', modifiedAt: 0 })
  // Each image's URL by worktree path; the editor draws every image twice as it starts.
  const images = useRef(new Map<string, Promise<string | null>>())
  const name = filePaneName(path)
  const diff = useFileDiff(paneId, worktreeId, path)

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
    if (focused && loaded !== null && !diff.shown) editor.current?.focus()
  }, [focused, loaded, diff.shown])

  useEffect(() => registerPage(paneId, () => editor.current?.getMarkdown() ?? known.current.content), [paneId])

  // A change reported by the worktree is taken when the page has nothing of its own to lose.
  useEffect(() => {
    images.current.clear()
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

  // Only through a grant the runtime confined to the worktree; a URL passes as written but for `file:`.
  const resolveImage = useCallback(
    (src: string): Promise<string | null> => {
      if (URL_SCHEME.test(src)) return Promise.resolve(/^file:/i.test(src) ? null : src)
      const target = imagePath(path, src)
      if (target === null) return Promise.resolve(null)
      let url = images.current.get(target)
      if (url === undefined) {
        url = runtimeClient
          .call('file.read', { worktreeId, path: target, viewer: true })
          .then((file) => (file.view?.kind === 'image' ? file.view.url : null))
        images.current.set(target, url)
      }
      return url
    },
    [path, worktreeId]
  )

  return (
    <section
      className={`pane pane--markdown${focused ? ' pane--focused' : ''}`}
      aria-label={name}
      onMouseDownCapture={onFocus}
    >
      <FileBar
        path={path}
        name={name}
        title={worktreePath === undefined ? path : `${worktreePath}/${path}`}
        unsaved={dirty}
        onHeaderMenu={onHeaderMenu}
        onMenu={onMenu}
        onClose={onClose}
      >
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
        <DiffTools diff={diff} />
      </FileBar>
      <div className="file__body" ref={diff.body}>
        {diff.shown ? (
          <DiffBody worktreeId={worktreeId} diff={diff} searchToken={searchToken} onCloseSearch={onCloseSearch} />
        ) : null}
        <div className="file__view" hidden={diff.shown}>
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
        </div>
      </div>
    </section>
  )
}
