// The page's glyphs: one per kind of block, and the few its menus need.

export type IconName =
  | 'text'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'bullets'
  | 'numbers'
  | 'todo'
  | 'quote'
  | 'callout'
  | 'code'
  | 'table'
  | 'divider'
  | 'image'
  | 'artifact'
  | 'grip'
  | 'plus'
  | 'duplicate'
  | 'trash'
  | 'link'
  | 'chevron'

const LETTERS: Partial<Record<IconName, string>> = { text: 'Aa', heading1: 'H1', heading2: 'H2', heading3: 'H3' }

const PATHS: Partial<Record<IconName, React.JSX.Element>> = {
  bullets: (
    <>
      <circle cx="3.5" cy="4.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="3.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="3.5" cy="11.5" r="1.1" fill="currentColor" stroke="none" />
      <path d="M6.5 4.5h7M6.5 8h7M6.5 11.5h7" />
    </>
  ),
  numbers: (
    <>
      <path d="M2.6 3.4l1-.6v3.4M2.4 9.4c.3-.5 1.9-.6 1.7.4-.1.6-1.7 1.4-1.8 2h2" />
      <path d="M6.5 4.5h7M6.5 8h7M6.5 11.5h7" />
    </>
  ),
  todo: (
    <>
      <rect x="2" y="3.5" width="4.5" height="4.5" rx="1" />
      <path d="M3 5.8l.9.9 1.6-1.8M8.5 5.75h5M2 11.5h4.5M8.5 11.5h5" />
    </>
  ),
  quote: <path d="M3 3v10M6.5 4.5h7M6.5 8h7M6.5 11.5h4.5" />,
  callout: (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="2.2" />
      <path d="M8 5.2v3.3M8 10.7v.1" />
    </>
  ),
  code: <path d="M5.8 4.2L2.3 8l3.5 3.8M10.2 4.2L13.7 8l-3.5 3.8" />,
  table: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.4" />
      <path d="M2 6.5h12M2 9.8h12M6.5 3v10" />
    </>
  ),
  divider: <path d="M2 8h12" />,
  image: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.4" />
      <circle cx="5.8" cy="6.4" r="1.1" />
      <path d="M2.5 12l3.8-3.6 2.4 2.2 2-1.8 2.8 2.7" />
    </>
  ),
  artifact: <path d="M9 3h4v4M13 3L7.5 8.5M11.5 9.5v3a.9.9 0 01-.9.9H3.9a.9.9 0 01-.9-.9V5.4a.9.9 0 01.9-.9h3" />,
  grip: (
    <>
      {[4.5, 8, 11.5].map((y) => (
        <g key={y}>
          <circle cx="6" cy={y} r="1.05" fill="currentColor" stroke="none" />
          <circle cx="10" cy={y} r="1.05" fill="currentColor" stroke="none" />
        </g>
      ))}
    </>
  ),
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  duplicate: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.4" />
      <path d="M10.5 3.8v-.4a.9.9 0 00-.9-.9H3.4a.9.9 0 00-.9.9v6.2a.9.9 0 00.9.9h.4" />
    </>
  ),
  trash: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.3 4.5l.6 8.1a.9.9 0 00.9.9h4.4a.9.9 0 00.9-.9l.6-8.1" />,
  link: (
    <path d="M7 9a2.6 2.6 0 003.7 0l2-2a2.6 2.6 0 00-3.7-3.7l-.6.6M9 7a2.6 2.6 0 00-3.7 0l-2 2A2.6 2.6 0 007 12.7l.6-.6" />
  ),
  chevron: <path d="M5 6.5L8 9.5l3-3" />
}

export function BlockIcon({ name }: { name: IconName }): React.JSX.Element {
  const letters = LETTERS[name]
  // Drawn by CSS from the attribute, so a row's text is its label alone.
  if (letters !== undefined)
    return <span className="md-glyph md-glyph--letters" data-letters={letters} aria-hidden="true" />
  return (
    <svg
      className="md-glyph"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  )
}
