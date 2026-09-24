// Settings › Appearance. No Save or Cancel: every control writes through and the window is the
// preview; Reset names what it restores. Nothing validates, since `@shared/theme` keeps text legible.

import { useState } from 'react'
import { opaqueHex, parseColor } from '@shared/color'
import {
  ACCENT_PRESETS,
  activeChoice,
  APPEARANCE_MODES,
  BUILT_IN_THEMES,
  isPristine,
  resolvePalette,
  resolveTone,
  themeById,
  themeTone,
  withChoice,
  type AppearanceMode,
  type ThemeChoice,
  type ThemeToken
} from '@shared/theme'
import { useWorkspaceStore } from '../state/workspaceStore'
import { TOKEN_GROUPS } from '../theme/tokenGroups'

export function AppearanceSettings(): React.JSX.Element {
  const appearance = useWorkspaceStore((state) => state.appearance)
  const systemTone = useWorkspaceStore((state) => state.systemTone)
  const setAppearance = useWorkspaceStore((state) => state.setAppearance)
  const [editingColours, setEditingColours] = useState(false)

  // Everything below edits the slot on screen, so the window stays the preview.
  const tone = resolveTone(appearance, systemTone)
  const choice = activeChoice(appearance, systemTone)
  const palette = resolvePalette(appearance, systemTone)
  const preset = themeById(choice.themeId)
  const edited = !isPristine(choice)
  const accent = choice.accent ?? preset.seed.accent
  const isPreset = (value: string): boolean => value.toLowerCase() === accent.toLowerCase()
  const customAccent = choice.accent !== null && !ACCENT_PRESETS.some((option) => isPreset(option.value))
  // Translucent tokens are shown composited over the ground, where they are mostly seen.
  const ground = parseColor(palette['bg-window']) ?? { r: 0, g: 0, b: 0 }
  const well = (value: string): string => opaqueHex(value, ground) ?? '#000000'

  const change = (next: Partial<ThemeChoice>): void => {
    void setAppearance(withChoice(appearance, tone, { ...choice, ...next }))
  }

  // A preset is a fresh start: carried-over edits would make a theme that is neither.
  const choose = (themeId: string): void => {
    void setAppearance(withChoice(appearance, tone, { themeId, ground: null, accent: null, overrides: {} }))
  }

  const mode = appearance.mode ?? 'dark'

  return (
    <div className="appearance">
      <div className="appearance__modes" role="radiogroup" aria-label="Mode">
        {APPEARANCE_MODES.map((option) => (
          <button
            type="button"
            key={option}
            role="radio"
            aria-checked={option === mode}
            className={`appearance__mode${option === mode ? ' appearance__mode--current' : ''}`}
            onClick={() => void setAppearance({ ...appearance, mode: option })}
          >
            {APPEARANCE_MODE_LABEL[option]}
          </button>
        ))}
      </div>

      <fieldset className="appearance__section">
        <legend className="appearance__legend">Theme</legend>
        <div className="appearance__themes" role="radiogroup" aria-label="Theme">
          {BUILT_IN_THEMES.filter((theme) => themeTone(theme.id) === tone).map((theme) => {
            const swatches = resolvePalette(
              withChoice({ ...appearance, mode: tone }, tone, {
                themeId: theme.id,
                ground: null,
                accent: null,
                overrides: {}
              })
            )
            const current = theme.id === choice.themeId
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
                <span className="appearance__preview" style={{ background: swatches['bg-window'] }} aria-hidden="true">
                  <span className="appearance__preview-panel" style={{ background: swatches['bg-panel'] }}>
                    <span className="appearance__preview-line" style={{ background: swatches.fg }} />
                    <span className="appearance__preview-line" style={{ background: swatches['fg-muted'] }} />
                  </span>
                  <span className="appearance__preview-dot" style={{ background: swatches.accent }} />
                </span>
                <span className="appearance__theme-name">{theme.name}</span>
              </button>
            )
          })}
        </div>
      </fieldset>

      <fieldset className="appearance__section">
        <legend className="appearance__legend">Accent</legend>
        <div className="appearance__accents">
          {ACCENT_PRESETS.map((option) => {
            const current = isPreset(option.value)
            return (
              <button
                type="button"
                key={option.value}
                className={`appearance__swatch${current ? ' appearance__swatch--current' : ''}`}
                style={{ background: option.value }}
                title={option.name}
                aria-label={option.name}
                aria-pressed={current}
                onClick={() => change({ accent: option.value })}
              />
            )
          })}
          {/* A + until a colour is picked here: drawn in the current accent it read as a second preset. */}
          <span className={`appearance__custom${customAccent ? ' appearance__custom--set' : ''}`}>
            <ColourWell
              label="Custom accent"
              value={well(palette.accent)}
              onChange={(value) => change({ accent: value })}
            />
            {customAccent ? null : (
              <span className="appearance__plus" aria-hidden="true">
                +
              </span>
            )}
          </span>
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
          {choice.ground === null ? null : (
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
            {Object.keys(choice.overrides).length > 0
              ? `${Object.keys(choice.overrides).length} changed`
              : `${TOKEN_GROUPS.reduce((total, group) => total + group.tokens.length, 0)} of them`}
          </span>
        </button>

        {editingColours ? (
          <div className="appearance__tokens">
            {TOKEN_GROUPS.map((group) => (
              <section className="appearance__group" key={group.title}>
                <h3 className="appearance__group-title">{group.title}</h3>
                <ul className="appearance__rows">
                  {group.tokens.map(({ token, label, about }) => (
                    <li className="appearance__row" key={token}>
                      <ColourWell
                        label={label}
                        value={well(palette[token])}
                        onChange={(value) => change({ overrides: { ...choice.overrides, [token]: value } })}
                      />
                      <span className="appearance__row-text">
                        <span className="appearance__row-label">{label}</span>
                        <span className="appearance__row-about">{about}</span>
                      </span>
                      {choice.overrides[token] === undefined ? (
                        <code className="appearance__hex">{palette[token]}</code>
                      ) : (
                        <button
                          type="button"
                          className="button button--ghost button--tiny"
                          onClick={() => change({ overrides: without(choice.overrides, token) })}
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

      <div className="appearance__reset">
        <p className="settings-aside">{edited ? `${preset.name} · edited` : preset.name}</p>
        <button
          type="button"
          className="button button--small"
          disabled={!edited}
          onClick={() => choose(choice.themeId)}
          title={`Put every colour back to ${preset.name}`}
        >
          Reset
        </button>
      </div>
    </div>
  )
}

export const APPEARANCE_MODE_LABEL: Record<AppearanceMode, string> = {
  system: 'Match System',
  light: 'Light',
  dark: 'Dark'
}

/** A colour, as the platform's own picker (it has an eyedropper); the input is the swatch. */
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
function without(overrides: ThemeChoice['overrides'], token: ThemeToken): ThemeChoice['overrides'] {
  const rest = { ...overrides }
  delete rest[token]
  return rest
}
