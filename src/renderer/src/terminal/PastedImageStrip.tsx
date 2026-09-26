// The images in the prompt being written, as thumbnails under the pane. × deletes the image's
// placeholder from the prompt (`promptEdit.ts`); the thumbnail goes once the prompt no longer holds it.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ShownImage } from './paneImageLinks'
import type { NotRemoved } from './promptEdit'

/** Per pane, so a strip that remounts with its pane comes back as it was left. */
const minimizedPanes = new Set<string>()

/** Which control the keyboard goes to, once the image at `after` has left the strip. */
type Refocus = { name: string; after?: string } | null

const WHY: Record<NotRemoved, string> = {
  busy: ': agent busy',
  typing: ': typing',
  hidden: ': prompt not in view',
  failed: ''
}

const NOTE_MS = 4_000

export function PastedImageStrip({
  terminalId,
  images,
  onOpen,
  onRemove
}: {
  terminalId: string
  images: readonly ShownImage[]
  onOpen: (image: ShownImage) => void
  onRemove: (image: ShownImage) => Promise<NotRemoved | null>
}): React.JSX.Element | null {
  const [minimized, setMinimized] = useState(() => minimizedPanes.has(terminalId))
  const [removing, setRemoving] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  // A control the keyboard was on can unmount; its successor takes the focus.
  const refocus = useRef<Refocus>(null)

  useLayoutEffect(() => {
    const target = refocus.current
    if (target === null || images.some((image) => image.path === target.after)) return
    refocus.current = null
    const buttons = rootRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []
    for (const button of buttons) {
      if ((button.getAttribute('aria-label') ?? button.textContent) === target.name) return button.focus()
    }
  })

  useEffect(() => {
    if (note === null) return
    const timer = setTimeout(() => setNote(null), NOTE_MS)
    return () => clearTimeout(timer)
  }, [note])

  if (images.length === 0) return null
  const count = `${images.length} ${images.length === 1 ? 'image' : 'images'}`

  const keepFocus = (next: Refocus): void => {
    if (rootRef.current?.contains(document.activeElement) === true) refocus.current = next
  }

  const minimize = (value: boolean): void => {
    keepFocus({ name: value ? count : 'Minimize images' })
    if (value) minimizedPanes.add(terminalId)
    else minimizedPanes.delete(terminalId)
    setMinimized(value)
  }

  const remove = (image: ShownImage, next: ShownImage | undefined): void => {
    if (removing !== null) return
    setRemoving(image.path)
    setNote(null)
    void onRemove(image).then((outcome) => {
      setRemoving(null)
      if (outcome === null)
        keepFocus({ name: next === undefined ? '' : `Remove image ${next.index}`, after: image.path })
      else setNote(`Image ${image.index} not removed${WHY[outcome]}`)
    })
  }

  return (
    // A click leaves the keyboard in the terminal, on the prompt these images belong to.
    <div
      ref={rootRef}
      className={`image-strip${minimized ? ' image-strip--minimized' : ''}`}
      role="group"
      aria-label="Pasted images"
      onMouseDown={(event) => event.preventDefault()}
    >
      {minimized ? (
        <button type="button" className="image-strip__chip" aria-expanded={false} onClick={() => minimize(false)}>
          {count}
        </button>
      ) : (
        <>
          <ul className="image-strip__list">
            {images.map((image, at) => (
              <li key={image.path} className="image-strip__item">
                <button
                  type="button"
                  className="image-strip__thumb"
                  aria-label={`Image ${image.index}`}
                  onClick={() => onOpen(image)}
                >
                  <img src={image.url} alt="" draggable={false} />
                  <span className="image-strip__n" aria-hidden="true">
                    {image.index}
                  </span>
                </button>
                <button
                  type="button"
                  className="image-strip__remove"
                  aria-label={`Remove image ${image.index}`}
                  aria-busy={removing === image.path}
                  title="Remove from prompt"
                  onClick={() => remove(image, images[at + 1] ?? images[at - 1])}
                >
                  <svg viewBox="0 0 12 12" aria-hidden="true">
                    <path d="M3.5 3.5 L8.5 8.5 M8.5 3.5 L3.5 8.5" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
          {note === null ? null : (
            <span className="image-strip__note" role="status">
              {note}
            </span>
          )}
          <button
            type="button"
            className="image-strip__minimize"
            aria-label="Minimize images"
            aria-expanded={true}
            title="Minimize"
            onClick={() => minimize(true)}
          >
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="M3 6 H9" />
            </svg>
          </button>
        </>
      )}
    </div>
  )
}
