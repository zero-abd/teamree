// A file leaf of the tree, drawn by the viewer its extension picks.

import { fileViewerFor } from '@shared/filePane'
import { FileView } from '../files/FileView'
import { MarkdownPane } from '../markdown/MarkdownPane'

export type FilePaneProps = {
  paneId: string
  worktreeId: string
  path: string
  focused: boolean
  onFocus: () => void
  onClose: () => void
  /** A right-click on the header: the pane's menu. */
  onHeaderMenu?: (event: React.MouseEvent<HTMLElement>) => void
  /** The header's `⋯`: the same menu, hung from it. */
  onMenu?: (event: React.MouseEvent<HTMLElement>) => void
  /** Bumped to open the find bar. */
  searchToken?: number
}

export function FilePane(props: FilePaneProps): React.JSX.Element {
  return fileViewerFor(props.path) === 'markdown' ? <MarkdownPane {...props} /> : <FileView {...props} />
}
