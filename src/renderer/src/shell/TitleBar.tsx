// The window's title strip. It carries the brand lockup and, more importantly,
// it is the window's drag region: with the native title bar hidden on macOS
// there is nothing else to grab the window by.

import { titleBarClassName } from './titleBarClass'

export function TitleBar({ platform }: { platform: string | undefined }): React.JSX.Element {
  return (
    <header className={titleBarClassName(platform)}>
      <span className="brand">
        <span className="brand__tile" aria-hidden="true">
          <BrandMark />
        </span>
        <span className="wordmark">
          teamree
          <span className="wordmark__dot" aria-hidden="true" />
        </span>
      </span>
    </header>
  )
}

/**
 * The teamree mark: three terminal windows on a branching trunk that merges
 * back into one root.
 *
 * This is the reduced form of the artwork (`brand/mark-small.svg`), not the full
 * one — below about 32px the full mark's window interiors antialias into grey
 * and the three windows close up into one blob, so the interiors are dropped
 * and every stroke is thickened. The site's header tile makes the same call for
 * the same reason, and this sits smaller still.
 *
 * Inlined rather than loaded from `brand/` so it inherits `currentColor` and
 * needs no asset path at runtime — the packaged renderer ships no copy of that
 * directory. Decorative throughout: the wordmark beside it already announces
 * the name, so a screen reader that read this too would say "teamree" twice.
 */
function BrandMark(): React.JSX.Element {
  return (
    <svg className="brand__mark" viewBox="0 0 64 64" fill="currentColor" aria-hidden="true" focusable="false">
      {/* the root */}
      <path d="M14 58.8 Q32 45.6 50 58.8 Q32 54.2 14 58.8 Z" />

      {/* the trunk */}
      <path d="M29.2 18 H34.8 V57 H29.2 Z" />

      {/* the branches */}
      <g fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round">
        <path d="M14.9 37 C14.9 43.8 32 45.8 29.2 54.4" />
        <path d="M49.1 37 C49.1 43.8 32 45.8 34.8 54.4" />
      </g>

      {/* the chevron where the branches meet the trunk */}
      <g fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round">
        <path d="M26.6 39.6 L32 46.4" />
        <path d="M37.4 39.6 L32 46.4" />
      </g>

      {/* the three windows, solid */}
      <g>
        <path d="M24.4 4.5 H39.6 A3.4 3.4 0 0 1 43 7.9 V16.1 A3.4 3.4 0 0 1 39.6 19.5 H24.4 A3.4 3.4 0 0 1 21 16.1 V7.9 A3.4 3.4 0 0 1 24.4 4.5 Z" />
        <path d="M5.4 23.5 H20.5 A3.4 3.4 0 0 1 23.9 26.9 V35.1 A3.4 3.4 0 0 1 20.5 38.5 H5.4 A3.4 3.4 0 0 1 2 35.1 V26.9 A3.4 3.4 0 0 1 5.4 23.5 Z" />
        <path d="M43.5 23.5 H58.6 A3.4 3.4 0 0 1 62 26.9 V35.1 A3.4 3.4 0 0 1 58.6 38.5 H43.5 A3.4 3.4 0 0 1 40.1 35.1 V26.9 A3.4 3.4 0 0 1 43.5 23.5 Z" />
      </g>
    </svg>
  )
}
