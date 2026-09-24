// A file leaf of the tree, drawn by the viewer its extension picks, or a commit read-only.

import { fileViewerFor } from '@shared/filePane'
import { CommitView } from '../files/CommitView'
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
  /** Bumped to open the find bar over the diff. */
  searchToken?: number
  onCloseSearch?: () => void
}

export function FilePane(props: FilePaneProps & { commit?: string }): React.JSX.Element {
  const { commit, ...file } = props
  if (commit !== undefined) return <CommitView {...file} sha={commit} />
  return fileViewerFor(file.path) === 'markdown' ? <MarkdownPane {...file} /> : <FileView {...file} />
}
