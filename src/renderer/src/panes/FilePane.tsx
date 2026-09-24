// A file leaf of the tree, drawn by the viewer its extension picks, or a commit, compare or review read-only.

import { fileViewerFor } from '@shared/filePane'
import { CompareView } from '../compare/CompareView'
import { CommitView } from '../files/CommitView'
import { FileView } from '../files/FileView'
import { MarkdownPane } from '../markdown/MarkdownPane'
import { ReviewView } from '../review/ReviewView'

export type FilePaneProps = {
  paneId: string
  worktreeId: string
  path: string
  focused: boolean
  onFocus: () => void
  onClose: () => void
  /** A tab of the file column, which carries the name's close and unsaved dot. */
  tabbed?: boolean
  /** A right-click on the header: the pane's menu. */
  onHeaderMenu?: (event: React.MouseEvent<HTMLElement>) => void
  /** The header's `⋯`: the same menu, hung from it. */
  onMenu?: (event: React.MouseEvent<HTMLElement>) => void
  /** Bumped to open the find bar over the diff. */
  searchToken?: number
  onCloseSearch?: () => void
}

export function FilePane(
  props: FilePaneProps & { commit?: string; compare?: string; review?: boolean }
): React.JSX.Element {
  const { commit, compare, review, ...file } = props
  if (commit !== undefined) return <CommitView {...file} sha={commit} />
  if (compare !== undefined) return <CompareView {...file} other={compare} />
  if (review === true) return <ReviewView {...file} />
  return fileViewerFor(file.path) === 'markdown' ? <MarkdownPane {...file} /> : <FileView {...file} />
}
