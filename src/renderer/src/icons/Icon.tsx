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
  ),
  check: <path d="m2.25 8.25 3.75 3.5 7.75-8" />,
  clone: (
    <>
      <path d="M5 2.25h8.75v8.5H5zM2.25 5v8.75H11" />
      <path d="m8.25 5.25 2.25 2-2.25 2M10.5 7.25H6.75" />
    </>
  ),
  close: <path d="m4.25 4.25 7.5 7.5m0-7.5-7.5 7.5" />,
  copy: (
    <>
      <rect x="5.25" y="4.75" width="8.5" height="9" rx="1.5" />
      <path d="M10.75 4.75v-2.5h-8.5v9h3" />
    </>
  ),
  history: (
    <>
      <path d="M2.25 5.5V2.25M2.25 5.5H5.5" />
      <path d="M2.75 5A6 6 0 1 1 2.5 10.5M8 4.75V8l2.5 1.5" />
    </>
  ),
  maximize: <path d="M2.25 5.75v-3.5h3.5m4.5 0h3.5v3.5m0 4.5v3.5h-3.5m-4.5 0h-3.5v-3.5" />,
  'new-project': (
    <>
      <path d="M1.75 5.75v-2h4l1.5 2h7v7.5h-12.5z" />
      <path d="M8 7.5v4M6 9.5h4" />
    </>
  ),
  'new-task': (
    <>
      <path d="M3.25 1.75h6l3.5 3.5v9H3.25z" />
      <path d="M9.25 1.75v3.5h3.5" />
      <path d="m6 11.75.5-2 4.75-4.75 1.75 1.75-4.75 4.75z" />
    </>
  ),
  'open-folder': (
    <>
      <path d="M1.75 5.75v-2h4l1.5 2h7l-2 7.5h-10z" />
      <path d="M3.25 5.75h11m-4-3.5h3.5v3.5" />
    </>
  ),
  play: <path d="m4.75 2.75 8 5.25-8 5.25z" fill="currentColor" stroke="none" />,
  plus: <path d="M8 2.75v10.5M2.75 8h10.5" />,
  rename: <path d="m3.25 12.75.75-3 6.75-6.75 2.25 2.25L6.25 12zM9.25 4.5l2.25 2.25" />,
  restart: (
    <>
      <path d="M3.25 5.25V2.5m0 2.75H6" />
      <path d="M3.75 4.5A5.75 5.75 0 1 1 2.5 10.75" />
    </>
  ),
  restore: <path d="M5.75 2.25h8v8h-3.5m0 3.5h-8v-8h8z" />,
  search: (
    <>
      <circle cx="6.75" cy="6.75" r="4.5" />
      <path d="m10.25 10.25 3.5 3.5" />
    </>
  ),
  'split-down': (
    <>
      <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="1.5" />
      <path d="M1.75 8.25h12.5" />
    </>
  ),
  'split-right': (
    <>
      <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="1.5" />
      <path d="M8.25 2.25v11.5" />
    </>
  ),
  stop: <rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" />,
  team: (
    <>
      <circle cx="6" cy="5.25" r="2.25" />
      <path d="M1.75 13.25c.25-2.5 1.75-4 4.25-4s4 1.5 4.25 4M10 4.25a2 2 0 0 1 0 4m1.25 1.25c1.75.5 2.75 1.75 3 3.75" />
    </>
  )
} satisfies Record<string, React.JSX.Element>

export type IconName = keyof typeof GLYPHS

export const ICON_NAMES = Object.keys(GLYPHS) as IconName[]

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
