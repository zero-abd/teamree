// The settings page: machine-level facts (PATH, updates, text size, checkouts), so it takes the main
// area rather than a drawer. Colours and relays are read here and set where they already live.

import { createContext, Fragment, useContext, useEffect, useRef, useState } from 'react'
import { agentLaunchCommand } from '@shared/agentLaunch'
import type { Project } from '@shared/entities'
import { AgentGlyph } from '../agents/glyphs'
import { harnessName } from '../agents/harnesses'
import { cliOutcome } from '../dialogs/cliInstallModel'
import { Select } from '../dialogs/Select'
import {
  NO_DEFAULT_AGENT,
  TERMINAL_FONT_MAX_PX,
  TERMINAL_FONT_MIN_PX,
  TERMINAL_SCROLLBACK_MAX,
  TERMINAL_SCROLLBACK_MIN,
  type AgentNoticePreference,
  type TerminalCursorStyle
} from '../state/preferences'
import { useNow } from '../state/useNow'
import { useWorkspaceStore } from '../state/workspaceStore'
import { InstallerButton } from '../updates/InstallerButton'
import { installerStep } from '../updates/updateNotice'
import { PageFrame } from '../workspace/PageFrame'
import { activeChoice, BUILT_IN_THEMES, themeById } from '@shared/theme'
import { APPEARANCE_MODE_LABEL } from './AppearanceSettings'
import {
  agentRows,
  cliLine,
  labelMatches,
  relayPanel,
  rowMatches,
  SETTINGS_SECTIONS,
  updatePanel,
  type AgentRow,
  type SettingsRow,
  type SettingsSectionId as SectionId
} from './settingsModel'

/** Which rows the filter keeps: all of them under a section (or project) whose own name matched. */
type Shown = {
  whole: boolean
  query: string
  row: (label: string) => boolean
  /** True when the filter is in one of these values or options, so the control holding them is marked. */
  hit: (words: readonly string[]) => boolean
}

const ShownContext = createContext<Shown>({ whole: true, query: '', row: () => true, hit: () => false })

function useShown(): Shown {
  return useContext(ShownContext)
}

function shownUnder(title: string, query: string, rows: readonly SettingsRow[]): Shown {
  const whole = labelMatches(title, query)
  return {
    whole,
    query,
    row: (label) => whole || rows.some((row) => row.label === label && rowMatches(row, query)),
    hit: (words) => query.trim() !== '' && words.some((word) => word !== '' && labelMatches(word, query))
  }
}

/** The text, with the filter's words marked where they occur. */
function Marked({ text }: { text: string }): React.JSX.Element {
  const wanted = useShown().query.trim().toLowerCase()
  const at = wanted === '' ? -1 : text.toLowerCase().indexOf(wanted)
  if (at < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, at)}
      <mark className="settings-match">{text.slice(at, at + wanted.length)}</mark>
      {text.slice(at + wanted.length)}
    </>
  )
}

/** For a control: the attribute that marks it when the filter matched one of its values. */
function hitMark(shown: Shown, words: readonly string[]): { 'data-match'?: true } {
  return shown.hit(words) ? { 'data-match': true } : {}
}

const CURSOR_STYLES: readonly { value: TerminalCursorStyle; label: string }[] = [
  { value: 'bar', label: 'Bar' },
  { value: 'block', label: 'Block' },
  { value: 'underline', label: 'Underline' }
]

const NOTICE_CHOICES: readonly { value: AgentNoticePreference; label: string }[] = [
  { value: 'off', label: 'Nothing' },
  { value: 'notify', label: 'Notify' },
  { value: 'sound', label: 'Notify with sound' }
]

/** Every theme and mode by name: the options behind the Theme row's Change… button. */
const THEME_WORDS = [...BUILT_IN_THEMES.map((theme) => theme.name), ...Object.values(APPEARANCE_MODE_LABEL)]

function useAgentRows(): AgentRow[] {
  const agents = useWorkspaceStore((state) => state.agents)
  const agentArgs = useWorkspaceStore((state) => state.agentArgs)
  const defaultAgent = useWorkspaceStore((state) => state.defaultAgent)
  const probed = useWorkspaceStore((state) => state.agentsProbed)
  return agentRows(agents, agentArgs, defaultAgent, probed)
}

function useThemeValue(): string {
  const appearance = useWorkspaceStore((state) => state.appearance)
  const systemTone = useWorkspaceStore((state) => state.systemTone)
  const theme = themeById(activeChoice(appearance, systemTone).themeId).name
  return `${theme} · ${APPEARANCE_MODE_LABEL[appearance.mode ?? 'dark']}`
}

/** The editors the picker offers, and its first option's label. */
function editorChoices(found: readonly { command: string; label: string; kind?: string }[] | null): {
  editors: readonly { command: string; label: string }[]
  firstFound: string
} {
  const editors = (found ?? []).filter((editor) => (editor.kind ?? 'editor') === 'editor')
  return { editors, firstFound: editors[0] === undefined ? 'First found' : `First found (${editors[0].label})` }
}

/** A project's rows as the filter reads them, from the same values its controls show. */
function useProjectRows(): (project: Project) => SettingsRow[] {
  const startPoints = useWorkspaceStore((state) => state.startPointDefaults)
  const editorCommands = useWorkspaceStore((state) => state.editorCommands)
  const found = useWorkspaceStore((state) => state.editors)
  const relays = useWorkspaceStore((state) => state.relays)
  const { editors, firstFound } = editorChoices(found)
  return (project) => {
    const editor = editorCommands[project.id] ?? ''
    // A program typed in under Other… is on screen; a picked editor's command is not.
    const typed = editors.some((option) => option.command === editor) ? '' : editor
    return [
      { label: 'Start new worktrees from', words: [startPoints[project.id] || project.baseRef] },
      { label: 'Fetch in Background', words: [] },
      { label: 'Symlink into every new worktree', words: project.linkedPaths ?? [] },
      { label: 'Copy into every new worktree', words: project.copiedPaths ?? [] },
      { label: 'Setup command', words: [project.setupCommand ?? ''] },
      {
        label: 'Open checkouts in',
        words: [firstFound, ...editors.map((option) => option.label), 'Other…', typed]
      },
      { label: 'Relay', words: [relayPanel(relays[project.id]).headline] }
    ]
  }
}

/** Every row outside a project as the filter reads it: label, option labels and current value. */
function useSectionRows(): Record<Exclude<SectionId, 'projects'>, SettingsRow[]> {
  const agentArgs = useWorkspaceStore((state) => state.agentArgs)
  const fontSize = useWorkspaceStore((state) => state.terminalFontSize)
  const options = useWorkspaceStore((state) => state.terminalOptions)
  const agents = useAgentRows()
  const themeValue = useThemeValue()
  return {
    agents: [
      {
        label: 'Default agent',
        words: ['First found', ...agents.filter((row) => row.command !== null).map((row) => harnessName(row.kind))]
      },
      ...agents.map((row) => ({ label: harnessName(row.kind), words: [agentArgs[row.kind] ?? ''] }))
    ],
    panes: [
      { label: 'Terminal text size', words: [`${fontSize}px`] },
      { label: 'Font', words: [options.fontFamily] },
      { label: 'Cursor', words: [...CURSOR_STYLES.map((style) => style.label), 'Blink'] },
      { label: 'Option as Meta', words: [] },
      { label: 'Copy on select', words: [] },
      { label: 'Scrollback lines', words: [String(options.scrollback)] }
    ],
    notices: [{ label: 'When an agent stops', words: NOTICE_CHOICES.map((choice) => choice.label) }],
    appearance: [{ label: 'Theme', words: [themeValue, ...THEME_WORDS] }],
    updates: [{ label: 'Check automatically', words: [] }],
    cli: []
  }
}

/** A heading this close to the top of the scrolling body counts as the section in view. */
const IN_VIEW_PX = 48

export function SettingsView(): React.JSX.Element {
  const projects = useWorkspaceStore((state) => state.projects)
  const toggleSettings = useWorkspaceStore((state) => state.toggleSettings)
  const loadCli = useWorkspaceStore((state) => state.loadCli)
  const loadUpdate = useWorkspaceStore((state) => state.loadUpdate)
  const agents = useAgentRows()
  const [query, setQuery] = useState('')
  const sectionRows = useSectionRows()
  const projectRows = useProjectRows()
  const rowsOf = (id: SectionId): SettingsRow[] =>
    id === 'projects'
      ? projects.flatMap((project) => [{ label: project.name, words: [] }, ...projectRows(project)])
      : sectionRows[id]
  const sections = SETTINGS_SECTIONS.filter((entry) => entry.id !== 'agents' || agents.length > 0).filter(
    (entry) => labelMatches(entry.label, query) || rowsOf(entry.id).some((row) => rowMatches(row, query))
  )

  // Read again on open: both are facts about the world outside this window that may have moved.
  useEffect(() => {
    void loadCli()
    void loadUpdate()
  }, [loadCli, loadUpdate])

  const body = useRef<HTMLDivElement>(null)
  const [current, setActive] = useState<SectionId | null>(null)
  const active = sections.some((entry) => entry.id === current) ? current : (sections[0]?.id ?? null)
  // A section picked near the end cannot scroll to the top, so it stays current at the bottom.
  const picked = useRef<SectionId | null>(null)

  const goTo = (id: SectionId): void => {
    const heading = document.getElementById(`settings-${id}`)
    if (heading === null) return
    heading.scrollIntoView({ block: 'start' })
    heading.focus({ preventScroll: true })
    picked.current = id
    setActive(id)
  }

  const ids = sections.map((entry) => entry.id).join(' ')
  useEffect(() => {
    const scroller = body.current
    if (scroller === null) return
    const order = ids.split(' ') as SectionId[]
    const onScroll = (): void => {
      if (!atBottom(scroller)) picked.current = null
      setActive(sectionInView(scroller, order, picked.current))
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [ids])

  // Opened at a section — the strip's "Agent settings…" — the page scrolls
  // there once and forgets the request, so the next plain open starts at the top.
  const section = useWorkspaceStore((state) => state.settingsSection)
  useEffect(() => {
    if (section === null) return
    goTo(section)
    useWorkspaceStore.setState({ settingsSection: null })
  }, [section])

  return (
    <PageFrame label="Settings" title="Settings" onClose={toggleSettings} bodyRef={body} bodyTestId="settings-body">
      <div className="settings__layout">
        <div className="settings__side">
          <input
            type="search"
            className="settings-filter"
            aria-label="Filter settings"
            placeholder="Filter"
            value={query}
            autoComplete="off"
            spellCheck={false}
            data-own-escape={query === '' ? undefined : true}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setQuery('')
            }}
          />
          <SectionList sections={sections} active={active} goTo={goTo} />
        </div>
        <div className="settings__content">
          {sections.length === 0 ? <p className="settings-note">No matches</p> : null}
          {sections.map((entry) => (
            <ShownContext.Provider key={entry.id} value={shownUnder(entry.label, query, rowsOf(entry.id))}>
              <SectionBody id={entry.id} projects={projects} />
            </ShownContext.Provider>
          ))}
        </div>
      </div>
    </PageFrame>
  )
}

function SectionBody({ id, projects }: { id: SectionId; projects: readonly Project[] }): React.JSX.Element | null {
  switch (id) {
    case 'agents':
      return <AgentsSection />
    case 'projects':
      return <ProjectsSection projects={projects} />
    case 'panes':
      return <PanesSection />
    case 'notices':
      return <NoticesSection />
    case 'appearance':
      return <AppearanceSection />
    case 'updates':
      return <UpdatesSection />
    case 'cli':
      return <CliSection />
  }
}

function atBottom(scroller: HTMLElement): boolean {
  return scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1
}

/** The last section whose heading has reached the top; at the bottom, the one picked or the last. */
function sectionInView(scroller: HTMLElement, order: readonly SectionId[], picked: SectionId | null): SectionId {
  const top = scroller.getBoundingClientRect().top
  const offset = (id: SectionId): number | null => {
    const heading = document.getElementById(`settings-${id}`)
    return heading === null ? null : heading.getBoundingClientRect().top - top
  }
  if (atBottom(scroller)) {
    const at = picked === null ? null : offset(picked)
    return picked !== null && at !== null && at >= 0 ? picked : (order.at(-1) ?? 'agents')
  }
  let current: SectionId = order[0] ?? 'agents'
  for (const id of order) {
    const at = offset(id)
    if (at !== null && at <= IN_VIEW_PX) current = id
  }
  return current
}

function SectionList({
  sections,
  active,
  goTo
}: {
  sections: readonly { id: SectionId; label: string }[]
  active: SectionId | null
  goTo: (id: SectionId) => void
}): React.JSX.Element {
  const onKeyDown = (event: React.KeyboardEvent<HTMLUListElement>): void => {
    const buttons = [...event.currentTarget.querySelectorAll('button')]
    const at = buttons.indexOf(event.target as HTMLButtonElement)
    const next =
      event.key === 'ArrowDown'
        ? Math.min(at + 1, buttons.length - 1)
        : event.key === 'ArrowUp'
          ? Math.max(at - 1, 0)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : null
    if (next === null || at < 0) return
    event.preventDefault()
    buttons[next]?.focus()
  }

  return (
    <nav className="settings-nav" aria-label="Sections">
      <ul className="settings-nav__list" onKeyDown={onKeyDown}>
        {sections.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              className="settings-nav__item"
              aria-current={entry.id === active ? 'true' : undefined}
              onClick={() => goTo(entry.id)}
            >
              {entry.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}

/** The `teamree` command and whether a terminal can find it; the judgement is `cliInstallModel`'s. */
function CliSection(): React.JSX.Element {
  const status = useWorkspaceStore((state) => state.cli)
  const pending = useWorkspaceStore((state) => state.cliPending)
  const install = useWorkspaceStore((state) => state.cliInstall)
  const error = useWorkspaceStore((state) => state.cliError)
  const installCli = useWorkspaceStore((state) => state.installCli)

  const line = cliLine(status)

  return (
    <section className="settings-section" aria-labelledby="settings-cli">
      <h2 className="settings-section__title" id="settings-cli" tabIndex={-1}>
        <Marked text="CLI" />
      </h2>
      <div className="settings-group">
        <div className="settings-row">
          <p className="settings-fact settings-fact--mono">
            <BreakAtSlashes text={line.state} />
          </p>
          {line.action ? (
            <button
              type="button"
              className="button button--small"
              disabled={pending}
              title={line.title ?? undefined}
              onClick={() => void installCli()}
            >
              {pending ? 'Linking…' : line.action}
            </button>
          ) : null}
        </div>

        {line.manual ? (
          <pre className="settings-command">
            <code>{line.manual}</code>
          </pre>
        ) : null}

        {/* Beside the button that caused it: that is where the retry happens. */}
        {error ? <p className="settings-error">{error}</p> : null}
        {install && error === null ? <p className="settings-done">{cliOutcome(install)}</p> : null}
      </div>
    </section>
  )
}

/** Whether teamree goes looking for a newer release, and what it found last time. */
function UpdatesSection(): React.JSX.Element {
  const update = useWorkspaceStore((state) => state.update)
  const checkForUpdates = useWorkspaceStore((state) => state.checkForUpdates)
  const setAutomaticUpdates = useWorkspaceStore((state) => state.setAutomaticUpdates)

  // "Last checked" changes while nothing happens, so the page re-renders itself.
  const now = useNow()
  const panel = updatePanel(update, now)
  const step = installerStep(update)
  const shown = useShown()

  return (
    <section className="settings-section" aria-labelledby="settings-updates">
      <h2 className="settings-section__title" id="settings-updates" tabIndex={-1}>
        <Marked text="Updates" />
      </h2>
      <div className="settings-group">
        {shown.whole ? (
          <div className="settings-row">
            <p className="settings-fact">{panel.headline}</p>
            {panel.offersCheck ? (
              <div className="settings-actions">
                {panel.lastChecked ? <span className="settings-aside">{panel.lastChecked}</span> : null}
                <button
                  type="button"
                  className="button button--small"
                  disabled={update?.checking ?? false}
                  onClick={() => void checkForUpdates()}
                >
                  {update?.checking ? 'Checking…' : 'Check for Updates'}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {shown.whole && step !== null && update?.available ? (
          <div className="settings-row">
            <p className="settings-fact">teamree {update.available.version} available</p>
            <InstallerButton step={step} className="button button--small" />
          </div>
        ) : null}
        {shown.whole && step?.problem ? <p className="settings-error">{step.problem}</p> : null}

        {panel.offersCheck && shown.row('Check automatically') ? (
          <label className="settings-check">
            <input
              type="checkbox"
              checked={update?.automatic ?? false}
              onChange={(event) => void setAutomaticUpdates(event.target.checked)}
            />
            {/* Half a minute after startup, then every six hours; a label is not the place for a schedule. */}
            <span>
              <Marked text="Check automatically" />
            </span>
          </label>
        ) : null}

        {/* Kept beside the button that tried rather than raised as a notice. */}
        {shown.whole && panel.problem ? <p className="settings-warning">{panel.problem}</p> : null}
      </div>
    </section>
  )
}

/** What an agent that has stopped may do when you are not looking at the window. */
function NoticesSection(): React.JSX.Element {
  const agentNotices = useWorkspaceStore((state) => state.agentNotices)
  const setAgentNotices = useWorkspaceStore((state) => state.setAgentNotices)
  const shown = useShown()

  return (
    <section className="settings-section" aria-labelledby="settings-notices">
      <h2 className="settings-section__title" id="settings-notices" tabIndex={-1}>
        <Marked text="Notifications" />
      </h2>
      <div className="settings-group">
        <div className="settings-field">
          <label className="settings-field__label" htmlFor="settings-agent-notices">
            <Marked text="When an agent stops" />
          </label>
          <Select
            id="settings-agent-notices"
            value={agentNotices}
            onChange={(event) => setAgentNotices(event.target.value as AgentNoticePreference)}
            {...hitMark(
              shown,
              NOTICE_CHOICES.map((choice) => choice.label)
            )}
          >
            {NOTICE_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </Select>
        </div>
      </div>
    </section>
  )
}

/** How every pane draws and reads keys. */
function PanesSection(): React.JSX.Element {
  const terminalFontSize = useWorkspaceStore((state) => state.terminalFontSize)
  const setTerminalFontSize = useWorkspaceStore((state) => state.setTerminalFontSize)
  const options = useWorkspaceStore((state) => state.terminalOptions)
  const setOptions = useWorkspaceStore((state) => state.setTerminalOptions)
  const font = useDraft(options.fontFamily, (value) => setOptions({ fontFamily: value }))
  const scrollback = useDraft(String(options.scrollback), (value) => {
    const lines = Number.parseInt(value, 10)
    if (Number.isFinite(lines)) setOptions({ scrollback: lines })
  })
  const shown = useShown()

  return (
    <section className="settings-section" aria-labelledby="settings-panes">
      <h2 className="settings-section__title" id="settings-panes" tabIndex={-1}>
        <Marked text="Panes" />
      </h2>
      <div className="settings-group">
        {shown.row('Terminal text size') ? (
          <div className="settings-field">
            <label className="settings-field__label" htmlFor="settings-font-size">
              <Marked text="Terminal text size" />
            </label>
            <div className="settings-size">
              <input
                id="settings-font-size"
                className="settings-size__range"
                type="range"
                min={TERMINAL_FONT_MIN_PX}
                max={TERMINAL_FONT_MAX_PX}
                step={1}
                value={terminalFontSize}
                onChange={(event) => setTerminalFontSize(Number(event.target.value))}
              />
              {/* A slider with no scale cannot say how big it is now. */}
              <output className="settings-size__value" htmlFor="settings-font-size">
                <Marked text={`${terminalFontSize}px`} />
              </output>
            </div>
          </div>
        ) : null}

        {shown.row('Font') ? (
          <div className="settings-field">
            <label className="settings-field__label" htmlFor="settings-font">
              <Marked text="Font" />
            </label>
            <input
              id="settings-font"
              className="settings-field__input"
              type="text"
              {...font}
              {...hitMark(shown, [options.fontFamily])}
            />
            {/* The draft, not the stored value: the point is to see a face before keeping it. */}
            <div
              className="settings-font-preview"
              data-testid="settings-font-preview"
              style={{ fontFamily: font.value, fontSize: terminalFontSize }}
            >
              ~/repo $ git status 0O 1lI {'{}'} =&gt; !=
            </div>
          </div>
        ) : null}

        {shown.row('Cursor') ? (
          <div className="settings-field">
            <label className="settings-field__label" htmlFor="settings-cursor">
              <Marked text="Cursor" />
            </label>
            <div className="settings-field__row">
              <Select
                id="settings-cursor"
                value={options.cursorStyle}
                onChange={(event) => setOptions({ cursorStyle: event.target.value as TerminalCursorStyle })}
                {...hitMark(
                  shown,
                  CURSOR_STYLES.map((style) => style.label)
                )}
              >
                {CURSOR_STYLES.map((style) => (
                  <option key={style.value} value={style.value}>
                    {style.label}
                  </option>
                ))}
              </Select>
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={options.cursorBlink}
                  onChange={(event) => setOptions({ cursorBlink: event.target.checked })}
                />
                <span>
                  <Marked text="Blink" />
                </span>
              </label>
            </div>
          </div>
        ) : null}

        {shown.row('Option as Meta') ? (
          <div className="settings-field">
            <label className="settings-field__label" htmlFor="settings-option-meta">
              <Marked text="Option as Meta" />
            </label>
            <input
              id="settings-option-meta"
              className="settings-field__check"
              type="checkbox"
              checked={options.optionIsMeta}
              onChange={(event) => setOptions({ optionIsMeta: event.target.checked })}
            />
          </div>
        ) : null}

        {shown.row('Copy on select') ? (
          <div className="settings-field">
            <label className="settings-field__label" htmlFor="settings-copy-on-select">
              <Marked text="Copy on select" />
            </label>
            <input
              id="settings-copy-on-select"
              className="settings-field__check"
              type="checkbox"
              checked={options.copyOnSelect}
              onChange={(event) => setOptions({ copyOnSelect: event.target.checked })}
            />
          </div>
        ) : null}

        {shown.row('Scrollback lines') ? (
          <div className="settings-field">
            <label className="settings-field__label" htmlFor="settings-scrollback">
              <Marked text="Scrollback lines" />
            </label>
            <input
              id="settings-scrollback"
              className="settings-field__input settings-field__input--number"
              type="number"
              min={TERMINAL_SCROLLBACK_MIN}
              max={TERMINAL_SCROLLBACK_MAX}
              step={1000}
              {...scrollback}
              {...hitMark(shown, [String(options.scrollback)])}
            />
          </div>
        ) : null}
      </div>
    </section>
  )
}

/** A text field that keeps its value on blur or Enter, and takes the stored spelling back whenever that moves. */
function useDraft(
  stored: string,
  commit: (value: string) => void
): Pick<
  React.InputHTMLAttributes<HTMLInputElement>,
  'onChange' | 'onBlur' | 'onKeyDown' | 'autoComplete' | 'spellCheck'
> & {
  value: string
} {
  const [draft, setDraft] = useState(stored)
  useEffect(() => {
    setDraft(stored)
  }, [stored])
  // Reset first: a value the store clamps back to what it held changes nothing the effect can see.
  const keep = (): void => {
    const next = draft.trim()
    setDraft(stored)
    if (next !== stored) commit(next)
  }
  return {
    value: draft,
    autoComplete: 'off',
    spellCheck: false,
    onChange: (event) => setDraft(event.target.value),
    onBlur: keep,
    onKeyDown: (event) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      keep()
    }
  }
}

/**
 * Which agent you always use and what you pass it; per machine, shown once the probe found one.
 * Nothing is seeded: no autonomy flag is pre-applied by default.
 */
function AgentsSection(): React.JSX.Element | null {
  const rows = useAgentRows()
  const agents = rows.filter((row) => row.command !== null)
  const defaultAgent = useWorkspaceStore((state) => state.defaultAgent)
  const setDefaultAgent = useWorkspaceStore((state) => state.setDefaultAgent)
  const shown = useShown()

  if (rows.length === 0) return null
  const choices = ['First found', ...agents.map((agent) => harnessName(agent.kind))]

  return (
    <section className="settings-section" aria-labelledby="settings-agents">
      <h2 className="settings-section__title" id="settings-agents" tabIndex={-1}>
        <Marked text="Agents" />
      </h2>
      <div className="settings-group">
        {shown.row('Default agent') ? (
          <div className="settings-field">
            <label className="settings-field__label" htmlFor="settings-default-agent">
              <Marked text="Default agent" />
            </label>
            <Select
              id="settings-default-agent"
              value={defaultAgent}
              onChange={(event) => setDefaultAgent(event.target.value)}
              {...hitMark(shown, choices)}
            >
              {/* No preference is the rule that predates the preference, named after what it does. */}
              <option value={NO_DEFAULT_AGENT}>First found</option>
              {agents.map((agent) => (
                <option key={agent.kind} value={agent.kind}>
                  {harnessName(agent.kind)}
                </option>
              ))}
            </Select>
          </div>
        ) : null}

        {rows
          .filter((row) => shown.row(harnessName(row.kind)))
          .map((row) => (
            <AgentArguments key={row.kind} agent={row} />
          ))}
      </div>
    </section>
  )
}

/**
 * One agent's launch arguments: empty, the field shows the bare command; given some, the line
 * `@shared/agentLaunch` builds sits underneath. The runtime's session selector is left out.
 */
function AgentArguments({ agent }: { agent: AgentRow }): React.JSX.Element {
  const shown = useShown()
  const stored = useWorkspaceStore((state) => state.agentArgs[agent.kind] ?? '')
  const setAgentArgs = useWorkspaceStore((state) => state.setAgentArgs)
  const [draft, setDraft] = useState(stored)

  // The stored value moving puts the trimmed spelling back, including when changed from elsewhere.
  useEffect(() => {
    setDraft(stored)
  }, [stored])

  const commit = (): void => {
    const next = draft.trim()
    if (next === stored) return
    setAgentArgs(agent.kind, next.length === 0 ? null : next)
  }

  const id = `settings-agent-args-${agent.kind}`

  return (
    <div className="settings-field">
      <label className="settings-field__label settings-agent" htmlFor={id}>
        <AgentGlyph kind={agent.kind} decorative />
        <Marked text={harnessName(agent.kind)} />
      </label>
      <input
        id={id}
        className="settings-field__input settings-field__input--command"
        type="text"
        value={draft}
        placeholder={agent.command ?? ''}
        title="Extra arguments"
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          }
        }}
        {...hitMark(shown, [stored])}
      />
      {agent.command === null ? (
        <p className="settings-launch settings-launch--missing">Not found</p>
      ) : draft.trim() === '' ? null : (
        <code className="settings-launch">
          <Marked text={agentLaunchCommand(agent.command, draft)} />
        </code>
      )}
    </div>
  )
}

/** The theme in effect; changing it happens in the sheet beside the panes, where it can be seen. */
function AppearanceSection(): React.JSX.Element {
  const showAppearance = useWorkspaceStore((state) => state.showAppearance)
  const value = useThemeValue()
  const shown = useShown()

  return (
    <section className="settings-section" aria-labelledby="settings-appearance">
      <h2 className="settings-section__title" id="settings-appearance" tabIndex={-1}>
        <Marked text="Appearance" />
      </h2>
      <div className="settings-group">
        <div className="settings-field">
          <span className="settings-field__label">
            <Marked text="Theme" />
          </span>
          <div className="settings-field__row">
            <p className="settings-value">
              <Marked text={value} />
            </p>
            <button
              type="button"
              className="button button--small"
              onClick={() => showAppearance(true)}
              {...hitMark(shown, THEME_WORDS)}
            >
              Change…
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}

function ProjectsSection({ projects }: { projects: readonly Project[] }): React.JSX.Element {
  const shown = useShown()
  const projectRows = useProjectRows()
  const named = (project: Project): Shown => {
    const own = shownUnder(project.name, shown.query, projectRows(project))
    return shown.whole ? { ...own, whole: true, row: () => true } : own
  }
  return (
    <section className="settings-section" aria-labelledby="settings-projects">
      <h2 className="settings-section__title" id="settings-projects" tabIndex={-1}>
        <Marked text="Projects" />
      </h2>
      {projects.length === 0 ? (
        <div className="settings-group">
          <p className="settings-note">No repositories yet</p>
        </div>
      ) : (
        projects
          .filter((project) => named(project).whole || projectRows(project).some((row) => rowMatches(row, shown.query)))
          .map((project) => (
            <ShownContext.Provider key={project.id} value={named(project)}>
              <ProjectBlock project={project} />
            </ShownContext.Provider>
          ))
      )}
    </section>
  )
}

function ProjectBlock({ project }: { project: Project }): React.JSX.Element {
  const revealInFinder = useWorkspaceStore((state) => state.revealInFinder)
  const shown = useShown()

  return (
    <article className="settings-group settings-project">
      <div className="settings-row">
        <div className="settings-project__identity">
          <h3 className="settings-project__name">
            <Marked text={project.name} />
          </h3>
          <p className="settings-project__path">
            <BreakAtSlashes text={project.path} />
          </p>
        </div>
        <button
          type="button"
          className="button button--small"
          onClick={() => void revealInFinder(project.path, `the ${project.name} repository`)}
        >
          Reveal in Finder
        </button>
      </div>

      {shown.row('Start new worktrees from') ? <StartPoint project={project} /> : null}
      {shown.row('Fetch in Background') ? <FetchInBackground project={project} /> : null}
      <CarriedPaths project={project} />
      {shown.row('Open checkouts in') ? <EditorCommand project={project} /> : null}
      {shown.row('Relay') ? <RelayBlock project={project} /> : null}
    </article>
  )
}

/** Whether this project's base ref is fetched on a timer and on window focus. */
function FetchInBackground({ project }: { project: Project }): React.JSX.Element {
  const setProjectPaths = useWorkspaceStore((state) => state.setProjectPaths)
  const id = `settings-fetch-${project.id}`
  return (
    <div className="settings-field">
      <label className="settings-field__label" htmlFor={id}>
        <Marked text="Fetch in Background" />
      </label>
      <input
        id={id}
        className="settings-field__check"
        type="checkbox"
        checked={project.fetchInBackground !== false}
        onChange={(event) => void setProjectPaths(project.id, { fetchInBackground: event.target.checked })}
      />
    </div>
  )
}

/** Which ref the New task dialog offers first: the ref in effect as text, a field only after Change. */
function StartPoint({ project }: { project: Project }): React.JSX.Element {
  const stored = useWorkspaceStore((state) => state.startPointDefaults[project.id] ?? '')
  const setStartPointDefault = useWorkspaceStore((state) => state.setStartPointDefault)
  const [draft, setDraft] = useState<string | null>(null)

  // On blur or Enter, since half a ref resolves to nothing.
  const commit = (): void => {
    if (draft === null) return
    const next = draft.trim()
    setDraft(null)
    // Null, not '': `withStartPoint` removes the entry on null, the only spelling of "use the base ref".
    if (next !== stored) setStartPointDefault(project.id, next.length === 0 ? null : next)
  }

  const id = `settings-start-point-${project.id}`

  return (
    <div className="settings-field">
      {draft === null ? (
        <span className="settings-field__label">
          <Marked text="Start new worktrees from" />
        </span>
      ) : (
        <label className="settings-field__label" htmlFor={id}>
          Start new worktrees from
        </label>
      )}
      <div className="settings-field__row">
        {draft === null ? (
          <>
            <code className="settings-value settings-value--mono">
              <Marked text={stored || project.baseRef} />
            </code>
            <button type="button" className="button button--small" onClick={() => setDraft(stored || project.baseRef)}>
              Change
            </button>
            {stored.length === 0 ? null : (
              <button
                type="button"
                className="button button--small"
                onClick={() => setStartPointDefault(project.id, null)}
              >
                Use {project.baseRef}
              </button>
            )}
          </>
        ) : (
          <input
            id={id}
            className="settings-field__input"
            type="text"
            value={draft}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            data-own-escape
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                commit()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setDraft(null)
              }
            }}
          />
        )}
      </div>
    </div>
  )
}

/** What a new worktree of this project gets that the branch does not carry, and its setup command. */
function CarriedPaths({ project }: { project: Project }): React.JSX.Element {
  const setProjectPaths = useWorkspaceStore((state) => state.setProjectPaths)
  const shown = useShown()

  return (
    <>
      {shown.row('Symlink into every new worktree') ? (
        <PathList
          project={project}
          id="linked"
          label="Symlink into every new worktree"
          examples="node_modules, .venv"
          paths={project.linkedPaths}
          save={(linkedPaths) => void setProjectPaths(project.id, { linkedPaths })}
        />
      ) : null}
      {shown.row('Copy into every new worktree') ? (
        <PathList
          project={project}
          id="copied"
          label="Copy into every new worktree"
          examples=".env, .env.local"
          paths={project.copiedPaths}
          save={(copiedPaths) => void setProjectPaths(project.id, { copiedPaths })}
        />
      ) : null}
      {shown.row('Setup command') ? <SetupCommand project={project} /> : null}
    </>
  )
}

/** The one setup command a new worktree runs, stored and typed into the pane verbatim. */
function SetupCommand({ project }: { project: Project }): React.JSX.Element {
  const setProjectPaths = useWorkspaceStore((state) => state.setProjectPaths)
  const shown = useShown()
  const stored = project.setupCommand ?? ''
  const [draft, setDraft] = useState(stored)

  useEffect(() => {
    setDraft(stored)
  }, [stored])

  const commit = (): void => {
    const next = draft.trim()
    if (next === stored) return
    void setProjectPaths(project.id, { setupCommand: next })
  }

  const id = `settings-setup-${project.id}`

  return (
    <div className="settings-field">
      <label className="settings-field__label" htmlFor={id}>
        <Marked text="Setup command" />
      </label>
      <input
        id={id}
        className="settings-field__input"
        type="text"
        value={draft}
        placeholder="None"
        title="e.g. npm ci"
        {...hitMark(shown, [stored])}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          }
        }}
      />
    </div>
  )
}

/** One path per line, written on blur: half a path is a path that does not exist. */
function PathList({
  project,
  id,
  label,
  examples,
  paths,
  save
}: {
  project: Project
  id: string
  label: string
  /** Shown on hover, never in the field, where an example reads as a value. */
  examples: string
  paths: readonly string[] | undefined
  save: (paths: string[]) => void
}): React.JSX.Element {
  const stored = (paths ?? []).join('\n')
  const [draft, setDraft] = useState(stored)
  const shown = useShown()

  useEffect(() => {
    setDraft(stored)
  }, [stored])

  const commit = (): void => {
    const next = draft
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    if (next.join('\n') === stored) return
    save(next)
  }

  const fieldId = `settings-${id}-paths-${project.id}`

  return (
    <div className="settings-field">
      <label className="settings-field__label" htmlFor={fieldId}>
        <Marked text={label} />
      </label>
      <textarea
        id={fieldId}
        className="settings-field__input settings-field__input--lines"
        rows={3}
        value={draft}
        placeholder="None"
        title={`One per line, e.g. ${examples}`}
        {...hitMark(shown, paths ?? [])}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
      />
    </div>
  )
}

/** The picker's value for a program typed in rather than picked. */
const OTHER_EDITOR = 'other'

/**
 * Which editor this project's checkouts open in: one found, or a program named in the field.
 * A program name, not a command line: it is spawned without a shell, the checkout as one argument.
 */
function EditorCommand({ project }: { project: Project }): React.JSX.Element {
  const stored = useWorkspaceStore((state) => state.editorCommands[project.id] ?? '')
  const found = useWorkspaceStore((state) => state.editors)
  const setEditorCommand = useWorkspaceStore((state) => state.setEditorCommand)
  const [draft, setDraft] = useState(stored)
  const [typing, setTyping] = useState(false)
  const shown = useShown()

  useEffect(() => {
    setDraft(stored)
  }, [stored])

  const { editors, firstFound } = editorChoices(found)
  const named = stored.length > 0 && !editors.some((editor) => editor.command === stored)
  const other = typing || named

  const commit = (): void => {
    const next = draft.trim()
    if (next === stored) return
    setEditorCommand(project.id, next.length === 0 ? null : next)
  }

  const id = `settings-editor-${project.id}`

  return (
    <div className="settings-field">
      <label className="settings-field__label" htmlFor={id}>
        <Marked text="Open checkouts in" />
      </label>
      <div className="settings-field__row">
        <Select
          id={id}
          value={other ? OTHER_EDITOR : stored}
          onChange={(event) => {
            const value = event.target.value
            setTyping(value === OTHER_EDITOR)
            if (value === OTHER_EDITOR) setDraft(named ? stored : '')
            else setEditorCommand(project.id, value.length === 0 ? null : value)
          }}
          {...hitMark(shown, [firstFound, ...editors.map((editor) => editor.label), 'Other…'])}
        >
          <option value="">{firstFound}</option>
          {editors.map((editor) => (
            <option key={editor.command} value={editor.command}>
              {editor.label}
            </option>
          ))}
          <option value={OTHER_EDITOR}>Other…</option>
        </Select>
        {other ? (
          <input
            className="settings-field__input"
            type="text"
            aria-label="Editor command"
            value={draft}
            placeholder="subl"
            {...hitMark(shown, [stored])}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                commit()
              }
            }}
          />
        ) : null}
      </div>
    </div>
  )
}

/**
 * Where teamwork would dial, read only: setting a relay is a step in the teamwork flow (key, file, push).
 * Shows what is dialled, which of the two sources it came from, and whether the env beats the file.
 */
function RelayBlock({ project }: { project: Project }): React.JSX.Element {
  const relay = useWorkspaceStore((state) => state.relays[project.id])
  const loadRelay = useWorkspaceStore((state) => state.loadRelay)
  const openTeamwork = useWorkspaceStore((state) => state.openTeamwork)

  useEffect(() => {
    void loadRelay(project.id)
  }, [loadRelay, project.id])

  const panel = relayPanel(relay)

  return (
    <div className="settings-field settings-relay">
      <h4 className="settings-field__label">
        <Marked text="Relay" />
      </h4>
      <p className={panel.empty ? 'settings-fact settings-fact--none' : 'settings-fact'}>
        <Marked text={panel.headline} />
      </p>
      {panel.detail ? <p className="settings-note">{panel.detail}</p> : null}
      {panel.override ? <p className="settings-warning">{panel.override}</p> : null}
      <div className="settings-actions">
        <button type="button" className="button button--small" onClick={() => openTeamwork(project.id)}>
          Open Teamwork
        </button>
      </div>
    </div>
  )
}

/** Lets a path wrap after each `/` rather than mid-name. */
function BreakAtSlashes({ text }: { text: string }): React.JSX.Element {
  return (
    <>
      {text.split('/').map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? (
            <>
              /<wbr />
            </>
          ) : null}
          {part}
        </Fragment>
      ))}
    </>
  )
}
