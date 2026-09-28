// A boundary in a pane's scrollback: a short label between two rules. Main writes it as one dim line; the
// renderer draws a `.pane-marker` over any line of this shape.

const RULE = '──'

const MARKER_LINE = /^── (\S.*?) ──\s*$/u

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function markerText(label: string): string {
  return `${RULE} ${label} ${RULE}`
}

/** The label of a marker line, or null for any other line. */
export function markerLabel(line: string): string | null {
  return MARKER_LINE.exec(line)?.[1] ?? null
}

/** Local wall-clock to the minute; the day is added once it is not today. */
export function markerTime(at: number, now: number = Date.now()): string {
  const when = new Date(at)
  const today = new Date(now)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const clock = `${pad(when.getHours())}:${pad(when.getMinutes())}`
  const sameDay =
    when.getFullYear() === today.getFullYear() &&
    when.getMonth() === today.getMonth() &&
    when.getDate() === today.getDate()
  return sameDay ? clock : `${MONTHS[when.getMonth()]} ${when.getDate()} ${clock}`
}
