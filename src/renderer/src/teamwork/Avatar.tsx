// A teammate's face: initials on a colour picked from their handle, so a person is the same colour on
// every machine, and a presence mark. Shared by the sidebar and the Team page.

export type Presence = 'online' | 'away' | 'unknown'

/** Hues spaced apart and away from the amber, green and red that mean asking, done and failed. */
export const AVATAR_HUES = [205, 240, 270, 300, 330, 180, 355, 110] as const

export function avatarInitials(handle: string): string {
  const words = handle
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean)
  const [first, second] = words
  if (first === undefined) return '?'
  if (second !== undefined) return `${first[0]}${second[0]}`.toUpperCase()
  return `${first[0]?.toUpperCase() ?? ''}${first.slice(1, 2).toLowerCase()}`
}

/** FNV-1a over the handle. */
export function avatarHue(handle: string): number {
  let hash = 0x811c9dc5
  for (const char of handle) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return AVATAR_HUES[hash % AVATAR_HUES.length] as number
}

export function Avatar({
  handle,
  presence = 'unknown',
  size = 'sm',
  decorative = false
}: {
  handle: string
  presence?: Presence
  size?: 'xs' | 'sm' | 'md'
  /** When the handle is already said beside it. */
  decorative?: boolean
}): React.JSX.Element {
  const label = presence === 'unknown' ? handle : `${handle}, ${presence}`
  return (
    <span
      className={`avatar avatar--${size} avatar--${presence}`}
      style={{ '--avatar-hue': avatarHue(handle) } as React.CSSProperties}
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}
    >
      {avatarInitials(handle)}
      {presence === 'unknown' ? null : <span className="avatar__presence" />}
    </span>
  )
}
