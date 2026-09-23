// An image fitted to the pane, with zoom steps and ⌘-scroll.

import { useState } from 'react'

const STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 8]

export type Zoom = 'fit' | number

/** The next zoom step from `current` in `direction`, starting from `fitted` when the image is fitted. */
export function stepZoom(current: Zoom, fitted: number, direction: 1 | -1): number {
  const from = current === 'fit' ? fitted : current
  const next =
    direction === 1 ? STEPS.find((step) => step > from + 1e-6) : [...STEPS].reverse().find((step) => step < from - 1e-6)
  return next ?? from
}

export function ImageView({ url, name }: { url: string; name: string }): React.JSX.Element {
  const [zoom, setZoom] = useState<Zoom>('fit')
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  const [fitted, setFitted] = useState(1)

  const step = (direction: 1 | -1): void => setZoom((current) => stepZoom(current, fitted, direction))
  const label = zoom === 'fit' ? 'Fit' : `${Math.round(zoom * 100)}%`
  const size = natural && zoom !== 'fit' ? { width: natural.width * zoom, height: natural.height * zoom } : undefined

  return (
    <div className={`image${zoom === 'fit' ? ' image--fit' : ''}`}>
      <div
        className="image__scroll"
        onWheel={(event) => {
          if (!event.metaKey && !event.ctrlKey) return
          event.preventDefault()
          step(event.deltaY < 0 ? 1 : -1)
        }}
      >
        <div className="image__stage">
          <img
            src={url}
            alt={name}
            draggable={false}
            style={size}
            onLoad={(event) => {
              const image = event.currentTarget
              setNatural({ width: image.naturalWidth, height: image.naturalHeight })
              if (image.naturalWidth > 0) setFitted(Math.min(1, image.clientWidth / image.naturalWidth))
            }}
          />
        </div>
      </div>
      <div className="image__zoom" role="group" aria-label="Zoom">
        <button type="button" aria-label="Zoom out" onClick={() => step(-1)}>
          −
        </button>
        <button
          type="button"
          className="image__level"
          title={natural ? `${natural.width}×${natural.height}` : undefined}
          onClick={() => setZoom((current) => (current === 'fit' ? 1 : 'fit'))}
        >
          {label}
        </button>
        <button type="button" aria-label="Zoom in" onClick={() => step(1)}>
          +
        </button>
      </div>
    </div>
  )
}
