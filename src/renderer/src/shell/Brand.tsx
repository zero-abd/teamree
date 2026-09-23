// The brand lockup, drawn in the sidebar's header: the mark on its tile, then the wordmark.

export function Brand(): React.JSX.Element {
  return (
    <span className="brand">
      <span className="brand__tile" aria-hidden="true">
        <BrandMark />
      </span>
      <span className="wordmark">
        teamree
        <span className="wordmark__dot" aria-hidden="true" />
      </span>
    </span>
  )
}

/** The glyph on both sidebar toggles; the button's position and label say which way. */
export function SidebarGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 14 14" aria-hidden="true">
      <rect x="1.5" y="2.5" width="11" height="9" rx="1.5" />
      <path d="M5.5 2.5 V11.5" />
    </svg>
  )
}

/**
 * The teamree mark in its reduced form (`brand/mark-small.svg`): below ~32px the full mark's frame bars
 * fuse. Inlined for `currentColor` and no asset path; decorative, since the wordmark names it.
 */
export function BrandMark(): React.JSX.Element {
  return (
    <svg className="brand__mark" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" focusable="false">
      <path
        fillRule="evenodd"
        d="M16 28H116V228H16Q8 228 8 220V36Q8 28 16 28ZM34 68L94 53V203L34 188ZM140 28H240Q248 28 248 36V220Q248 228 240 228H140ZM162 52L222 70V186L162 204Z"
      />
    </svg>
  )
}
