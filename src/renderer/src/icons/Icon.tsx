// The app's line icons: 16-unit glyphs stroked in the text colour, so a row's ink is the icon's.

const FILE_OUTLINE = (
  <>
    <path d="M3.25 1.75h6l3.5 3.5v9H3.25z" />
    <path d="M9.25 1.75v3.5h3.5" />
  </>
)

const GLYPHS = {
  file: FILE_OUTLINE,
  'file-code': (
    <>
      {FILE_OUTLINE}
      <path d="M6.75 8 5.25 9.75l1.5 1.75M9.25 8l1.5 1.75-1.5 1.75" />
    </>
  ),
  'file-text': (
    <>
      {FILE_OUTLINE}
      <path d="M5.75 8.25h4.5M5.75 11h4.5" />
    </>
  ),
  'file-data': (
    <>
      {FILE_OUTLINE}
      <path d="M7 7.75h-.75v1.5l-.75.75.75.75v1.5H7M9 7.75h.75v1.5l.75.75-.75.75v1.5H9" />
    </>
  ),
  'file-image': (
    <>
      {FILE_OUTLINE}
      <path d="m5.25 12.25 2-2.25 1.5 1.5 1-1 1 1.75" />
      <path d="M6.5 7.75h.01" />
    </>
  ),
  folder: <path d="M1.75 4.25h4l1.5 1.5h7v7.5h-12.5z" />,
  'folder-open': (
    <>
      <path d="M1.75 5.75v-2h4l1.5 2h7l-2 7.5h-10z" />
      <path d="M3.25 5.75h11" />
    </>
  ),
  reveal: (
    <>
      <path d="M1.75 4.25h4l1.5 1.5h7v7.5h-12.5z" />
      <path d="M8.75 2.25h5v5M13.75 2.25 8.5 7.5" />
    </>
  ),
  discard: (
    <>
      <path d="M5.25 5.25H2.5v-2.75" />
      <path d="M2.75 5A6 6 0 1 1 2.5 10.75" />
      <path d="m5.25 8 2 2 3.75-4" />
    </>
  )
} satisfies Record<string, React.JSX.Element>

export type IconName = keyof typeof GLYPHS

/** One glyph, hidden from assistive tech: the control around it carries the name. */
export function Icon({
  name,
  size = 16,
  className
}: {
  name: IconName
  size?: number
  className?: string
}): React.JSX.Element {
  return (
    <svg
      className={className}
      data-icon={name}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {GLYPHS[name]}
    </svg>
  )
}
