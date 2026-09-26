// The hover thumbnail and the full view for a pasted image; see `paneImageLinks.ts`.

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Modal } from '../dialogs/Modal'
import { useWorkspaceStore } from '../state/workspaceStore'
import type { ShownImage } from './paneImageLinks'

export type ImagePeek = ShownImage & { x: number; y: number }

const PEEK_WIDTH = 256
const PEEK_HEIGHT = 196
const PEEK_GAP = 14

/** Below and right of the pointer, flipped where the window ends. */
export function peekPosition(x: number, y: number, width: number, height: number): { left: number; top: number } {
  const left = Math.max(PEEK_GAP, Math.min(x + PEEK_GAP, width - PEEK_WIDTH - PEEK_GAP))
  const below = y + PEEK_GAP
  const top = below + PEEK_HEIGHT <= height - PEEK_GAP ? below : Math.max(PEEK_GAP, y - PEEK_GAP - PEEK_HEIGHT)
  return { left, top }
}

export function PastedImagePeek({ peek }: { peek: ImagePeek }): React.JSX.Element | null {
  const [broken, setBroken] = useState<string | null>(null)
  if (broken === peek.url) return null
  const { left, top } = peekPosition(peek.x, peek.y, window.innerWidth, window.innerHeight)
  return createPortal(
    <div className="image-peek" style={{ left, top }} aria-hidden="true">
      <img src={peek.url} alt="" onError={() => setBroken(peek.url)} />
    </div>,
    document.body
  )
}

export function PastedImageViewer({ image, onClose }: { image: ShownImage; onClose: () => void }): React.JSX.Element {
  const revealInFinder = useWorkspaceStore((state) => state.revealInFinder)
  const [broken, setBroken] = useState(false)
  const title = `Image #${image.index}`
  return (
    <Modal title={title} titleHint={image.path} onClose={onClose}>
      <div className="pasted-image">
        {broken ? (
          <p className="pasted-image__gone">Gone from disk</p>
        ) : (
          <img className="pasted-image__img" src={image.url} alt={title} onError={() => setBroken(true)} />
        )}
        <div className="modal__actions">
          <button type="button" className="button" onClick={() => void revealInFinder(image.path, title)}>
            Reveal in Finder
          </button>
          <button type="button" className="button button--primary" data-default onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  )
}
