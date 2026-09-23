// The brand lockup: the mark on its tile, then the wordmark. It used to be the
// whole of a title strip across the top of the window; the strip is gone and
// the lockup is the sidebar's, drawn in the sidebar's own header.

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

/**
 * The glyph on both sidebar toggles: a window with its left panel marked. The
 * same drawing whether the sidebar is being put away or brought back, because
 * the button's position says which — the sidebar's header for one, the left
 * end of the pane strip for the other — and the label says it in words.
 */
export function SidebarGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 14 14" aria-hidden="true">
      <rect x="1.5" y="2.5" width="11" height="9" rx="1.5" />
      <path d="M5.5 2.5 V11.5" />
    </svg>
  )
}

/**
 * The teamree mark: two slabs facing a shared centre, each with a slanted
 * window, the right one a little taller than the left.
 *
 * This is the reduced form of the artwork (`brand/mark-small.svg`), not the
 * full one — the tile is 22px, and below about 32px the full mark's thinner
 * frame bars drop under a device pixel and fuse with the window, so the
 * reduced form narrows the windows and thickens the frames. The site's header
 * tile and the favicon make the same call for the same reason.
 *
 * Inlined rather than loaded from `brand/` so it inherits `currentColor` and
 * needs no asset path at runtime — the packaged renderer ships no copy of that
 * directory. Decorative throughout: the wordmark beside it already announces
 * the name, so a screen reader that read this too would say "teamree" twice.
 */
function BrandMark(): React.JSX.Element {
  return (
    <svg className="brand__mark" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" focusable="false">
      <path
        fillRule="evenodd"
        d="M16 28H116V228H16Q8 228 8 220V36Q8 28 16 28ZM34 68L94 53V203L34 188ZM140 28H240Q248 28 248 36V220Q248 228 240 228H140ZM162 52L222 70V186L162 204Z"
      />
    </svg>
  )
}
