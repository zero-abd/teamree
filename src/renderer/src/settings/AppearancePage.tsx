// Settings › Appearance: the mode, each theme as a window in miniature in its own colours, the accent, and
// the terminal. Every pick writes through; the colour editor stays in the sheet behind Customize….

import { parseColor } from '@shared/color'
import {
  ACCENT_PRESETS,
  activeChoice,
  APPEARANCE_MODES,
  BUILT_IN_THEMES,
  DEFAULT_LIGHT_THEME_ID,
  DEFAULT_THEME_ID,
  resolvePalette,
  resolveTone,
  themeById,
  themeTone,
  withChoice,
  type Appearance,
  type AppearanceMode,
  type Palette,
  type ThemeToken,
  type Tone
} from '@shared/theme'
import { useWorkspaceStore } from '../state/workspaceStore'
import { Segmented } from '../ui/Segmented'
import { CheckField, Field, Group, hitMark, Marked, useShown } from './fields'

const MODE_LABEL: Record<AppearanceMode, string> = { system: 'System', light: 'Light', dark: 'Dark' }

/** The two themes shown large: the defaults for each tone. */
const FEATURED = [DEFAULT_LIGHT_THEME_ID, DEFAULT_THEME_ID]

/** The tokens a miniature window is drawn from, set on its root so its sheet reads the preset's values. */
const PREVIEW_TOKENS: readonly ThemeToken[] = [
  'bg-window',
  'bg-pane',
  'bg-rail',
  'bg-tabstrip',
  'bg-raised',
  'line',
  'line-strong',
  'fg',
  'fg-muted',
  'accent',
  'accent-bright',
  'accent-soft',
  'warning',
  'success',
  'info'
]

function previewStyle(palette: Palette): React.CSSProperties {
  return Object.fromEntries(PREVIEW_TOKENS.map((token) => [`--${token}`, palette[token]])) as React.CSSProperties
}

/** A theme as it would paint: the slot as edited when it is that slot's theme, else the preset as shipped. */
export function themePreview(appearance: Appearance, themeId: string): Palette {
  const tone = themeTone(themeId)
  const shown = { ...appearance, mode: tone }
  const slot = activeChoice(shown, tone)
  const choice = slot.themeId === themeId ? slot : { themeId, ground: null, accent: null, overrides: {} }
  return resolvePalette(withChoice(shown, tone, choice), tone)
}

/**
 * The accent in effect by its preset's name. A theme's own accent is named after the nearest preset, since a
 * light theme carries a darker tone of it; one picked in the colour editor is Custom.
 */
export function accentName(appearance: Appearance, system: Tone): string {
  const choice = activeChoice(appearance, system)
  const accent = (choice.accent ?? themeById(choice.themeId).seed.accent).toLowerCase()
  const exact = ACCENT_PRESETS.find((preset) => preset.value.toLowerCase() === accent)
  if (exact !== undefined) return exact.name
  if (choice.accent !== null) return 'Custom'
  const from = parseColor(accent)
  const distance = (value: string): number => {
    const to = parseColor(value)
    return from === null || to === null ? Infinity : (from.r - to.r) ** 2 + (from.g - to.g) ** 2 + (from.b - to.b) ** 2
  }
  return [...ACCENT_PRESETS].sort((a, b) => distance(a.value) - distance(b.value))[0]?.name ?? 'Custom'
}

export function ThemeGroup(): React.JSX.Element | null {
  const appearance = useWorkspaceStore((state) => state.appearance)
  const systemTone = useWorkspaceStore((state) => state.systemTone)
  const setAppearance = useWorkspaceStore((state) => state.setAppearance)
  const shown = useShown()
  const tone = resolveTone(appearance, systemTone)
  const mode = appearance.mode ?? 'dark'
  const themes = shown.row('Theme')
  if (!themes && !shown.row('Accent')) return null

  const chosen = (themeId: string): boolean => {
    const own = themeTone(themeId)
    return activeChoice({ ...appearance, mode: own }, own).themeId === themeId
  }
  // A preset is a fresh start for its slot; picking the one already chosen keeps its edits.
  const pick = (themeId: string): void => {
    const own = themeTone(themeId)
    let next = chosen(themeId)
      ? appearance
      : withChoice(appearance, own, { themeId, ground: null, accent: null, overrides: {} })
    if (mode !== 'system' && mode !== own) next = { ...next, mode: own }
    if (next !== appearance) void setAppearance(next)
  }

  const featured = FEATURED.map((id) => themeById(id))
  const presets = BUILT_IN_THEMES.filter((theme) => !FEATURED.includes(theme.id))

  return (
    <Group
      title="Theme"
      aside={
        <span className="settings-mark" {...hitMark(shown, Object.values(MODE_LABEL))}>
          <Segmented
            label="Mode"
            value={mode}
            options={APPEARANCE_MODES.map((option) => ({ value: option, label: MODE_LABEL[option] }))}
            onChange={(next) => void setAppearance({ ...appearance, mode: next })}
          />
        </span>
      }
      className="theme-picker"
    >
      {themes ? (
        <div className="theme-picker__featured">
          {featured.map((theme) => (
            <button
              type="button"
              key={theme.id}
              className="theme-card"
              aria-pressed={chosen(theme.id)}
              data-on-screen={chosen(theme.id) && themeTone(theme.id) === tone ? true : undefined}
              onClick={() => pick(theme.id)}
              {...hitMark(shown, [theme.name])}
            >
              <MiniWindow palette={themePreview(appearance, theme.id)} />
              <span className="theme-card__name">
                <Marked text={theme.name} />
                {chosen(theme.id) && themeTone(theme.id) === tone ? (
                  <span className="theme-card__live" aria-hidden="true" />
                ) : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {themes ? (
        <div className="theme-picker__presets" role="group" aria-label="Presets">
          {presets.map((theme) => (
            <button
              type="button"
              key={theme.id}
              className="theme-preset"
              aria-pressed={chosen(theme.id)}
              onClick={() => pick(theme.id)}
              {...hitMark(shown, [theme.name])}
            >
              <PresetThumb palette={themePreview(appearance, theme.id)} />
              <span className="theme-preset__name">
                <Marked text={theme.name} />
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {shown.row('Accent') ? <AccentRow /> : null}
    </Group>
  )
}

/** How the sidebar draws: New Task and ⋯ on every project head, or only under the pointer. */
export function SidebarGroup(): React.JSX.Element | null {
  const appearance = useWorkspaceStore((state) => state.appearance)
  const setAppearance = useWorkspaceStore((state) => state.setAppearance)
  const shown = useShown()
  if (!shown.row('Project Bar Buttons')) return null
  return (
    <Group title="Sidebar">
      <CheckField
        id="settings-project-buttons"
        label="Project Bar Buttons"
        hint="Show + and ⋯ on project rows"
        checked={appearance.projectButtons !== false}
        onChange={(projectButtons) => void setAppearance({ ...appearance, projectButtons })}
      />
    </Group>
  )
}

/** The window at a glance: sidebar with the active and an asking worktree, a tab strip, two panes, a status bar. */
function MiniWindow({ palette }: { palette: Palette }): React.JSX.Element {
  return (
    <span className="mini-window" style={previewStyle(palette)} data-testid="theme-preview" aria-hidden="true">
      <span className="mini-window__side">
        <i className="mini-window__brand" />
        <i className="mini-window__tree" />
        <i className="mini-window__tree mini-window__tree--active" />
        <i className="mini-window__tree mini-window__tree--asking" />
        <i className="mini-window__tree" />
      </span>
      <span className="mini-window__strip">
        <i className="mini-window__tab mini-window__tab--active" />
        <i className="mini-window__tab" />
      </span>
      <span className="mini-window__panes">
        <span className="mini-window__pane">
          <i className="mini-window__code mini-window__code--info" />
          <i className="mini-window__code" />
          <i className="mini-window__code mini-window__code--success" />
          <i className="mini-window__code" />
        </span>
        <span className="mini-window__pane">
          <i className="mini-window__code mini-window__code--accent" />
          <i className="mini-window__code" />
          <i className="mini-window__code mini-window__code--success" />
        </span>
      </span>
      <span className="mini-window__status" />
    </span>
  )
}

function PresetThumb({ palette }: { palette: Palette }): React.JSX.Element {
  return (
    <span className="preset-thumb" aria-hidden="true">
      <span className="preset-thumb__screen" style={previewStyle(palette)} data-testid="theme-preview">
        <i className="preset-thumb__side" />
        <i className="preset-thumb__body">
          <i className="preset-thumb__line" />
          <i className="preset-thumb__line preset-thumb__line--accent" />
        </i>
      </span>
    </span>
  )
}

/** The accent presets as swatches, and the full colour editor behind Customize…. */
function AccentRow(): React.JSX.Element {
  const appearance = useWorkspaceStore((state) => state.appearance)
  const systemTone = useWorkspaceStore((state) => state.systemTone)
  const setAppearance = useWorkspaceStore((state) => state.setAppearance)
  const showAppearance = useWorkspaceStore((state) => state.showAppearance)
  const shown = useShown()
  const tone = resolveTone(appearance, systemTone)
  const choice = activeChoice(appearance, systemTone)
  const name = accentName(appearance, systemTone)

  return (
    <Field label="Accent" labelId="settings-accent">
      <div className="accent-swatches" role="group" aria-labelledby="settings-accent">
        {ACCENT_PRESETS.map((preset) => (
          <button
            type="button"
            key={preset.value}
            className="accent-swatch"
            style={{ background: preset.value }}
            title={preset.name}
            aria-label={preset.name}
            aria-pressed={preset.name === name}
            onClick={() => void setAppearance(withChoice(appearance, tone, { ...choice, accent: preset.value }))}
            {...hitMark(shown, [preset.name])}
          />
        ))}
      </div>
      <button
        type="button"
        className="button button--small"
        aria-controls="appearance-sheet"
        onClick={() => showAppearance(true)}
      >
        Customize…
      </button>
    </Field>
  )
}
