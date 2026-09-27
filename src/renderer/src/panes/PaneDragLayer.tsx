// Over everything while a tab is dragged: the tab lifted at the pointer, and where it would land, said.

import { usePaneDrag } from './paneDrag'

export function PaneDragLayer(): React.JSX.Element | null {
  const drag = usePaneDrag((state) => state.drag)
  if (drag === null) return null
  const drop = drag.drop
  const mark = drop?.mark
  const target = drop?.target
  const kind = drop?.line
    ? ' pane-drag__mark--line'
    : target?.kind === 'pane' && target.edge === 'center'
      ? ' pane-drag__mark--tab'
      : ''
  return (
    <div className="pane-drag" aria-hidden="true">
      {mark === undefined ? null : (
        <div
          className={`pane-drag__mark${kind}${drop?.refused ? ' pane-drag__mark--refused' : ''}`}
          style={{ left: mark.x, top: mark.y, width: mark.width, height: mark.height }}
        >
          {drop?.label ? <span className="pane-drag__label">{drop.label}</span> : null}
        </div>
      )}
      <div className="pane-drag__ghost" style={{ left: drag.x + 12, top: drag.y + 14 }}>
        {drag.source.label}
      </div>
    </div>
  )
}
