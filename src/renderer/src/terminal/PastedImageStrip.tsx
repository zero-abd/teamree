// The images in the prompt being written, as thumbnails under the pane. × takes one off the
// strip only: Claude Code still sends it. See docs/plans/pasted-image-preview.md.

import { useLayoutEffect, useRef, useState } from 'react'
import type { ShownImage } from './paneImageLinks'
import { stripImages } from './promptImages'

type StripMemory = { minimized: boolean; removed: ReadonlySet<string> }

/** Per pane, so a strip that remounts with its pane comes back as it was left. */
const memories = new Map<string, StripMemory>()
const FRESH: StripMemory = { minimized: false, removed: new Set() }

type Refocus = { name: string } | null

export function PastedImageStrip({
  terminalId,
  images,
  onOpen
}: {
  terminalId: string
  images: readonly ShownImage[]
  onOpen: (image: ShownImage) => void
}): React.JSX.Element | null {
  const [memory, setMemory] = useState(() => memories.get(terminalId) ?? FRESH)
  const rootRef = useRef<HTMLDivElement | null>(null)
  // A control the keyboard was on can unmount; its successor takes the focus.
  const refocus = useRef<Refocus>(null)

  useLayoutEffect(() => {
    const target = refocus.current
    refocus.current = null
    if (target === null) return
    const buttons = rootRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []
    for (const button of buttons) {
      if ((button.getAttribute('aria-label') ?? button.textContent) === target.name) return button.focus()
    }
  })

  const remember = (next: Partial<StripMemory>, focusNext: string): void => {
    if (rootRef.current?.contains(document.activeElement) === true) refocus.current = { name: focusNext }
    const merged = { ...memory, ...next }
    memories.set(terminalId, merged)
    setMemory(merged)
  }

  const shown = stripImages(images, memory.removed)
  if (shown.length === 0) return null
  const count = `${shown.length} ${shown.length === 1 ? 'image' : 'images'}`

  return (
    // A click leaves the keyboard in the terminal, on the prompt these images belong to.
    <div
      ref={rootRef}
      className={`image-strip${memory.minimized ? ' image-strip--minimized' : ''}`}
      role="group"
      aria-label="Pasted images"
      onMouseDown={(event) => event.preventDefault()}
    >
      {memory.minimized ? (
        <button
          type="button"
          className="image-strip__chip"
          aria-expanded={false}
          onClick={() => remember({ minimized: false }, 'Minimize images')}
        >
          {count}
        </button>
      ) : (
        <>
          <ul className="image-strip__list">
            {shown.map((image, at) => {
              const after = shown[at + 1] ?? shown[at - 1]
              return (
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
                    title="Remove"
                    onClick={() =>
                      remember(
                        { removed: new Set([...memory.removed, image.path]) },
                        after === undefined ? '' : `Remove image ${after.index}`
                      )
                    }
                  >
                    <svg viewBox="0 0 12 12" aria-hidden="true">
                      <path d="M3.5 3.5 L8.5 8.5 M8.5 3.5 L3.5 8.5" />
                    </svg>
                  </button>
                </li>
              )
            })}
          </ul>
          <button
            type="button"
            className="image-strip__minimize"
            aria-label="Minimize images"
            aria-expanded={true}
            title="Minimize"
            onClick={() => remember({ minimized: true }, count)}
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
