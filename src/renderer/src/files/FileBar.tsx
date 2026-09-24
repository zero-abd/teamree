// The bar every file pane wears, code, markdown or commit: what it shows, the pane's tools, `⋯`, and the
// unsaved dot and `×` unless it is a tab of the file column, whose tab carries those.

import { PaneCloseButton } from '../panes/PaneCloseButton'

type FileBarProps = {
  name: string
  /** What the bar reads at its left; a file's is `PathLabel`. */
  label: React.ReactNode
  /** The label's hover: the absolute path where the worktree is known. */
  title: string
  unsaved: boolean
  tabbed?: boolean | undefined
  onHeaderMenu?: ((event: React.MouseEvent<HTMLElement>) => void) | undefined
  onMenu?: ((event: React.MouseEvent<HTMLElement>) => void) | undefined
  onClose: () => void
  children?: React.ReactNode
}

export function FileBar({
  name,
  label,
  title,
  unsaved,
  tabbed = false,
  onHeaderMenu,
  onMenu,
  onClose,
  children
}: FileBarProps): React.JSX.Element {
  return (
    <header className="pane__bar file__bar" onContextMenu={onHeaderMenu}>
      <span className="pane__title file__path" title={title}>
        {label}
      </span>
      {unsaved && !tabbed ? <UnsavedDot /> : null}
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
      {tabbed ? null : <PaneCloseButton name={name} onClose={onClose} />}
    </header>
  )
}

/** A path as the bar reads it: `dir/` dimmed, then the name. */
export function PathLabel({ path, name }: { path: string; name: string }): React.JSX.Element {
  return (
    <>
      <span className="file__dir">{path.slice(0, path.length - name.length)}</span>
      {name}
    </>
  )
}

/** Toggles drawn as one segmented control; each child is a button with `aria-pressed`. */
export function Segments({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="file__seg" role="group" aria-label={label}>
      {children}
    </div>
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
