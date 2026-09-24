// The bar every file pane wears, code or markdown: glyph, path, unsaved dot, the pane's tools, `⋯`, `×`.

import { PaneCloseButton } from '../panes/PaneCloseButton'

type FileBarProps = {
  path: string
  name: string
  /** The path's hover: the absolute one where the worktree is known. */
  title: string
  unsaved: boolean
  onHeaderMenu?: ((event: React.MouseEvent<HTMLElement>) => void) | undefined
  onMenu?: ((event: React.MouseEvent<HTMLElement>) => void) | undefined
  onClose: () => void
  children?: React.ReactNode
  /** Drawn before the path instead of the file glyph. */
  glyph?: React.ReactNode
}

export function FileBar({
  path,
  name,
  title,
  unsaved,
  onHeaderMenu,
  onMenu,
  onClose,
  children,
  glyph = <FileGlyph />
}: FileBarProps): React.JSX.Element {
  return (
    <header className="pane__bar file__bar" onContextMenu={onHeaderMenu}>
      {glyph}
      <span className="pane__title file__path" title={title}>
        <span className="file__dir">{path.slice(0, path.length - name.length)}</span>
        {name}
      </span>
      {unsaved ? <UnsavedDot /> : null}
      <span className="file__spacer" />
      {children}
      <button
        type="button"
        className="file__tool file__more"
        aria-label={`More for ${name}`}
        title="More"
        onClick={onMenu}
      >
        ⋯
      </button>
      <PaneCloseButton name={name} onClose={onClose} />
    </header>
  )
}

/** A file's edits are ahead of the disk; the tab and the bar draw the same one. */
export function UnsavedDot(): React.JSX.Element {
  return <span className="file__unsaved" role="img" aria-label="Unsaved" title="Unsaved" data-testid="unsaved" />
}

export function FileGlyph(): React.JSX.Element {
  return (
    <svg className="file__glyph" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3 1.5 H7.5 L10 4 V10.5 H3 Z M7.5 1.5 V4 H10" />
    </svg>
  )
}

export function CommitGlyph(): React.JSX.Element {
  return (
    <svg className="file__glyph" viewBox="0 0 12 12" aria-hidden="true">
      <circle cx="6" cy="6" r="2.25" />
      <path d="M0.5 6 H3.75 M8.25 6 H11.5" />
    </svg>
  )
}
