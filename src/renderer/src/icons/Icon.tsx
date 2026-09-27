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
  ),
  remove: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="m5.5 5.5 5 5m0-5-5 5" />
    </>
  ),
  minimize: <path d="M3.25 8.25h9.5" />,
  'sidebar-toggle': (
    <>
      <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="1.5" />
      <path d="M5.25 2.25v11.5" />
    </>
  ),
  'panel-hide': <path d="m5.75 3.25 4.75 4.75-4.75 4.75M13.25 2.25v11.5" />,
  'panel-show': <path d="m10.25 3.25-4.75 4.75 4.75 4.75M2.75 2.25v11.5" />,
  'chevron-up': <path d="m3.25 10.25 4.75-4.75 4.75 4.75" />,
  'chevron-down': <path d="m3.25 5.75 4.75 4.75 4.75-4.75" />,
  'chevron-left': <path d="m10.25 3.25-4.75 4.75 4.75 4.75" />,
  'chevron-right': <path d="m5.75 3.25 4.75 4.75-4.75 4.75" />,
  'all-panes': (
    <>
      <rect x="1.75" y="1.75" width="5" height="5" rx="1" />
      <rect x="9.25" y="1.75" width="5" height="5" rx="1" />
      <rect x="1.75" y="9.25" width="5" height="5" rx="1" />
      <rect x="9.25" y="9.25" width="5" height="5" rx="1" />
    </>
  ),
  appearance: (
    <>
      <path d="M8 1.75a6.25 6.25 0 1 0 0 12.5h1a1.5 1.5 0 0 0 0-3H8.5a1.25 1.25 0 0 1 0-2.5h1.25A4.5 4.5 0 0 0 8 1.75Z" />
      <circle cx="4.75" cy="6" r=".5" fill="currentColor" stroke="none" />
      <circle cx="6" cy="3.75" r=".5" fill="currentColor" stroke="none" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2.25" />
      <path d="M8 1.5v1.25M8 13.25v1.25M1.5 8h1.25M13.25 8h1.25M3.5 3.5l.9.9m7.2 7.2.9.9m0-9-.9.9m-7.2 7.2-.9.9" />
      <circle cx="8" cy="8" r="5.25" />
    </>
  ),
  help: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M5.75 5.75A2.25 2.25 0 1 1 8 8v1.25" />
      <circle cx="8" cy="12" r=".55" fill="currentColor" stroke="none" />
    </>
  ),
  filter: <path d="M1.75 3.25h12.5L9.5 8.5v4l-3 1.5V8.5z" />,
  'density-compact': <path d="M2.25 3.25h11.5M2.25 6.5h11.5M2.25 9.75h11.5M2.25 13h11.5" />,
  'density-comfortable': <path d="M2.25 2.75h11.5M2.25 8h11.5M2.25 13.25h11.5" />,
  more: (
    <>
      <circle cx="3.25" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="12.75" cy="8" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  terminal: (
    <>
      <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="1.5" />
      <path d="m4.25 5.25 2.5 2.5-2.5 2.5M8.75 10.25h2.75" />
    </>
  ),
  agent: (
    <path d="M8 1.5c.5 3.75 2.75 6 6.5 6.5-3.75.5-6 2.75-6.5 6.5-.5-3.75-2.75-6-6.5-6.5 3.75-.5 6-2.75 6.5-6.5Z" />
  ),
  page: (
    <>
      <rect x="3.25" y="1.75" width="9.5" height="12.5" rx="1.5" />
      <path d="M5.75 5h4.5M5.75 8h4.5M5.75 11h2.75" />
    </>
  ),
  reload: (
    <>
      <path d="M12.75 5.25V2.5m0 2.75H10" />
      <path d="M12.25 4.5A5.75 5.75 0 1 0 13.5 10.75" />
    </>
  ),
  changes: (
    <>
      <path d="M3.25 1.75h6l3.5 3.5v9H3.25z" />
      <path d="M9.25 1.75v3.5h3.5" />
      <path d="M6 8h4.5M6 11h4.5M5.75 5.25h.5" />
    </>
  ),
  'diff-inline': (
    <>
      <rect x="2.25" y="1.75" width="11.5" height="12.5" rx="1.5" />
      <path d="M5 5.25h5.5M7.75 3v4.5M5 10.75h5.5" />
    </>
  ),
  'diff-split': (
    <>
      <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="1.5" />
      <path d="M8 2.25v11.5M3.75 6h2.5m-1.25-1.25v2.5m4.75 3h2.5" />
    </>
  ),
  wrap: <path d="M2.25 4.25h8a3 3 0 0 1 0 6H6.5m2-2-2 2 2 2M2.25 7.25h4" />,
  whitespace: (
    <>
      <path d="M3 3.25h10M3 8h6M3 12.75h10" />
      <path d="m11 6 2 2-2 2" />
    </>
  ),
  'merge-clean': (
    <>
      <circle cx="4" cy="3" r="1.25" />
      <circle cx="4" cy="13" r="1.25" />
      <circle cx="12" cy="8" r="1.25" />
      <path d="M4 4.25v7.5M5.25 5.25C8.75 5.25 8.5 8 10.75 8" />
    </>
  ),
  'merge-conflict': (
    <>
      <circle cx="4" cy="3" r="1.25" />
      <circle cx="4" cy="13" r="1.25" />
      <circle cx="12" cy="8" r="1.25" />
      <path d="M4 4.25v2M4 9.75v2M5.25 5.25C7 5.25 7.75 6 8.5 6.75m1.25 1C10 7.9 10.25 8 10.75 8" />
    </>
  ),
  'keep-awake': (
    <path d="M2.25 5.25h8v5a3 3 0 0 1-3 3h-2a3 3 0 0 1-3-3zM10.25 6.75h1.5a2 2 0 0 1 0 4h-1.5M4.25 2.25v1m4-1v1" />
  ),
  'keep-awake-on': (
    <>
      <path d="M2.25 5.25h8v5a3 3 0 0 1-3 3h-2a3 3 0 0 1-3-3z" fill="currentColor" stroke="none" />
      <path d="M10.25 6.75h1.5a2 2 0 0 1 0 4h-1.5M4.25 2.25v1m4-1v1" />
    </>
  ),
  resources: (
    <>
      <rect x="3.25" y="3.25" width="9.5" height="9.5" rx="1.5" />
      <path d="M6 1.5v1.75m4-1.75v1.75M6 12.75v1.75m4-1.75v1.75M1.5 6h1.75M12.75 6h1.75M1.5 10h1.75M12.75 10h1.75M6 9.75l1.5-3 1.25 2 1.25-2.5" />
    </>
  ),
  warning: (
    <>
      <path d="M8 1.75 14.25 13H1.75z" />
      <path d="M8 5.25v4" />
      <circle cx="8" cy="11.5" r=".55" fill="currentColor" stroke="none" />
    </>
  ),
  'md-bullets': (
    <>
      <circle cx="2.5" cy="4" r=".75" fill="currentColor" stroke="none" />
      <circle cx="2.5" cy="8" r=".75" fill="currentColor" stroke="none" />
      <circle cx="2.5" cy="12" r=".75" fill="currentColor" stroke="none" />
      <path d="M5 4h8.75M5 8h8.75M5 12h8.75" />
    </>
  ),
  'md-numbers': <path d="M2 3.25h1v3M2 9.75c1.75-1 2.5.75 0 2.5h2M6 4.75h7.75M6 11.25h7.75" />,
  'md-todo': (
    <>
      <rect x="1.75" y="2.25" width="4" height="4" rx=".75" />
      <rect x="1.75" y="9.75" width="4" height="4" rx=".75" />
      <path d="m2.75 4 1 1 2-2M8 4.25h6M8 11.75h6" />
    </>
  ),
  'md-quote': <path d="M3.25 3.25h3.5v3.5l-2.5 4M9.25 3.25h3.5v3.5l-2.5 4" />,
  'md-callout': (
    <>
      <path d="M2.25 2.25h11.5v9H7l-3.75 2.5v-2.5h-1z" />
      <path d="M8 4.5v2.75" />
      <circle cx="8" cy="9" r=".5" fill="currentColor" stroke="none" />
    </>
  ),
  'md-code': <path d="m5.75 3-4 5 4 5m4.5-10 4 5-4 5M9 2.25l-2 11.5" />,
  'md-table': (
    <>
      <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="1" />
      <path d="M1.75 6h12.5M6 2.25v11.5M10 2.25v11.5" />
    </>
  ),
  'md-divider': <path d="M1.75 8h12.5" />,
  'md-image': (
    <>
      <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="1.5" />
      <circle cx="5" cy="5.5" r="1" />
      <path d="m3.25 12 3.25-3.25 2.25 2.25 1.5-1.5 2.5 2.5" />
    </>
  ),
  'md-artifact': (
    <>
      <rect x="2.25" y="4.75" width="9" height="9" rx="1.5" />
      <path d="M8.25 2.25h5.5v5.5M13.75 2.25 7.5 8.5" />
    </>
  ),
  'md-grip': (
    <>
      <circle cx="5.25" cy="3.5" r=".8" fill="currentColor" stroke="none" />
      <circle cx="10.75" cy="3.5" r=".8" fill="currentColor" stroke="none" />
      <circle cx="5.25" cy="8" r=".8" fill="currentColor" stroke="none" />
      <circle cx="10.75" cy="8" r=".8" fill="currentColor" stroke="none" />
      <circle cx="5.25" cy="12.5" r=".8" fill="currentColor" stroke="none" />
      <circle cx="10.75" cy="12.5" r=".8" fill="currentColor" stroke="none" />
    </>
  ),
  'md-duplicate': (
    <>
      <rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.25" />
      <path d="M10.75 5.25v-3h-8.5v8.5h3M9.5 7.5v4M7.5 9.5h4" />
    </>
  ),
  'md-trash': <path d="M2.75 4.25h10.5M5 4.25v-2h6v2M4 4.25l.75 10h6.5l.75-10M6.75 7v4.5m2.5-4.5v4.5" />,
  handoff: (
    <path d="M2.25 9.75h3.25l1 1.75h3l1-1.75h3.25M2.25 9.75v2.75a1.25 1.25 0 0 0 1.25 1.25h9a1.25 1.25 0 0 0 1.25-1.25V9.75M8 2.25V8M5.5 5.5 8 8l2.5-2.5" />
  ),
  'md-link': (
    <path d="m6.5 10.5-1 1a2.5 2.5 0 0 1-3.5-3.5l2.25-2.25a2.5 2.5 0 0 1 3.5 0M9.5 5.5l1-1A2.5 2.5 0 0 1 14 8l-2.25 2.25a2.5 2.5 0 0 1-3.5 0M5.75 10.25l4.5-4.5" />
  ),
  branch: (
    <>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="5" r="1.5" />
      <path d="M4.5 5v6M11.5 6.5c0 3-3.5 2.5-6.25 4.75" />
    </>
  ),
  bell: <path d="M4 11.25V7a4 4 0 0 1 8 0v4.25l1.25 1.5H2.75zM6.5 14.25h3" />,
  keyboard: (
    <>
      <rect x="1.75" y="4" width="12.5" height="8.5" rx="1.5" />
      <path d="M4.5 6.75h.01M7 6.75h.01M9.5 6.75h.01M12 6.75h.01M5.5 9.75h5" />
    </>
  ),
  plug: <path d="M5.75 1.75v3m4.5-3v3M3.75 4.75h8.5v2.5a4.25 4.25 0 0 1-8.5 0zM8 11.5v2.75" />,
  download: <path d="M8 2.25v8M4.75 7 8 10.25 11.25 7M2.75 13.75h10.5" />
} satisfies Record<string, React.JSX.Element>

export type IconName = keyof typeof GLYPHS

export const ICON_NAMES = Object.keys(GLYPHS) as IconName[]

/** One glyph at 14 or 16 px. Hidden from assistive tech unless `label` names it. */
export function Icon({
  name,
  size = 16,
  className,
  label,
  ...data
}: {
  name: IconName
  size?: 14 | 16
  className?: string
  label?: string
} & { [attribute: `data-${string}`]: string }): React.JSX.Element {
  const named = label === undefined ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label }
  return (
    <svg
      {...data}
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
      {...named}
    >
      {label === undefined ? null : <title>{label}</title>}
      {GLYPHS[name]}
    </svg>
  )
}
