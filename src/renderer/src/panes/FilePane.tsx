// A file leaf of the tree, drawn by the viewer its extension picks.

import { filePaneName, fileViewerFor } from '@shared/filePane'
import { MarkdownPane } from '../markdown/MarkdownPane'
import { PaneCloseButton } from './PaneCloseButton'

export type FilePaneProps = {
  paneId: string
  worktreeId: string
  path: string
  focused: boolean
  onFocus: () => void
  onClose: () => void
}

export function FilePane(props: FilePaneProps): React.JSX.Element {
  switch (fileViewerFor(props.path)) {
    case 'markdown':
      return <MarkdownPane {...props} />
    case null:
      return <NoViewer {...props} />
  }
}

/** A leaf another client wrote for a file this build cannot draw. */
function NoViewer({ path, focused, onFocus, onClose }: FilePaneProps): React.JSX.Element {
  const name = filePaneName(path)
  return (
    <section className={`pane${focused ? ' pane--focused' : ''}`} aria-label={name} onMouseDownCapture={onFocus}>
      <header className="pane__bar">
        <span className="pane__title" title={path}>
          {name}
        </span>
        <PaneCloseButton name={name} onClose={onClose} />
      </header>
    </section>
  )
}
