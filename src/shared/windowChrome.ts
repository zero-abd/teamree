// Geometry of the window's top row, shared so main (placing the traffic lights) and the renderer
// (reserving space) agree. The row is the sidebar header and the pane strip; the buttons sit over the left one.

/** Height of the top row: the sidebar's header and the pane strip alike. */
export const TITLEBAR_HEIGHT_PX = 38

/** Diameter of one macOS window button. */
const TRAFFIC_LIGHT_DIAMETER_PX = 12

/** Gap between the buttons. */
const TRAFFIC_LIGHT_GAP_PX = 8

/** Left edge of the first button. Also the strip's left padding on macOS. */
export const TRAFFIC_LIGHT_X_PX = 20

/** Vertical placement, set explicitly: `hiddenInset` defaults to a bar height we do not use. */
export const TRAFFIC_LIGHT_Y_PX = Math.round((TITLEBAR_HEIGHT_PX - TRAFFIC_LIGHT_DIAMETER_PX) / 2)

/** Width of all three buttons plus the two gaps between them. */
const TRAFFIC_LIGHT_CLUSTER_PX = TRAFFIC_LIGHT_DIAMETER_PX * 3 + TRAFFIC_LIGHT_GAP_PX * 2

/** Where a top-row strip's content may start on macOS: past the buttons plus the same margin again. */
export const MAC_CONTENT_INSET_PX = TRAFFIC_LIGHT_X_PX + TRAFFIC_LIGHT_CLUSTER_PX + TRAFFIC_LIGHT_X_PX
