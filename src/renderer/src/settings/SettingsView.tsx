// The settings page: machine-level facts (PATH, updates, text size, checkouts), so it takes the window,
// one section at a time beside its own section list. Colours and relays are read here and set where they live.

import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { agentLaunchCommand } from '@shared/agentLaunch'
import { branchPrefixFor } from '@shared/branchName'
import type { Project, RunKind } from '@shared/entities'
import type { ParamsOf } from '@shared/methods'
import { RUN_KINDS } from '@shared/runCommands'
import { DEFAULT_FETCH_MINUTES, type RuntimeSettings } from '@shared/settings'
import { effectiveProjectSettings, settingSource, startPointOf } from '@shared/projectSettings'
import { AgentGlyph } from '../agents/glyphs'
import { Icon } from '../icons/Icon'
import { harnessName } from '../agents/harnesses'
import { copyText } from '../clipboard/clipboard'
import { cliActionLabel, cliOutcome, offerCliInstall } from '../dialogs/cliInstallModel'
import { Select } from '../ui/Select'
import { Switch } from '../ui/Switch'
import { paneNumberRows, shortcutGroups } from '../help/helpTopics'
import { formatChord, resolvePlatformModifier, type PlatformModifier } from '../keyboard/platformModifier'
import { menuLabel } from '../menu/menuBar'
import {
  ANY_PROJECT,
  NO_DEFAULT_AGENT,
  TERMINAL_LINE_HEIGHT_MAX,
  TERMINAL_LINE_HEIGHT_MIN,
  TERMINAL_FONT_MAX_PX,
  TERMINAL_FONT_MIN_PX,
  TERMINAL_SCROLLBACK_MAX,
  TERMINAL_SCROLLBACK_MIN,
  type AgentNoticePreference,
  type DiffLayout,
  type KeepAwakeMode,
  type NoticeEvents,
  type TerminalCursorStyle
} from '../state/preferences'
import { NoticeTest } from '../notices/NoticeTest'
import { openInBrowser } from '../shell/openInBrowser'
import { useNow } from '../state/useNow'
import { useWorkspaceStore } from '../state/workspaceStore'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { InstallerButton } from '../updates/InstallerButton'
import { installerStep } from '../updates/updateNotice'
import { PageFrame } from '../workspace/PageFrame'
import { activeChoice, BUILT_IN_THEMES, themeById } from '@shared/theme'
import { APPEARANCE_MODE_LABEL } from './AppearanceSettings'
import { useAddonStatus } from './addonStatus'
import { usePaneHostStatus } from './paneHostStatus'
import { useRuntimeSettings, type RuntimeSettingsState } from './runtimeSettings'
import { useSettingsFind } from './settingsFind'
import { useUsageStore } from '../state/usageStore'
import {
  addonLine,
  agentRows,
  cliLine,
  describedOnly,
  firstMatch,
  labelMatches,
  paneHostLines,
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
  const whole = labelMatches(title, query) || describedOnly(title, query)
  return {
    whole,
    query,
    row: (label) => whole || rows.some((row) => row.label === label && rowMatches(row, query)),
    hit: (words) => query.trim() !== '' && words.some((word) => word !== '' && labelMatches(word, query))
  }
}

/** The text, with the filter's words marked where they occur; a label found by what it is about is marked whole. */
function Marked({ text }: { text: string }): React.JSX.Element {
  const { query } = useShown()
  const wanted = query.trim().toLowerCase()
  const at = wanted === '' ? -1 : text.toLowerCase().indexOf(wanted)
  if (at < 0) return describedOnly(text, query) ? <mark className="settings-match">{text}</mark> : <>{text}</>
  return (
    <>
      {text.slice(0, at)}
      <mark className="settings-match">{text.slice(at, at + wanted.length)}</mark>
      {text.slice(at + wanted.length)}
    </>
  )
}

/** This Mac's settings, read once for the page so a change in General reaches the projects' rows. */
const MachineContext = createContext<RuntimeSettingsState>({
  settings: null,
  problem: null,
  change: () => {},
  save: async () => {}
})

/** Where new worktrees go when a project names no folder. */
function machineRoot(settings: RuntimeSettings | null): string {
  return settings?.worktreesRoot ?? settings?.worktreesRootFallback ?? ''
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
  { value: 'off', label: 'Never' },
  { value: 'notify', label: 'Silently' },
  { value: 'sound', label: 'With Sound' }
]

const NOTICE_EVENTS: readonly { event: keyof NoticeEvents; label: string }[] = [
  { event: 'finished', label: 'Agent Finishes' },
  { event: 'asking', label: 'Agent Asks' },
  { event: 'teammates', label: 'Teammate Shares a Note' }
]

const FETCH_CHOICES: readonly { value: string; label: string }[] = [
  { value: '1', label: '1 minute' },
  { value: '5', label: '5 minutes' },
  { value: '15', label: '15 minutes' },
  { value: '30', label: '30 minutes' },
  { value: '60', label: '1 hour' }
]

const KEEP_AWAKE_CHOICES: readonly { value: KeepAwakeMode; label: string }[] = [
  { value: 'agent', label: 'While Agents Work' },
  { value: 'on', label: 'Always' },
  { value: 'off', label: 'Off' }
]

const DIFF_LAYOUTS: readonly { value: DiffLayout; label: string }[] = [
  { value: 'inline', label: 'Inline' },
  { value: 'split', label: 'Side by side' }
]

type ShortcutRow = { group: string; label: string; chord: string }

/** Every chord Help lists, in its order, under its group's title. */
function useShortcutRows(modifier: PlatformModifier): ShortcutRow[] {
  const sidebarVisible = useWorkspaceStore((state) => state.sidebarVisible)
  const rightPanelOpen = useWorkspaceStore((state) => state.rightPanelOpen)
  return shortcutGroups().flatMap((group) => [
    ...group.shortcuts.map((shortcut) => ({
      group: group.title,
      label: menuLabel(shortcut.command, { sidebarVisible, rightPanelOpen }),
      chord: shortcut.chord ? formatChord(shortcut.chord, modifier) : ''
    })),
    ...(group.id === 'panes'
      ? paneNumberRows(modifier).map((row) => ({ group: group.title, label: row.title, chord: row.chord }))
      : [])
  ])
}

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

type EditorPicker = {
  editors: readonly { command: string; label: string }[]
  /** The first option: what an unset picker falls back to. */
  first: string
  stored: string
  /** What the filter reads: every option, and a program typed under Other…. */
  words: string[]
}

/** The editor picker for a project, or for every project under `ANY_PROJECT`. */
function editorPicker(
  key: string,
  commands: Readonly<Record<string, string>>,
  found: readonly { command: string; label: string; kind?: string }[] | null
): EditorPicker {
  const editors = (found ?? []).filter((editor) => (editor.kind ?? 'editor') === 'editor')
  const labelOf = (command: string): string =>
    editors.find((editor) => editor.command === command)?.label ?? command.split('/').filter(Boolean).pop() ?? command
  const inherited = key === ANY_PROJECT ? undefined : commands[ANY_PROJECT]
  const first =
    inherited !== undefined
      ? `Default (${labelOf(inherited)})`
      : editors[0] === undefined
        ? 'First found'
        : `First found (${editors[0].label})`
  const stored = commands[key] ?? ''
  // A program typed in under Other… is on screen; a picked editor's command is not.
  const typed = editors.some((editor) => editor.command === stored) ? '' : stored
  return { editors, first, stored, words: [first, ...editors.map((editor) => editor.label), 'Other…', typed] }
}

/** A project's rows as the filter reads them, from the same values its controls show. */
function useProjectRows(machine: RuntimeSettings | null): (project: Project) => SettingsRow[] {
  const startPoints = useWorkspaceStore((state) => state.startPointDefaults)
  const editorCommands = useWorkspaceStore((state) => state.editorCommands)
  const found = useWorkspaceStore((state) => state.editors)
  const relays = useWorkspaceStore((state) => state.relays)
  return (project) => {
    const applied = effectiveProjectSettings(project)
    return [
      { label: 'Start new worktrees from', words: [startPointOf(project, startPoints[project.id])] },
      { label: 'Worktrees in', words: [project.worktreesRoot ?? machineRoot(machine)] },
      { label: 'Branch prefix', words: [branchPrefixFor(project, machine?.branchPrefix)] },
      { label: 'Fetch in Background', words: [] },
      { label: 'Symlink into every new worktree', words: applied.linkedPaths ?? [] },
      { label: 'Copy into every new worktree', words: applied.copiedPaths ?? [] },
      { label: 'Setup command', words: [applied.setupCommand ?? ''] },
      ...RUN_KINDS.map((kind) => ({ label: RUN_SETTING[kind], words: [applied.runCommands?.[kind] ?? ''] })),
      { label: 'Open checkouts in', words: editorPicker(project.id, editorCommands, found).words },
      { label: 'Relay', words: [relayPanel(relays[project.id]).headline] }
    ]
  }
}

/** Every row outside a project as the filter reads it: label, option labels and current value. */
function useSectionRows(
  machine: RuntimeSettings | null,
  modifier: PlatformModifier
): Record<Exclude<SectionId, 'projects'>, SettingsRow[]> {
  const agentArgs = useWorkspaceStore((state) => state.agentArgs)
  const fontSize = useWorkspaceStore((state) => state.terminalFontSize)
  const options = useWorkspaceStore((state) => state.terminalOptions)
  const agents = useAgentRows()
  const themeValue = useThemeValue()
  const shortcuts = useShortcutRows(modifier)
  const editorCommands = useWorkspaceStore((state) => state.editorCommands)
  const found = useWorkspaceStore((state) => state.editors)
  return {
    general: [
      { label: 'Worktrees in', words: [machineRoot(machine)] },
      { label: 'Branch prefix', words: [machine?.branchPrefix ?? ''] },
      ...(offersMenuBar() ? [{ label: 'Show in Menu Bar', words: [] }] : []),
      { label: 'Show Cost', words: [] },
      { label: 'Keep Awake', words: KEEP_AWAKE_CHOICES.map((choice) => choice.label) },
      { label: 'Default editor', words: editorPicker(ANY_PROJECT, editorCommands, found).words },
      { label: 'Ask Before Deleting Worktrees', words: [] }
    ],
    agents: [
      {
        label: 'Default agent',
        words: ['First found', ...agents.filter((row) => row.command !== null).map((row) => harnessName(row.kind))]
      },
      ...agents.map((row) => ({ label: harnessName(row.kind), words: [agentArgs[row.kind] ?? ''] })),
      { label: 'Trust New Worktrees', words: [] },
      { label: 'Warn Agents About Overlaps', words: [] }
    ],
    git: [
      { label: 'Fetch every', words: FETCH_CHOICES.map((choice) => choice.label) },
      { label: 'Diff layout', words: DIFF_LAYOUTS.map((layout) => layout.label) },
      { label: 'Wrap Diff Lines', words: [] },
      { label: 'Hide Whitespace Changes', words: [] }
    ],
    panes: [
      { label: 'Terminal text size', words: [`${fontSize}px`] },
      { label: 'Font', words: [options.fontFamily] },
      { label: 'Line height', words: [String(options.lineHeight)] },
      { label: 'Cursor', words: [...CURSOR_STYLES.map((style) => style.label), 'Blink'] },
      { label: 'Option as Meta', words: [] },
      { label: 'Copy on Select', words: [] },
      { label: 'Scrollback lines', words: [String(options.scrollback)] },
      { label: 'Shell', words: [machine?.shell ?? ''] },
      { label: 'Ask Before Stopping Agents', words: [] },
      { label: 'Keep Agents Running When teamree Quits', words: [] }
    ],
    notices: [
      { label: 'Notify', words: NOTICE_CHOICES.map((choice) => choice.label) },
      ...NOTICE_EVENTS.map((entry) => ({ label: entry.label, words: [] }))
    ],
    teamwork: [{ label: 'Share Task Details', words: [] }],
    appearance: [{ label: 'Theme', words: [themeValue, ...THEME_WORDS] }],
    shortcuts: shortcuts.map((row) => ({ label: row.label, words: [row.chord] })),
    addons: [{ label: 'Jac Graph Memory', words: [] }],
    updates: [{ label: 'Check Automatically', words: [] }],
    cli: [{ label: 'teamree command', words: [] }]
  }
}

export function SettingsView({
  modifier = resolvePlatformModifier(window.teamree?.platform)
}: {
  modifier?: PlatformModifier
}): React.JSX.Element {
  const projects = useWorkspaceStore((state) => state.projects)
  const toggleSettings = useWorkspaceStore((state) => state.toggleSettings)
  const loadCli = useWorkspaceStore((state) => state.loadCli)
  const loadUpdate = useWorkspaceStore((state) => state.loadUpdate)
  const loadAgentTrust = useWorkspaceStore((state) => state.loadAgentTrust)
  const agents = useAgentRows()
  const [query, setQuery] = useState('')
  const filtering = query.trim() !== ''
  const machine = useRuntimeSettings()
  const sectionRows = useSectionRows(machine.settings, modifier)
  const projectRows = useProjectRows(machine.settings)
  const rowsOf = (id: SectionId): SettingsRow[] =>
    id === 'projects'
      ? projects.flatMap((project) => [{ label: project.name, words: [] }, ...projectRows(project)])
      : sectionRows[id]
  const sections = SETTINGS_SECTIONS.filter((entry) => entry.id !== 'agents' || agents.length > 0).filter(
    (entry) => shownUnder(entry.label, query, []).whole || rowsOf(entry.id).some((row) => rowMatches(row, query))
  )

  // Read again on open: both are facts about the world outside this window that may have moved.
  useEffect(() => {
    void loadCli()
    void loadUpdate()
    void loadAgentTrust()
  }, [loadCli, loadUpdate, loadAgentTrust])

  const body = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const [current, setCurrent] = useState<SectionId>('general')
  const active = sections.some((entry) => entry.id === current) ? current : (sections[0]?.id ?? null)
  // Without a filter one section is on screen; with one, every section holding a match.
  const onScreen = filtering ? sections : sections.filter((entry) => entry.id === active)

  // What to do with a section's heading once it is drawn; `visit` re-runs it for the section already shown.
  const arrival = useRef<{ id: SectionId; focus: boolean; ring: boolean } | null>(null)
  const [visit, setVisit] = useState(0)
  const goTo = (id: SectionId, how: { focus?: boolean; ring?: boolean } = {}): void => {
    arrival.current = { id, focus: how.focus ?? true, ring: how.ring ?? false }
    setCurrent(id)
    setVisit((count) => count + 1)
  }
  useEffect(() => {
    const want = arrival.current
    if (want === null) return
    arrival.current = null
    const heading = document.getElementById(`settings-${want.id}`)
    if (heading === null) return
    if (filtering) heading.scrollIntoView?.({ block: 'start' })
    else if (body.current !== null) body.current.scrollTop = 0
    if (want.focus) heading.focus({ preventScroll: true })
    if (want.ring) flash(want.id)
  }, [visit])

  // Opened at a section — the strip's "Agent settings…", the rail's `!` — it is shown and lit once.
  const section = useWorkspaceStore((state) => state.settingsSection)
  useEffect(() => {
    if (section === null) return
    setQuery('')
    goTo(section, { ring: true })
    useWorkspaceStore.setState({ settingsSection: null })
  }, [section])

  // The palette's Open Setting: the filter holds its label, and its row's control takes the focus once shown.
  const asked = useWorkspaceStore((state) => state.settingsQuery)
  const landing = useRef<string | null>(null)
  useEffect(() => {
    if (asked === null) return
    landing.current = asked
    setQuery(asked)
    useWorkspaceStore.setState({ settingsQuery: null })
  }, [asked])

  // Each new filter starts at the top, so a match below the fold is not missed.
  useEffect(() => {
    if (body.current !== null) body.current.scrollTop = 0
    // Mounted asking, this runs once for the empty filter first; the label waits for its own.
    const label = landing.current
    if (label === null || label !== query || body.current === null) return
    landing.current = null
    if (!landOn(body.current, label)) {
      const section = firstMatch(label)?.section
      if (section !== undefined) flash(section)
    }
  }, [query])

  // The find chord, while this page covers the panes.
  const find = useSettingsFind((state) => state.asked)
  const seen = useRef(find)
  useEffect(() => {
    if (find === seen.current) return
    seen.current = find
    search.current?.focus()
    search.current?.select()
  }, [find])

  const side = (
    <SettingsSide
      sections={sections}
      active={filtering ? null : active}
      goTo={goTo}
      query={query}
      setQuery={setQuery}
      searchRef={search}
      findKey={formatChord({ key: 'f' }, modifier)}
    />
  )

  return (
    <PageFrame
      label="Settings"
      title="Settings"
      onClose={toggleSettings}
      bodyRef={body}
      bodyTestId="settings-body"
      side={side}
    >
      <div className={filtering ? 'settings__content settings__content--found' : 'settings__content'}>
        {sections.length === 0 ? <p className="settings-note">No matches</p> : null}
        <MachineContext.Provider value={machine}>
          {onScreen.map((entry) => (
            <ShownContext.Provider key={entry.id} value={shownUnder(entry.label, query, rowsOf(entry.id))}>
              <SectionBody id={entry.id} projects={projects} modifier={modifier} />
            </ShownContext.Provider>
          ))}
        </MachineContext.Provider>
      </div>
    </PageFrame>
  )
}

function SectionBody({
  id,
  projects,
  modifier
}: {
  id: SectionId
  projects: readonly Project[]
  modifier: PlatformModifier
}): React.JSX.Element | null {
  switch (id) {
    case 'general':
      return <GeneralSection />
    case 'agents':
      return <AgentsSection />
    case 'projects':
      return <ProjectsSection projects={projects} />
    case 'git':
      return <GitSection />
    case 'panes':
      return <PanesSection />
    case 'notices':
      return <NoticesSection />
    case 'teamwork':
      return <TeamworkSection />
    case 'appearance':
      return <AppearanceSection />
    case 'shortcuts':
      return <ShortcutsSection modifier={modifier} />
    case 'addons':
      return <AddonsSection />
    case 'updates':
      return <UpdatesSection />
    case 'cli':
      return <CliSection />
  }
}

/** Rings a section's first group for a moment, so the one asked for is found. */
function flash(id: SectionId): void {
  const group = document
    .getElementById(`settings-${id}`)
    ?.closest('.settings-section')
    ?.querySelector<HTMLElement>('.settings-group')
  if (group) ring(group)
}

/** Inset for a row, which its neighbours would paint over. */
function ring(element: HTMLElement, inset = ''): void {
  element.animate?.(
    [{ boxShadow: `${inset}0 0 0 2px var(--accent)` }, { boxShadow: `${inset}0 0 0 2px transparent` }],
    {
      duration: 1600,
      easing: 'ease-out'
    }
  )
}

/** Focuses the control of the first row labelled `label` and rings the row; false when there is none. */
function landOn(page: HTMLElement, label: string): boolean {
  const row = [...page.querySelectorAll<HTMLElement>('.settings-field')].find(
    (field) => field.querySelector('.settings-field__label')?.textContent === label
  )
  if (row === undefined) return false
  row
    .querySelector<HTMLElement>(
      '.settings-field__control :is(input, select, textarea, button, [tabindex="0"]):not(:disabled)'
    )
    ?.focus()
  ring(row, 'inset ')
  return true
}

type SectionEntry = (typeof SETTINGS_SECTIONS)[number]

/** The search and the grouped section list, the full height of the page. */
function SettingsSide({
  sections,
  active,
  goTo,
  query,
  setQuery,
  searchRef,
  findKey
}: {
  sections: readonly SectionEntry[]
  active: SectionId | null
  goTo: (id: SectionId, how?: { focus?: boolean }) => void
  query: string
  setQuery: (query: string) => void
  searchRef: React.Ref<HTMLInputElement>
  findKey: string
}): React.JSX.Element {
  const cli = useWorkspaceStore((state) => state.cli)
  // The sidebar's `!` on Settings, on the row that fixes it.
  const cliFlag = offerCliInstall(cli) ? `CLI: ${cliActionLabel(cli)}` : null
  const groups = [...new Set(sections.map((entry) => entry.group))]

  // Arrows walk the list and show each section on the way, the focus staying in the list.
  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-section]')]
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
    const target = next === null ? undefined : buttons[next]
    if (target === undefined || at < 0) return
    event.preventDefault()
    target.focus()
    goTo(target.dataset.section as SectionId, { focus: false })
  }

  return (
    <div className="settings-side">
      <label className="settings-search">
        <Icon name="search" size={14} className="settings-search__icon" />
        <input
          ref={searchRef}
          type="search"
          className="settings-search__input"
          aria-label="Filter settings"
          placeholder="Search"
          value={query}
          autoComplete="off"
          spellCheck={false}
          data-own-escape={query === '' ? undefined : true}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setQuery('')
          }}
        />
        {query === '' ? (
          <kbd className="settings-search__key" aria-hidden="true">
            {findKey}
          </kbd>
        ) : null}
      </label>
      <nav className="settings-nav" aria-label="Sections" onKeyDown={onKeyDown}>
        {groups.map((group) => (
          <div key={group}>
            <p className="settings-nav__heading" id={`settings-group-${group}`}>
              {group}
            </p>
            <ul className="settings-nav__list" aria-labelledby={`settings-group-${group}`}>
              {sections
                .filter((entry) => entry.group === group)
                .map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className="settings-nav__item"
                      data-section={entry.id}
                      title={entry.label}
                      aria-current={entry.id === active ? 'true' : undefined}
                      onClick={() => goTo(entry.id)}
                    >
                      <Icon name={entry.icon} className="settings-nav__icon" />
                      <span className="settings-nav__label">{entry.label}</span>
                      {entry.id === 'cli' && cliFlag !== null ? (
                        <span className="settings-nav__badge" role="img" aria-label={cliFlag}>
                          !
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </nav>
    </div>
  )
}

/** A section's heading: the page's title for it, and where Settings › that section lands the focus. */
function SectionTitle({ id, text }: { id: SectionId; text: string }): React.JSX.Element {
  return (
    <h2 className="settings-section__title" id={`settings-${id}`} tabIndex={-1}>
      <Marked text={text} />
    </h2>
  )
}

/** One card of rows, with an optional small title; hidden by the stylesheet when the filter empties it. */
function Group({ title, children }: { title?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="settings-card">
      {title === undefined ? null : <h3 className="settings-card__title">{title}</h3>}
      <div className="settings-group">{children}</div>
    </div>
  )
}

/**
 * One row: the label (and at most a one-line hint) on the left, the control right-aligned in the control column.
 * `wide` gives the control the rest of the row, for a path or a value with buttons.
 */
function Field({
  label,
  htmlFor,
  heading = false,
  hint,
  source,
  wide = false,
  below,
  children
}: {
  label: string
  /** The control the label names; a row whose control is a value and buttons has none. */
  htmlFor?: string
  heading?: boolean
  hint?: string
  /** Where the value comes from, under the label. */
  source?: React.ReactNode
  wide?: boolean
  /** Across the whole row under both, e.g. the command a field builds. */
  below?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const text = <Marked text={label} />
  return (
    <div className={wide ? 'settings-field settings-field--wide' : 'settings-field'}>
      <div className="settings-field__text">
        {htmlFor !== undefined ? (
          <label className="settings-field__label" htmlFor={htmlFor}>
            {text}
          </label>
        ) : heading ? (
          <h4 className="settings-field__label">{text}</h4>
        ) : (
          <span className="settings-field__label">{text}</span>
        )}
        {hint === undefined ? null : <span className="settings-field__hint">{hint}</span>}
        {source}
      </div>
      <div className="settings-field__control">{children}</div>
      {below ? <div className="settings-field__below">{below}</div> : null}
    </div>
  )
}

/** A path on one line, cut in the middle so its last two parts stay; the whole path on hover. */
function PathText({ path, className = '' }: { path: string; className?: string }): React.JSX.Element {
  const parts = path.split('/')
  const tail = parts.length > 3 ? parts.slice(-2).join('/') : path
  const head = path.slice(0, path.length - tail.length)
  return (
    <code className={`settings-path ${className}`.trim()} title={path}>
      {head === '' ? null : (
        <span className="settings-path__head">
          <Marked text={head} />
        </span>
      )}
      <span className="settings-path__tail">
        <Marked text={tail} />
      </span>
    </code>
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
      <SectionTitle id="cli" text="CLI" />
      <Group>
        <Field label="Status">
          <span className="settings-value">{line.status}</span>
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
        </Field>
        {line.paths.map((row) => (
          <Field key={row.label} label={row.label} wide>
            <PathText path={row.path} />
          </Field>
        ))}

        {line.manual ? (
          <pre className="settings-command">
            <code>{line.manual}</code>
          </pre>
        ) : null}

        {/* Beside the button that caused it: that is where the retry happens. */}
        {error ? <p className="settings-error">{error}</p> : null}
        {install && error === null ? <p className="settings-done">{cliOutcome(install)}</p> : null}
      </Group>
    </section>
  )
}

const UV_INSTALL_DOCUMENT = 'https://docs.astral.sh/uv/getting-started/installation/'

/** Optional helpers that run outside the app; each is off until installed and turned on. */
function AddonsSection(): React.JSX.Element {
  const machine = useContext(MachineContext)
  const { status, problem, install, check } = useAddonStatus()
  const line = addonLine(status, machine.settings?.jacMemoryAddon ?? false)
  const shown = useShown()
  return (
    <section className="settings-section" aria-labelledby="settings-addons">
      <SectionTitle id="addons" text="Add-ons" />
      <Group>
        {shown.row('Jac Graph Memory') ? (
          <Field
            label="Jac Graph Memory"
            htmlFor={line.on === null ? undefined : 'settings-jac-memory'}
            below={
              line.problem === null && problem === null ? null : (
                <p className="settings-error">
                  {line.problem ?? problem}
                  {line.details === null ? null : (
                    <>
                      {' '}
                      <button
                        type="button"
                        className="button button--small"
                        onClick={() => copyText(line.details ?? '')}
                      >
                        Copy Details
                      </button>
                    </>
                  )}
                </p>
              )
            }
          >
            <div className="settings-actions" data-testid="addon-jac-memory">
              <span className="settings-aside">{line.state}</span>
              {line.action === 'install' || line.action === 'retry' ? (
                <button type="button" className="button button--small" onClick={install}>
                  {line.action === 'retry' ? 'Retry' : 'Install'}
                </button>
              ) : null}
              {line.action === 'uv' ? (
                <>
                  <button
                    type="button"
                    className="button button--small"
                    onClick={() => openInBrowser(UV_INSTALL_DOCUMENT)}
                  >
                    Get uv
                  </button>
                  <button type="button" className="button button--small" onClick={check}>
                    Check Again
                  </button>
                </>
              ) : null}
              {line.on === null ? null : (
                <Switch
                  id="settings-jac-memory"
                  checked={line.on}
                  disabled={machine.settings === null}
                  onChange={(jacMemoryAddon) => machine.change({ jacMemoryAddon })}
                />
              )}
            </div>
          </Field>
        ) : null}
      </Group>
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
      <SectionTitle id="updates" text="Updates" />
      <Group>
        {shown.whole ? (
          <div className="settings-row">
            <p className="settings-fact">{panel.headline}</p>
            {panel.offersCheck ? (
              <div className="settings-actions">
                {panel.lastChecked || panel.problem ? (
                  <span className="settings-aside">
                    {[panel.problem, panel.lastChecked].filter(Boolean).join(' · ')}
                  </span>
                ) : null}
                <button
                  type="button"
                  className="button button--small"
                  disabled={update?.checking ?? false}
                  onClick={() => void checkForUpdates({ inline: true })}
                >
                  {update?.checking ? 'Checking…' : 'Check for Updates'}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {shown.whole && step !== null && update?.available ? (
          <div className="settings-row">
            <p className="settings-fact">
              teamree {update.available.version} {step.kind === 'restart' ? 'is ready' : 'available'}
            </p>
            <InstallerButton step={step} className="button button--small" />
          </div>
        ) : null}
        {shown.whole && step?.problem ? <p className="settings-error">{step.problem}</p> : null}

        {/* Half a minute after startup, then every six hours; a label is not the place for a schedule. */}
        {panel.offersCheck && shown.row('Check Automatically') ? (
          <CheckField
            id="settings-check-updates"
            label="Check Automatically"
            checked={update?.automatic ?? false}
            onChange={(automatic) => void setAutomaticUpdates(automatic)}
          />
        ) : null}

        {/* A checkable build says its failure beside the button instead. */}
        {shown.whole && !panel.offersCheck && panel.problem ? (
          <p className="settings-warning">{panel.problem}</p>
        ) : null}
      </Group>
    </section>
  )
}

/** The status item lives in the macOS menu bar only. */
function offersMenuBar(): boolean {
  return window.teamree?.platform === 'darwin'
}

/** Machine-wide settings that belong to no other section. */
function GeneralSection(): React.JSX.Element {
  const machine = useContext(MachineContext)
  const settings = machine.settings
  const keepAwake = useWorkspaceStore((state) => state.keepAwake)
  const setKeepAwake = useWorkspaceStore((state) => state.setKeepAwake)
  const confirmations = useWorkspaceStore((state) => state.confirmations)
  const setConfirmation = useWorkspaceStore((state) => state.setConfirmation)
  const show = useShown()

  return (
    <section className="settings-section" aria-labelledby="settings-general">
      <SectionTitle id="general" text="General" />
      <Group title="Worktrees">
        {show.row('Worktrees in') ? (
          <WorktreesIn
            own={settings?.worktreesRoot}
            applied={machineRoot(settings)}
            save={(worktreesRoot, allowInsideRepository) =>
              machine.save({ worktreesRoot, ...(allowInsideRepository ? { allowInsideRepository } : {}) })
            }
          />
        ) : null}
        {show.row('Branch prefix') ? (
          <BranchPrefix
            id="settings-branch-prefix"
            own={settings?.branchPrefix ?? ''}
            inherited=""
            save={(branchPrefix) => machine.save({ branchPrefix })}
          />
        ) : null}
        {show.row('Ask Before Deleting Worktrees') ? (
          <CheckField
            id="settings-confirm-remove"
            label="Ask Before Deleting Worktrees"
            checked={confirmations.removeWorktree}
            onChange={(on) => setConfirmation('removeWorktree', on)}
          />
        ) : null}
      </Group>
      <Group title="This Mac">
        {show.row('Default editor') ? <EditorCommand editorKey={ANY_PROJECT} label="Default editor" /> : null}
        {show.row('Keep Awake') ? (
          <ChoiceField
            id="settings-keep-awake"
            label="Keep Awake"
            value={keepAwake}
            choices={KEEP_AWAKE_CHOICES}
            onChange={setKeepAwake}
          />
        ) : null}
        {offersMenuBar() && show.row('Show in Menu Bar') ? (
          <CheckField
            id="settings-menu-bar"
            label="Show in Menu Bar"
            checked={settings?.showInMenuBar ?? false}
            disabled={settings === null}
            onChange={(showInMenuBar) => machine.change({ showInMenuBar })}
          />
        ) : null}
        {show.row('Show Cost') ? (
          <CheckField
            id="settings-show-cost"
            label="Show Cost"
            checked={settings?.showCost ?? false}
            disabled={settings === null}
            onChange={(showCost) => {
              machine.change({ showCost })
              useUsageStore.setState({ showCost })
            }}
          />
        ) : null}
      </Group>
      {machine.problem === null ? null : <p className="settings-error">{machine.problem}</p>}
    </section>
  )
}

function reasonFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Where new worktrees go: the folder in effect, Choose… to pick another, Reveal, and Reset while `own` is set.
 * A folder inside a repository is refused once, then taken with Use Anyway.
 */
function WorktreesIn({
  own,
  applied,
  source,
  save
}: {
  own: string | undefined
  applied: string
  source?: React.ReactNode
  /** An empty folder clears it. */
  save: (folder: string, allowInsideRepository?: boolean) => Promise<unknown>
}): React.JSX.Element {
  const revealInFinder = useWorkspaceStore((state) => state.revealInFinder)
  const [problem, setProblem] = useState<{ message: string; folder: string; inside: boolean } | null>(null)

  const attempt = async (folder: string, allowInsideRepository = false): Promise<void> => {
    setProblem(null)
    try {
      await save(folder, allowInsideRepository)
    } catch (error) {
      const refusal = (error as { data?: { refusal?: string } } | null)?.data?.refusal
      setProblem({ message: reasonFor(error), folder, inside: refusal === 'insideRepository' })
    }
  }
  const choose = async (): Promise<void> => {
    const picked = await window.teamree?.chooseFolder(applied || (window.teamree?.homeDir ?? ''))
    if (picked) await attempt(picked)
  }

  return (
    <Field
      label="Worktrees in"
      wide
      source={source}
      below={
        problem === null ? null : (
          <p className="settings-error">
            {problem.message}
            {problem.inside ? (
              <>
                {' '}
                <button
                  type="button"
                  className="button button--small"
                  onClick={() => void attempt(problem.folder, true)}
                >
                  Use Anyway
                </button>
              </>
            ) : null}
          </p>
        )
      }
    >
      <PathText path={applied} />
      <button
        type="button"
        className="button button--small"
        disabled={applied === ''}
        onClick={() => void revealInFinder(applied, 'the worktrees folder')}
      >
        Reveal
      </button>
      <button type="button" className="button button--small" disabled={applied === ''} onClick={() => void choose()}>
        Choose…
      </button>
      {own === undefined ? null : (
        <button type="button" className="button button--small button--ghost" onClick={() => void attempt('')}>
          Reset
        </button>
      )}
    </Field>
  )
}

/** Leads the branch names teamree picks; `inherited` is the prefix in effect while this one is empty. */
function BranchPrefix({
  id,
  own,
  inherited,
  source,
  save
}: {
  id: string
  own: string
  inherited: string
  source?: React.ReactNode
  save: (prefix: string) => Promise<unknown>
}): React.JSX.Element {
  const shown = useShown()
  const [problem, setProblem] = useState<string | null>(null)
  const draft = useDraft(own, (prefix) => {
    setProblem(null)
    save(prefix).catch((error: unknown) => setProblem(reasonFor(error)))
  })
  return (
    <Field
      label="Branch prefix"
      htmlFor={id}
      source={source}
      below={problem === null ? null : <p className="settings-error">{problem}</p>}
    >
      <input
        id={id}
        className={`settings-input${inherited ? ' settings-input--command' : ''}`}
        type="text"
        placeholder={inherited || 'None'}
        aria-invalid={problem !== null}
        {...hitMark(shown, [own])}
        {...draft}
      />
    </Field>
  )
}

/** How this window says something happened while you were elsewhere, and for which events. */
function NoticesSection(): React.JSX.Element {
  const agentNotices = useWorkspaceStore((state) => state.agentNotices)
  const setAgentNotices = useWorkspaceStore((state) => state.setAgentNotices)
  const events = useWorkspaceStore((state) => state.noticeEvents)
  const setNoticeEvent = useWorkspaceStore((state) => state.setNoticeEvent)
  const shown = useShown()

  return (
    <section className="settings-section" aria-labelledby="settings-notices">
      <SectionTitle id="notices" text="Notifications" />
      <Group>
        {shown.row('Notify') ? (
          <ChoiceField
            id="settings-agent-notices"
            label="Notify"
            value={agentNotices}
            choices={NOTICE_CHOICES}
            onChange={setAgentNotices}
          >
            {/* Keyed so a result from another setting does not linger. */}
            <NoticeTest key={agentNotices} />
          </ChoiceField>
        ) : null}
      </Group>
      <Group title="Events">
        {NOTICE_EVENTS.filter((entry) => shown.row(entry.label)).map((entry) => (
          <CheckField
            key={entry.event}
            id={`settings-notice-${entry.event}`}
            label={entry.label}
            checked={events[entry.event]}
            disabled={agentNotices === 'off'}
            onChange={(on) => setNoticeEvent(entry.event, on)}
          />
        ))}
      </Group>
    </section>
  )
}

/** What teammates' presence carries from this machine. */
function TeamworkSection(): React.JSX.Element {
  const { settings, problem, change } = useRuntimeSettings()
  return (
    <section className="settings-section" aria-labelledby="settings-teamwork">
      <SectionTitle id="teamwork" text="Teamwork" />
      <Group>
        <CheckField
          id="settings-share-task-details"
          label="Share Task Details"
          checked={settings?.shareTaskDetails ?? true}
          disabled={settings === null}
          onChange={(shareTaskDetails) => change({ shareTaskDetails })}
        />
        {problem === null ? null : <p className="settings-error">{problem}</p>}
      </Group>
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
  const lineHeight = useDraft(String(options.lineHeight), (value) => {
    const height = Number.parseFloat(value)
    if (Number.isFinite(height)) setOptions({ lineHeight: height })
  })
  const stopAgent = useWorkspaceStore((state) => state.confirmations.stopAgent)
  const setConfirmation = useWorkspaceStore((state) => state.setConfirmation)
  const shown = useShown()
  const runtime = useRuntimeSettings()

  return (
    <section className="settings-section" aria-labelledby="settings-panes">
      <SectionTitle id="panes" text="Panes" />
      <Group title="Terminal">
        {shown.row('Terminal text size') ? (
          <Field label="Terminal text size" htmlFor="settings-font-size">
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
          </Field>
        ) : null}

        {shown.row('Font') ? (
          <Field
            label="Font"
            htmlFor="settings-font"
            below={
              // The draft, not the stored value: the point is to see a face before keeping it.
              <div
                className="settings-font-preview"
                data-testid="settings-font-preview"
                style={{ fontFamily: font.value, fontSize: terminalFontSize }}
              >
                ~/repo $ git status 0O 1lI {'{}'} =&gt; !=
              </div>
            }
          >
            <input
              id="settings-font"
              className="settings-input"
              type="text"
              {...font}
              {...hitMark(shown, [options.fontFamily])}
            />
          </Field>
        ) : null}

        {shown.row('Line height') ? (
          <Field label="Line height" htmlFor="settings-line-height">
            <input
              id="settings-line-height"
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
          <Field label="Cursor" htmlFor="settings-cursor">
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
            <label className="settings-inline">
              <span>
                <Marked text="Blink" />
              </span>
              <Switch checked={options.cursorBlink} onChange={(cursorBlink) => setOptions({ cursorBlink })} />
            </label>
          </Field>
        ) : null}

        {shown.row('Scrollback lines') ? (
          <Field label="Scrollback lines" htmlFor="settings-scrollback">
            <input
              id="settings-scrollback"
              className="settings-input settings-input--number"
              type="number"
              min={TERMINAL_SCROLLBACK_MIN}
              max={TERMINAL_SCROLLBACK_MAX}
              step={1000}
              {...scrollback}
              {...hitMark(shown, [String(options.scrollback)])}
            />
          </Field>
        ) : null}

        {shown.row('Shell') ? <ShellField /> : null}
      </Group>

      <Group title="Keys">
        {shown.row('Option as Meta') ? (
          <CheckField
            id="settings-option-meta"
            label="Option as Meta"
            checked={options.optionIsMeta}
            onChange={(optionIsMeta) => setOptions({ optionIsMeta })}
          />
        ) : null}

        {shown.row('Copy on Select') ? (
          <CheckField
            id="settings-copy-on-select"
            label="Copy on Select"
            checked={options.copyOnSelect}
            onChange={(copyOnSelect) => setOptions({ copyOnSelect })}
          />
        ) : null}
      </Group>

      <Group title="Agents">
        {shown.row('Ask Before Stopping Agents') ? (
          <CheckField
            id="settings-confirm-stop-agent"
            label="Ask Before Stopping Agents"
            checked={stopAgent}
            onChange={(on) => setConfirmation('stopAgent', on)}
          />
        ) : null}

        {shown.row('Keep Agents Running When teamree Quits') ? <KeepPanesField runtime={runtime} /> : null}
      </Group>
      {runtime.problem === null ? null : <p className="settings-error">{runtime.problem}</p>}
    </section>
  )
}

/** The switch, what it does not cover, and the host it leaves running; see `paneHostLines`. */
function KeepPanesField({ runtime }: { runtime: RuntimeSettingsState }): React.JSX.Element {
  const host = usePaneHostStatus()
  const keeping = runtime.settings?.keepPanesRunning ?? false
  const lines = paneHostLines(host.status, keeping)
  const below =
    lines.ending === null && lines.host === null && host.problem === null ? null : (
      <>
        {lines.ending === null ? null : (
          <div className="settings-row">
            <p className="settings-note">{lines.ending}</p>
            {lines.move === null ? null : (
              <button type="button" className="button button--small" disabled={host.pending} onClick={host.keepShells}>
                {lines.move}
              </button>
            )}
          </div>
        )}
        {lines.host === null ? null : (
          <div className="settings-row">
            <p className="settings-note">{lines.host}</p>
            <button type="button" className="button button--small" disabled={host.pending} onClick={host.stop}>
              Stop Host
            </button>
          </div>
        )}
        {host.problem === null ? null : <p className="settings-error">{host.problem}</p>}
      </>
    )
  return (
    <Field label="Keep Agents Running When teamree Quits" htmlFor="settings-keep-panes" below={below}>
      <Switch
        id="settings-keep-panes"
        checked={keeping}
        disabled={runtime.settings === null}
        onChange={(keepPanesRunning) => runtime.change({ keepPanesRunning })}
      />
    </Field>
  )
}

/** The program new panes start in; empty, the login shell, which the placeholder names. */
function ShellField(): React.JSX.Element {
  const machine = useContext(MachineContext)
  const shown = useShown()
  const [problem, setProblem] = useState<string | null>(null)
  const own = machine.settings?.shell ?? ''
  const draft = useDraft(own, (shell) => {
    setProblem(null)
    machine.save({ shell }).catch((error: unknown) => setProblem(reasonFor(error)))
  })
  return (
    <Field
      label="Shell"
      htmlFor="settings-shell"
      below={problem === null ? null : <p className="settings-error">{problem}</p>}
    >
      <input
        id="settings-shell"
        className="settings-input settings-input--command"
        type="text"
        placeholder={machine.settings?.shellFallback ?? ''}
        aria-invalid={problem !== null}
        {...hitMark(shown, [own])}
        {...draft}
      />
    </Field>
  )
}

/** How reviews open: the defaults the diff toolbar changes too. */
function GitSection(): React.JSX.Element {
  const layout = useWorkspaceStore((state) => state.diffLayout)
  const setDiffLayout = useWorkspaceStore((state) => state.setDiffLayout)
  const options = useWorkspaceStore((state) => state.diffOptions)
  const toggleDiffOption = useWorkspaceStore((state) => state.toggleDiffOption)
  const machine = useContext(MachineContext)
  const shown = useShown()

  return (
    <section className="settings-section" aria-labelledby="settings-git">
      <SectionTitle id="git" text="Git" />
      <Group title="Fetch">
        {shown.row('Fetch every') ? (
          <ChoiceField
            id="settings-fetch-every"
            label="Fetch every"
            value={String(machine.settings?.fetchMinutes ?? DEFAULT_FETCH_MINUTES)}
            choices={FETCH_CHOICES}
            onChange={(minutes) => machine.change({ fetchMinutes: Number(minutes) })}
          />
        ) : null}
      </Group>
      <Group title="Diffs">
        {shown.row('Diff layout') ? (
          <ChoiceField
            id="settings-diff-layout"
            label="Diff layout"
            value={layout}
            choices={DIFF_LAYOUTS}
            onChange={setDiffLayout}
          />
        ) : null}
        {shown.row('Wrap Diff Lines') ? (
          <CheckField
            id="settings-diff-wrap"
            label="Wrap Diff Lines"
            checked={options.wrap}
            onChange={() => toggleDiffOption('wrap')}
          />
        ) : null}
        {shown.row('Hide Whitespace Changes') ? (
          <CheckField
            id="settings-diff-whitespace"
            label="Hide Whitespace Changes"
            checked={options.hideWhitespace}
            onChange={() => toggleDiffOption('hideWhitespace')}
          />
        ) : null}
      </Group>
    </section>
  )
}

/** The chords, read only: the same table the key handler and Help read. */
function ShortcutsSection({ modifier }: { modifier: PlatformModifier }): React.JSX.Element {
  const rows = useShortcutRows(modifier)
  const shown = useShown()
  const groups = [...new Set(rows.map((row) => row.group))]

  return (
    <section className="settings-section" aria-labelledby="settings-shortcuts">
      <SectionTitle id="shortcuts" text="Shortcuts" />
      {groups.map((group) => {
        const kept = rows.filter((row) => row.group === group && shown.row(row.label))
        return kept.length === 0 ? null : (
          <div className="settings-card" key={group}>
            <h3 className="settings-card__title">{group}</h3>
            <ul className="settings-group settings-keys" aria-label={group}>
              {kept.map((row) => (
                <li className="settings-key" key={row.label}>
                  <span>
                    <Marked text={row.label} />
                  </span>
                  <kbd className="settings-key__chord">
                    <Marked text={row.chord} />
                  </kbd>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </section>
  )
}

/** A label and its switch: the page's one shape for an on/off setting. */
function CheckField({
  id,
  label,
  checked,
  disabled = false,
  onChange
}: {
  id: string
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <Field label={label} htmlFor={id}>
      <Switch id={id} checked={checked} disabled={disabled} onChange={onChange} />
    </Field>
  )
}

/** A label and a picker over a fixed set of values. */
function ChoiceField<T extends string>({
  id,
  label,
  value,
  choices,
  onChange,
  children
}: {
  id: string
  label: string
  value: T
  choices: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  /** Beside the picker, e.g. a button that tries the setting. */
  children?: React.ReactNode
}): React.JSX.Element {
  const shown = useShown()
  return (
    <Field label={label} htmlFor={id}>
      {children}
      <Select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        {...hitMark(
          shown,
          choices.map((choice) => choice.label)
        )}
      >
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </Select>
    </Field>
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
 * Which agent you always use, what you pass it, whether new worktrees get the main checkout's
 * folder trust, and whether agents hear about sibling overlaps; per machine, shown once the probe found one.
 */
function AgentsSection(): React.JSX.Element | null {
  const rows = useAgentRows()
  const agents = rows.filter((row) => row.command !== null)
  const defaultAgent = useWorkspaceStore((state) => state.defaultAgent)
  const setDefaultAgent = useWorkspaceStore((state) => state.setDefaultAgent)
  const trustNewWorktrees = useWorkspaceStore((state) => state.trustNewWorktrees)
  const setTrustNewWorktrees = useWorkspaceStore((state) => state.setTrustNewWorktrees)
  const runtime = useRuntimeSettings()
  const shown = useShown()

  if (rows.length === 0) return null
  const choices = ['First found', ...agents.map((agent) => harnessName(agent.kind))]

  return (
    <section className="settings-section" aria-labelledby="settings-agents">
      <SectionTitle id="agents" text="Agents" />
      <Group title="Launch">
        {shown.row('Default agent') ? (
          <Field label="Default agent" htmlFor="settings-default-agent">
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
          </Field>
        ) : null}

        {rows
          .filter((row) => shown.row(harnessName(row.kind)))
          .map((row) => (
            <AgentArguments key={row.kind} agent={row} />
          ))}
      </Group>

      <Group title="Worktrees">
        {shown.row('Trust New Worktrees') ? (
          <CheckField
            id="settings-trust-worktrees"
            label="Trust New Worktrees"
            checked={trustNewWorktrees}
            onChange={(trust) => void setTrustNewWorktrees(trust)}
          />
        ) : null}

        {shown.row('Warn Agents About Overlaps') ? (
          <CheckField
            id="settings-warn-overlaps"
            label="Warn Agents About Overlaps"
            checked={runtime.settings?.warnAgentsAboutOverlaps ?? true}
            disabled={runtime.settings === null}
            onChange={(warnAgentsAboutOverlaps) => runtime.change({ warnAgentsAboutOverlaps })}
          />
        ) : null}
      </Group>
      {runtime.problem === null ? null : <p className="settings-error">{runtime.problem}</p>}
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
      <div className="settings-field__text">
        <label className="settings-field__label settings-agent" htmlFor={id}>
          <AgentGlyph kind={agent.kind} decorative />
          <Marked text={harnessName(agent.kind)} />
        </label>
      </div>
      <div className="settings-field__control">
        <input
          id={id}
          className="settings-input settings-input--command"
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
      </div>
      {agent.command === null ? (
        <p className="settings-field__below settings-launch settings-launch--missing">Not found</p>
      ) : draft.trim() === '' ? null : (
        <code className="settings-field__below settings-launch">
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
      <SectionTitle id="appearance" text="Appearance" />
      <Group>
        <Field label="Theme" wide>
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
        </Field>
      </Group>
    </section>
  )
}

/** One project at a time, picked above its settings; under a filter, every project holding a match. */
function ProjectsSection({ projects }: { projects: readonly Project[] }): React.JSX.Element {
  const shown = useShown()
  const projectRows = useProjectRows(useContext(MachineContext).settings)
  const [picked, pick] = useState<string | null>(null)
  const filtering = shown.query.trim() !== ''
  const named = (project: Project): Shown => {
    const own = shownUnder(project.name, shown.query, projectRows(project))
    return shown.whole ? { ...own, whole: true, row: () => true } : own
  }
  const current = projects.find((project) => project.id === picked) ?? projects[0]
  const listed = filtering
    ? projects.filter(
        (project) => named(project).whole || projectRows(project).some((row) => rowMatches(row, shown.query))
      )
    : projects.filter((project) => project === current)
  return (
    <section className="settings-section" aria-labelledby="settings-projects">
      <SectionTitle id="projects" text="Projects" />
      {projects.length === 0 ? (
        <Group>
          <p className="settings-note">No repositories yet</p>
        </Group>
      ) : null}
      {!filtering && projects.length > 1 ? (
        <div className="settings-picker" role="group" aria-label="Project">
          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              className="settings-picker__item"
              aria-pressed={project === current}
              onClick={() => pick(project.id)}
            >
              {project.name}
            </button>
          ))}
        </div>
      ) : null}
      {listed.map((project) => (
        <ShownContext.Provider key={project.id} value={named(project)}>
          <ProjectBlock project={project} />
        </ShownContext.Provider>
      ))}
    </section>
  )
}

function ProjectBlock({ project }: { project: Project }): React.JSX.Element {
  const revealInFinder = useWorkspaceStore((state) => state.revealInFinder)
  const saveProjectSettings = useWorkspaceStore((state) => state.saveProjectSettings)
  const shown = useShown()

  return (
    <article className="settings-project">
      <header className="settings-project__head">
        <div className="settings-project__identity">
          <h3 className="settings-project__name">
            <Marked text={project.name} />
          </h3>
          <PathText path={project.path} className="settings-project__path" />
        </div>
        <div className="settings-actions">
          <button type="button" className="button button--small" onClick={() => void saveProjectSettings(project.id)}>
            Save to Repository
          </button>
          <button
            type="button"
            className="button button--small"
            onClick={() => void revealInFinder(project.path, `the ${project.name} repository`)}
          >
            Reveal in Finder
          </button>
        </div>
      </header>
      {project.repositoryProblem === undefined ? null : <p className="settings-warning">{project.repositoryProblem}</p>}

      <Group title="Worktrees">
        {shown.row('Start new worktrees from') ? <StartPoint project={project} /> : null}
        <ProjectWorktrees project={project} />
        {shown.row('Fetch in Background') ? <FetchInBackground project={project} /> : null}
      </Group>
      <Group title="Files & commands">
        <CarriedPaths project={project} />
      </Group>
      <Group title="Open">
        {shown.row('Open checkouts in') ? <EditorCommand editorKey={project.id} label="Open checkouts in" /> : null}
        {shown.row('Relay') ? <RelayBlock project={project} /> : null}
      </Group>
    </article>
  )
}

/** This project's worktrees folder and branch prefix, over General's; each saved as the runtime answers. */
function ProjectWorktrees({ project }: { project: Project }): React.JSX.Element {
  const machine = useContext(MachineContext).settings
  const shown = useShown()
  const save = async (changes: Omit<ParamsOf<'project.setPaths'>, 'projectId'>): Promise<void> => {
    const saved = await runtimeClient.call('project.setPaths', { projectId: project.id, ...changes })
    useWorkspaceStore.setState((state) => ({
      projects: state.projects.map((row) => (row.id === saved.id ? saved : row))
    }))
  }
  return (
    <>
      {shown.row('Worktrees in') ? (
        <WorktreesIn
          own={project.worktreesRoot}
          applied={project.worktreesRoot ?? machineRoot(machine)}
          source={<OverrideChip own={project.worktreesRoot !== undefined} />}
          save={(worktreesRoot, allowInsideRepository) =>
            save({ worktreesRoot, ...(allowInsideRepository ? { allowInsideRepository } : {}) })
          }
        />
      ) : null}
      {shown.row('Branch prefix') ? (
        <BranchPrefix
          id={`settings-branch-prefix-${project.id}`}
          own={project.branchPrefix ?? ''}
          inherited={machine?.branchPrefix ?? ''}
          source={<OverrideChip own={(project.branchPrefix ?? '') !== ''} />}
          save={(branchPrefix) => save({ branchPrefix })}
        />
      ) : null}
    </>
  )
}

/** Under a project row that shares General's label: whose value is in effect. */
function OverrideChip({ own }: { own: boolean }): React.JSX.Element {
  return (
    <div className="settings-source">
      <span className={`settings-chip${own ? ' settings-chip--local' : ''}`}>
        {own ? 'This project' : 'From General'}
      </span>
    </div>
  )
}

/** Whether this project's base ref is fetched on a timer and on window focus. */
function FetchInBackground({ project }: { project: Project }): React.JSX.Element {
  const setProjectPaths = useWorkspaceStore((state) => state.setProjectPaths)
  return (
    <CheckField
      id={`settings-fetch-${project.id}`}
      label="Fetch in Background"
      checked={project.fetchInBackground !== false}
      onChange={(fetchInBackground) => void setProjectPaths(project.id, { fetchInBackground })}
    />
  )
}

/** Which ref the New task dialog offers first: the ref in effect as text, a field only after Change. */
function StartPoint({ project }: { project: Project }): React.JSX.Element {
  const stored = useWorkspaceStore((state) => state.startPointDefaults[project.id] ?? '')
  const setStartPointDefault = useWorkspaceStore((state) => state.setStartPointDefault)
  const [draft, setDraft] = useState<string | null>(null)
  const applied = startPointOf(project, stored)
  const shared = project.repository?.startFrom

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
    <Field
      label="Start new worktrees from"
      htmlFor={draft === null ? undefined : id}
      source={
        <SettingSource
          local={stored || undefined}
          repository={shared}
          onReset={() => setStartPointDefault(project.id, null)}
        />
      }
    >
      {draft === null ? (
        <>
          <code className="settings-value settings-value--mono">
            <Marked text={applied} />
          </code>
          {stored.length === 0 || shared !== undefined ? null : (
            <button
              type="button"
              className="button button--small"
              onClick={() => setStartPointDefault(project.id, null)}
            >
              Use {project.baseRef}
            </button>
          )}
          <button type="button" className="button button--small" onClick={() => setDraft(applied)}>
            Change
          </button>
        </>
      ) : (
        <input
          id={id}
          className="settings-input"
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
    </Field>
  )
}

/**
 * Where a value comes from when the repository carries one: `Repository`, or `This Mac` with Reset,
 * which hands the field back to `.teamree/project.json`. Nothing for a value the file does not carry.
 */
function SettingSource({
  local,
  repository,
  onReset
}: {
  local: string | readonly string[] | undefined
  repository: string | readonly string[] | undefined
  onReset: () => void
}): React.JSX.Element | null {
  const source = settingSource(local, repository)
  if (source === null) return null
  return (
    <div className="settings-source">
      <span className={`settings-chip${source === 'local' ? ' settings-chip--local' : ''}`}>
        {source === 'local' ? 'This Mac' : 'Repository'}
      </span>
      {source === 'local' ? (
        <button type="button" className="settings-source__reset" onClick={onReset}>
          Reset
        </button>
      ) : null}
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
          repository={project.repository?.linkedPaths}
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
          repository={project.repository?.copiedPaths}
          save={(copiedPaths) => void setProjectPaths(project.id, { copiedPaths })}
        />
      ) : null}
      {shown.row('Setup command') ? <SetupCommand project={project} /> : null}
      {RUN_KINDS.map((kind) =>
        shown.row(RUN_SETTING[kind]) ? <RunCommand key={kind} project={project} kind={kind} /> : null
      )}
    </>
  )
}

/** The one setup command a new worktree runs, stored and typed into the pane verbatim. */
function SetupCommand({ project }: { project: Project }): React.JSX.Element {
  const setProjectPaths = useWorkspaceStore((state) => state.setProjectPaths)
  return (
    <CommandField
      id={`settings-setup-${project.id}`}
      label="Setup command"
      example="npm ci"
      local={project.setupCommand}
      shared={project.repository?.setupCommand}
      detected={project.suggestedSetup}
      save={(setupCommand) => void setProjectPaths(project.id, { setupCommand })}
    />
  )
}

/** What Run Dev or Run Tests starts in a worktree of this project. */
function RunCommand({ project, kind }: { project: Project; kind: RunKind }): React.JSX.Element {
  const setProjectPaths = useWorkspaceStore((state) => state.setProjectPaths)
  return (
    <CommandField
      id={`settings-run-${kind}-${project.id}`}
      label={RUN_SETTING[kind]}
      example={kind === 'dev' ? 'npm run dev' : 'npm test'}
      local={project.runCommands?.[kind]}
      shared={project.repository?.runCommands?.[kind]}
      detected={project.detectedRun?.[kind]}
      save={(command) => void setProjectPaths(project.id, { runCommands: { [kind]: command } })}
    />
  )
}

const RUN_SETTING: Record<RunKind, string> = { dev: 'Dev command', test: 'Test command' }

/** One command, written on blur or Enter; emptied, it falls back to the repository's and says so. */
function CommandField({
  id,
  label,
  example,
  local,
  shared,
  detected,
  save
}: {
  id: string
  label: string
  example: string
  local: string | undefined
  shared: string | undefined
  detected: string | undefined
  save: (command: string) => void
}): React.JSX.Element {
  const shown = useShown()
  const stored = local ?? shared ?? ''
  const [draft, setDraft] = useState(stored)

  useEffect(() => {
    setDraft(stored)
  }, [stored])

  const commit = (): void => {
    const next = draft.trim()
    if (next === stored) return
    if (next === '' && shared !== undefined) setDraft(shared)
    save(next)
  }

  return (
    <Field
      label={label}
      htmlFor={id}
      source={<SettingSource local={local} repository={shared} onReset={() => save('')} />}
    >
      <input
        id={id}
        className="settings-input"
        type="text"
        value={draft}
        placeholder={detected === undefined ? 'None' : `None · ${detected} detected`}
        title={`e.g. ${example}`}
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
    </Field>
  )
}

/** One path per line, written on blur: half a path is a path that does not exist. */
function PathList({
  project,
  id,
  label,
  examples,
  paths,
  repository,
  save
}: {
  project: Project
  id: string
  label: string
  /** Shown on hover, never in the field, where an example reads as a value. */
  examples: string
  /** This Mac's list; `repository` is `.teamree/project.json`'s, shown when there is none here. */
  paths: readonly string[] | undefined
  repository: readonly string[] | undefined
  save: (paths: string[]) => void
}): React.JSX.Element {
  const stored = (paths ?? repository ?? []).join('\n')
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
    if (next.length === 0 && repository !== undefined) setDraft(repository.join('\n'))
    save(next)
  }

  const fieldId = `settings-${id}-paths-${project.id}`

  return (
    <Field
      label={label}
      htmlFor={fieldId}
      hint="One per line"
      source={<SettingSource local={paths} repository={repository} onReset={() => save([])} />}
    >
      <textarea
        id={fieldId}
        className="settings-input settings-input--lines"
        rows={2}
        value={draft}
        placeholder="None"
        title={`One per line, e.g. ${examples}`}
        {...hitMark(shown, paths ?? repository ?? [])}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
      />
    </Field>
  )
}

/** The picker's value for a program typed in rather than picked. */
const OTHER_EDITOR = 'other'

/**
 * Which editor a project's checkouts open in (`ANY_PROJECT`: every project naming none): one found, or a
 * program named in the field. A program name, not a command line: it is spawned without a shell.
 */
function EditorCommand({ editorKey, label }: { editorKey: string; label: string }): React.JSX.Element {
  const commands = useWorkspaceStore((state) => state.editorCommands)
  const found = useWorkspaceStore((state) => state.editors)
  const setEditorCommand = useWorkspaceStore((state) => state.setEditorCommand)
  const { editors, first, stored, words } = editorPicker(editorKey, commands, found)
  const [draft, setDraft] = useState(stored)
  const [typing, setTyping] = useState(false)
  const shown = useShown()

  useEffect(() => {
    setDraft(stored)
  }, [stored])

  const named = stored.length > 0 && !editors.some((editor) => editor.command === stored)
  const other = typing || named

  const commit = (): void => {
    const next = draft.trim()
    if (next === stored) return
    setEditorCommand(editorKey, next.length === 0 ? null : next)
  }

  const id = `settings-editor-${editorKey === ANY_PROJECT ? 'default' : editorKey}`

  return (
    <Field label={label} htmlFor={id}>
      <div className="settings-stack">
        <Select
          id={id}
          value={other ? OTHER_EDITOR : stored}
          onChange={(event) => {
            const value = event.target.value
            setTyping(value === OTHER_EDITOR)
            if (value === OTHER_EDITOR) setDraft(named ? stored : '')
            else setEditorCommand(editorKey, value.length === 0 ? null : value)
          }}
          {...hitMark(shown, words.slice(0, -1))}
        >
          <option value="">{first}</option>
          {editors.map((editor) => (
            <option key={editor.command} value={editor.command}>
              {editor.label}
            </option>
          ))}
          <option value={OTHER_EDITOR}>Other…</option>
        </Select>
        {other ? (
          <input
            className="settings-input"
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
    </Field>
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
    <Field
      label="Relay"
      heading
      wide
      below={
        panel.detail || panel.override ? (
          <>
            {panel.detail ? <p className="settings-note">{panel.detail}</p> : null}
            {panel.override ? <p className="settings-warning">{panel.override}</p> : null}
          </>
        ) : null
      }
    >
      <p className={panel.empty ? 'settings-fact settings-fact--none' : 'settings-fact settings-fact--value'}>
        <Marked text={panel.headline} />
      </p>
      <button type="button" className="button button--small" onClick={() => openTeamwork(project.id)}>
        Open Teamwork
      </button>
    </Field>
  )
}
