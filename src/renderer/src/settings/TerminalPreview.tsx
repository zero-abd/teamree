// A pane in miniature, drawn in the terminal's own colours with the font, size, line height and cursor set here.

import type { TerminalCursorStyle } from '../state/preferences'

const ANSI = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'bright-black',
  'bright-red',
  'bright-green',
  'bright-yellow',
  'bright-blue',
  'bright-magenta',
  'bright-cyan',
  'bright-white'
] as const

export function TerminalPreview({
  fontFamily,
  fontSize,
  lineHeight,
  cursorStyle,
  cursorBlink
}: {
  fontFamily: string
  fontSize: number
  lineHeight: number
  cursorStyle: TerminalCursorStyle
  cursorBlink: boolean
}): React.JSX.Element {
  return (
    <div className="term-preview" data-testid="terminal-preview" aria-hidden="true">
      <div className="term-preview__screen" style={{ fontFamily, fontSize, lineHeight }}>
        <div className="term-preview__dim">~/shop/session-migration</div>
        <div>$ git status --short</div>
        <div className="term-preview__yellow"> M src/session/store.ts</div>
        <div className="term-preview__blue">@@ -18,3 +18,5 @@ restoreSession</div>
        <div className="term-preview__green">+ const next = migrate(record)</div>
        <div className="term-preview__green">✓ 22 tests passed</div>
        <div>
          ${' '}
          <span
            className={`term-preview__cursor term-preview__cursor--${cursorStyle}`}
            data-blink={cursorBlink ? true : undefined}
          >
            {' '}
          </span>
        </div>
      </div>
      <div className="term-preview__ansi">
        {ANSI.map((name) => (
          <span key={name} style={{ background: `var(--term-${name})` }} />
        ))}
      </div>
    </div>
  )
}
