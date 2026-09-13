// Geometry of the custom title strip, shared because two processes have to agree
// on it. The main process places the macOS traffic lights with these numbers and
// the renderer reserves space with the same ones; a hardcoded inset on either
// side would drift the first time the other was touched.

/** Height of the strip, and so the row the shell grid reserves for it. */
export const TITLEBAR_HEIGHT_PX = 38

/** Diameter of one macOS window button. */
const TRAFFIC_LIGHT_DIAMETER_PX = 12

/** Gap between the buttons. */
const TRAFFIC_LIGHT_GAP_PX = 8

/** Left edge of the first button. Also the strip's left padding on macOS. */
export const TRAFFIC_LIGHT_X_PX = 20

/**
 * Vertical placement. Electron measures from the top of the content view, and
 * `titleBarStyle: 'hiddenInset'` picks its own default for a bar height we are
 * not using — so it is set explicitly to centre the buttons in our strip.
 */
export const TRAFFIC_LIGHT_Y_PX = Math.round((TITLEBAR_HEIGHT_PX - TRAFFIC_LIGHT_DIAMETER_PX) / 2)

/** Width of all three buttons plus the two gaps between them. */
const TRAFFIC_LIGHT_CLUSTER_PX = TRAFFIC_LIGHT_DIAMETER_PX * 3 + TRAFFIC_LIGHT_GAP_PX * 2

/**
 * Where the strip's own content may start on macOS: past the buttons, plus the
 * same left margin again so the wordmark is not crowded against them.
 */
export const MAC_CONTENT_INSET_PX = TRAFFIC_LIGHT_X_PX + TRAFFIC_LIGHT_CLUSTER_PX + TRAFFIC_LIGHT_X_PX
