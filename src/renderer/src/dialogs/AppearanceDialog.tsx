// Choosing what the window looks like.
//
// The dialog has no Save and no Cancel, and that is the design rather than an
// omission: colour is judged by looking at it, the window behind this panel is
// the preview, and every control here writes through to the stored appearance
// the moment it moves. What would a Cancel restore — the palette from before
// the eleven changes, or from before the last one? "Reset" answers the question
// the honest way, by naming exactly what it puts back.
//
// It is also why nothing here validates. A colour that would make text
// unreadable is not refused, it is lifted off its surface by the derivation in
// `@shared/theme` before it reaches the screen, so the worst a person can do to
// themselves in here is make something ugly. See `theme.test.ts`, which proves
// that by trying.

import { useState } from 'react'
import { opaqueHex, parseColor } from '@shared/color'
import {
  ACCENT_PRESETS,
  BUILT_IN_THEMES,
  isPristine,
  resolvePalette,
  themeById,
  type Appearance,
  type ThemeToken
} from '@shared/theme'
import { useWorkspaceStore } from '../state/workspaceStore'
import { TOKEN_GROUPS } from '../theme/tokenGroups'
import { Modal } from './Modal'

export function AppearanceDialog(): React.JSX.Element {
  const appearance = useWorkspaceStore((state) => state.appearance)
  const setAppearance = useWorkspaceStore((state) => state.setAppearance)
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)
  const [editingColours, setEditingColours] = useState(false)

  const palette = resolvePalette(appearance)
  const preset = themeById(appearance.themeId)
  const edited = !isPristine(appearance)
  // Four of the tokens are translucent so they can land on any surface. A
  // swatch has to be a colour, so they are shown composited over the ground —
  // which is the surface they are most often seen on anyway.
  const ground = parseColor(palette['bg-window']) ?? { r: 0, g: 0, b: 0 }
  const well = (value: string): string => opaqueHex(value, ground) ?? '#000000'

  const change = (next: Partial<Appearance>): void => {
    void setAppearance({ ...appearance, ...next })
  }

  // A preset is a fresh start, not a layer: keeping somebody's per-token edits
  // across a switch would hand them a theme that is neither of the two they
  // have picked, and no way to tell which colours came from where.
  const choose = (themeId: string): void => {
    void setAppearance({ themeId, ground: null, accent: null, overrides: {} })
  }

  return (
    <Modal
      title="Appearance"
      description="Changes land as you make them, and are remembered for the next launch."
      onClose={closeDialog}
    >
      <div className="appearance">
        <fieldset className="appearance__section">
          <legend className="appearance__legend">Theme</legend>
          <div className="appearance__themes" role="radiogroup" aria-label="Theme">
            {BUILT_IN_THEMES.map((theme) => {
              const swatches = resolvePalette({ themeId: theme.id, ground: null, accent: null, overrides: {} })
              const current = theme.id === appearance.themeId
              return (
                <button
                  type="button"
                  key={theme.id}
                  role="radio"
                  aria-checked={current}
                  className={`appearance__theme${current ? ' appearance__theme--current' : ''}`}
                  onClick={() => choose(theme.id)}
                >
                  {/* The preset drawn in its own colours, which says more about
                      it than its name does: ground, a panel above the ground,
                      the text that will sit on both, and the accent. */}
                  <span
                    className="appearance__preview"
                    style={{ background: swatches['bg-window'] }}
                    aria-hidden="true"
                  >
                    <span className="appearance__preview-panel" style={{ background: swatches['bg-panel'] }}>
                      <span className="appearance__preview-line" style={{ background: swatches.fg }} />
                      <span className="appearance__preview-line" style={{ background: swatches['fg-muted'] }} />
                    </span>
                    <span className="appearance__preview-dot" style={{ background: swatches.accent }} />
                  </span>
                  <span className="appearance__theme-name">{theme.name}</span>
                  <span className="appearance__theme-blurb">{theme.blurb}</span>
                </button>
              )
            })}
          </div>
        </fieldset>

        <fieldset className="appearance__section">
          <legend className="appearance__legend">Accent</legend>
          <div className="appearance__accents">
            {ACCENT_PRESETS.map((accent) => {
              const current = (appearance.accent ?? preset.seed.accent).toLowerCase() === accent.value.toLowerCase()
              return (
                <button
                  type="button"
                  key={accent.value}
                  className={`appearance__swatch${current ? ' appearance__swatch--current' : ''}`}
                  style={{ background: accent.value }}
                  title={accent.name}
                  aria-label={accent.name}
                  aria-pressed={current}
                  onClick={() => change({ accent: accent.value })}
                />
              )
            })}
            <ColourWell
              label="Custom accent"
              value={well(palette.accent)}
              onChange={(value) => change({ accent: value })}
            />
          </div>
        </fieldset>

        <fieldset className="appearance__section">
          <legend className="appearance__legend">Ground</legend>
          <div className="appearance__ground">
            <ColourWell
              label="Ground"
              value={well(palette['bg-window'])}
              onChange={(value) => change({ ground: value })}
            />
            <code className="appearance__hex">{palette['bg-window']}</code>
            {appearance.ground === null ? null : (
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={() => change({ ground: null })}
              >
                Back to {preset.name}&rsquo;s
              </button>
            )}
          </div>
        </fieldset>

        <div className="appearance__section">
          <button
            type="button"
            className="appearance__disclosure"
            aria-expanded={editingColours}
            onClick={() => setEditingColours((open) => !open)}
          >
            <svg className={`chevron${editingColours ? ' chevron--open' : ''}`} viewBox="0 0 12 12" aria-hidden="true">
              <path d="M4.5 2.5 L8 6 L4.5 9.5" />
            </svg>
            <span>Every colour</span>
            <span className="appearance__count">
              {Object.keys(appearance.overrides).length > 0
                ? `${Object.keys(appearance.overrides).length} changed`
                : `${TOKEN_GROUPS.reduce((total, group) => total + group.tokens.length, 0)} of them`}
            </span>
          </button>

          {editingColours ? (
            <div className="appearance__tokens">
              {TOKEN_GROUPS.map((group) => (
                <section className="appearance__group" key={group.title}>
                  <h3 className="appearance__group-title">{group.title}</h3>
                  <p className="appearance__note">{group.blurb}</p>
                  <ul className="appearance__rows">
                    {group.tokens.map(({ token, label, about }) => (
                      <li className="appearance__row" key={token}>
                        <ColourWell
                          label={label}
                          value={well(palette[token])}
                          onChange={(value) => change({ overrides: { ...appearance.overrides, [token]: value } })}
                        />
                        <span className="appearance__row-text">
                          <span className="appearance__row-label">{label}</span>
                          <span className="appearance__row-about">{about}</span>
                        </span>
                        {appearance.overrides[token] === undefined ? (
                          <code className="appearance__hex">{palette[token]}</code>
                        ) : (
                          <button
                            type="button"
                            className="button button--ghost button--tiny"
                            onClick={() => change({ overrides: without(appearance.overrides, token) })}
                          >
                            Undo
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          ) : null}
        </div>

        <footer className="form__actions">
          <p className="form__note">{edited ? `${preset.name}, with your changes.` : `${preset.name}, as it ships.`}</p>
          <button
            type="button"
            className="button"
            disabled={!edited}
            onClick={() => choose(appearance.themeId)}
            title={`Put every colour back to ${preset.name}`}
          >
            Reset
          </button>
          <button type="button" className="button button--primary" onClick={closeDialog}>
            Done
          </button>
        </footer>
      </div>
    </Modal>
  )
}

/**
 * A colour, as the platform's own picker.
 *
 * `type="color"` rather than a hex field because this runs on one platform and
 * that platform has a good colour picker with an eyedropper in it. The input is
 * the swatch — no separate preview to keep in step — and the label is there for
 * anybody reading the window rather than looking at it.
 */
function ColourWell({
  label,
  value,
  onChange
}: {
  label: string
  value: string
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <input
      type="color"
      className="appearance__well"
      aria-label={label}
      title={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

/** The same edits without one of them, so "Undo" is a removal rather than a value. */
function without(overrides: Appearance['overrides'], token: ThemeToken): Appearance['overrides'] {
  const rest = { ...overrides }
  delete rest[token]
  return rest
}
