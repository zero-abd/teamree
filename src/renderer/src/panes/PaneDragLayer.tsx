// Over everything while a tab is dragged: the tab's name at the pointer, and where it would land.

import { usePaneDrag } from './paneDrag'

export function PaneDragLayer(): React.JSX.Element | null {
  const drag = usePaneDrag((state) => state.drag)
  if (drag === null) return null
  const mark = drag.drop?.mark
  const kind = drag.drop?.line ? ' pane-drag__mark--line' : ''
  return (
    <div className="pane-drag" aria-hidden="true">
      {mark === undefined ? null : (
        <div
          className={`pane-drag__mark${kind}${drag.drop?.refused ? ' pane-drag__mark--refused' : ''}`}
          style={{ left: mark.x, top: mark.y, width: mark.width, height: mark.height }}
        />
      )}
      <div className="pane-drag__ghost" style={{ left: drag.x + 12, top: drag.y + 14 }}>
        {drag.source.label}
      </div>
    </div>
  )
}
