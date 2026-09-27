// The brand lockup, drawn in the sidebar's header: the mark in the ink of the text, then the wordmark.

export function Brand(): React.JSX.Element {
  return (
    <span className="brand">
      <BrandMark />
      <span className="wordmark">
        teamree
        <span className="wordmark__dot" aria-hidden="true" />
      </span>
    </span>
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

/** The full mark (`brand/mark.svg`), for 32 px and up, where the reduced one's fused bars would show. */
export function MarkFull({ size }: { size: number }): React.JSX.Element {
  return (
    <svg className="mark" viewBox="0 0 256 256" width={size} height={size} fill="currentColor" aria-hidden="true" focusable="false">
      <path
        fillRule="evenodd"
        d="M16 28H116V228H16Q8 228 8 220V36Q8 28 16 28ZM32 66L96 50V206L32 190ZM140 28H240Q248 28 248 36V220Q248 228 240 228H140ZM160 48L224 68V188L160 208Z"
      />
    </svg>
  )
}
