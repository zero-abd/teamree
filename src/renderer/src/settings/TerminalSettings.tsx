// The terminal's type and cursor beside a live preview; Panes and Appearance show the same block.

import { useState } from 'react'
import { Select } from '../ui/Select'
import {
  TERMINAL_FONT_MAX_PX,
  TERMINAL_FONT_MIN_PX,
  TERMINAL_LINE_HEIGHT_MAX,
  TERMINAL_LINE_HEIGHT_MIN,
  TERMINAL_OPTIONS_DEFAULT,
  type TerminalCursorStyle
} from '../state/preferences'
import { useWorkspaceStore } from '../state/workspaceStore'
import { Segmented } from '../ui/Segmented'
import { Stepper } from '../ui/Stepper'
import { Switch } from '../ui/Switch'
import { Field, Group, hitMark, useDraft, useShown } from './fields'
import { TerminalPreview } from './TerminalPreview'

export const CURSOR_STYLES: readonly { value: TerminalCursorStyle; label: string }[] = [
  { value: 'bar', label: 'Bar' },
  { value: 'block', label: 'Block' },
  { value: 'underline', label: 'Underline' }
]

/** Faces offered by name; each falls back to the system mono where it is not installed. */
const FONTS: readonly string[] = [
  TERMINAL_OPTIONS_DEFAULT.fontFamily,
  'Menlo, monospace',
  'Monaco, monospace',
  '"JetBrains Mono", ui-monospace, monospace',
  '"Fira Code", ui-monospace, monospace',
  '"Cascadia Code", ui-monospace, monospace'
]

const OTHER_FONT = 'other'

/** A font stack by its first face, as the font menu names it. */
export function fontName(stack: string): string {
  const first = (stack.split(',')[0] ?? '').trim().replace(/^['"]|['"]$/g, '')
  if (first === 'ui-monospace' || first === 'SFMono-Regular') return 'SF Mono'
  return first === '' || first === 'monospace' ? 'Monospace' : first
}

/** The rows the terminal block holds, as the filter reads them. */
export const TERMINAL_ROWS = ['Font', 'Terminal text size', 'Line height', 'Cursor'] as const

export function TerminalBlock({ idPrefix }: { idPrefix: string }): React.JSX.Element | null {
  const size = useWorkspaceStore((state) => state.terminalFontSize)
  const setSize = useWorkspaceStore((state) => state.setTerminalFontSize)
  const options = useWorkspaceStore((state) => state.terminalOptions)
  const setOptions = useWorkspaceStore((state) => state.setTerminalOptions)
  const shown = useShown()
  const [typing, setTyping] = useState(false)
  const font = useDraft(options.fontFamily, (value) => {
    setTyping(false)
    setOptions({ fontFamily: value })
  })
  const lineHeight = useDraft(String(options.lineHeight), (value) => {
    const height = Number.parseFloat(value)
    if (Number.isFinite(height)) setOptions({ lineHeight: height })
  })

  if (!TERMINAL_ROWS.some((row) => shown.row(row))) return null
  const other = typing || !FONTS.includes(options.fontFamily)
  const id = (name: string): string => `${idPrefix}-${name}`

  return (
    <Group title="Terminal" aside={<span className="settings-card__summary">Live preview</span>} className="term-block">
      <div className="term-block__controls">
        {shown.row('Font') ? (
          <Field label="Font" htmlFor={id('font')}>
            <div className="settings-stack">
              <Select
                id={id('font')}
                value={other ? OTHER_FONT : options.fontFamily}
                onChange={(event) => {
                  const value = event.target.value
                  setTyping(value === OTHER_FONT)
                  if (value !== OTHER_FONT) setOptions({ fontFamily: value })
                }}
                {...hitMark(shown, [...FONTS.map(fontName), options.fontFamily])}
              >
                {FONTS.map((stack) => (
                  <option key={stack} value={stack}>
                    {fontName(stack)}
                  </option>
                ))}
                <option value={OTHER_FONT}>Other…</option>
              </Select>
              {other ? (
                <input
                  className="settings-input"
                  type="text"
                  aria-label="Font family"
                  placeholder="Iosevka, monospace"
                  autoFocus={typing}
                  {...font}
                />
              ) : null}
            </div>
          </Field>
        ) : null}

        {shown.row('Terminal text size') ? (
          <Field label="Terminal text size">
            <span className="settings-mark" {...hitMark(shown, [`${size}px`])}>
              <Stepper
                label="Terminal text size"
                value={size}
                min={TERMINAL_FONT_MIN_PX}
                max={TERMINAL_FONT_MAX_PX}
                onChange={setSize}
              />
            </span>
          </Field>
        ) : null}

        {shown.row('Line height') ? (
          <Field label="Line height" htmlFor={id('line-height')}>
            <input
              id={id('line-height')}
              className="settings-input settings-input--number"
              type="number"
              min={TERMINAL_LINE_HEIGHT_MIN}
              max={TERMINAL_LINE_HEIGHT_MAX}
              step={0.05}
              {...lineHeight}
              {...hitMark(shown, [String(options.lineHeight)])}
            />
          </Field>
        ) : null}

        {shown.row('Cursor') ? (
          <>
            <Field label="Cursor">
              <span
                className="settings-mark"
                {...hitMark(
                  shown,
                  CURSOR_STYLES.map((style) => style.label)
                )}
              >
                <Segmented
                  label="Cursor"
                  value={options.cursorStyle}
                  options={CURSOR_STYLES}
                  onChange={(cursorStyle) => setOptions({ cursorStyle })}
                />
              </span>
            </Field>
            <Field label="Blink" htmlFor={id('cursor-blink')}>
              <Switch
                id={id('cursor-blink')}
                checked={options.cursorBlink}
                onChange={(cursorBlink) => setOptions({ cursorBlink })}
              />
            </Field>
          </>
        ) : null}
      </div>
      <div className="term-block__stage">
        {/* The draft, not the stored value: the point is to see a face before keeping it. */}
        <TerminalPreview
          fontFamily={other && font.value.trim() !== '' ? font.value : options.fontFamily}
          fontSize={size}
          lineHeight={options.lineHeight}
          cursorStyle={options.cursorStyle}
          cursorBlink={options.cursorBlink}
        />
      </div>
    </Group>
  )
}
