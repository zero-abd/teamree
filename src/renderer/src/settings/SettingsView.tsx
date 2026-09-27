// The settings page: machine-level facts (PATH, updates, text size, checkouts), so it takes the main
// area rather than a drawer. Colours and relays are read here and set where they already live.

import { createContext, Fragment, useContext, useEffect, useRef, useState } from 'react'
import { agentLaunchCommand } from '@shared/agentLaunch'
import { branchPrefixFor } from '@shared/branchName'
import type { Project, RunKind } from '@shared/entities'
import type { ParamsOf } from '@shared/methods'
import { RUN_KINDS } from '@shared/runCommands'
import { DEFAULT_FETCH_MINUTES, type RuntimeSettings } from '@shared/settings'
import { effectiveProjectSettings, settingSource, startPointOf } from '@shared/projectSettings'
import { AgentGlyph } from '../agents/glyphs'
import { harnessName } from '../agents/harnesses'
import { cliOutcome } from '../dialogs/cliInstallModel'
import { Select } from '../dialogs/Select'
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
import { useNow } from '../state/useNow'
import { useWorkspaceStore } from '../state/workspaceStore'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { InstallerButton } from '../updates/InstallerButton'
import { installerStep } from '../updates/updateNotice'
import { PageFrame } from '../workspace/PageFrame'
import { activeChoice, BUILT_IN_THEMES, themeById } from '@shared/theme'
import { APPEARANCE_MODE_LABEL } from './AppearanceSettings'
import { useRuntimeSettings, type RuntimeSettingsState } from './runtimeSettings'
import { SavedCommandsSetting } from './SavedCommandsSetting'
import { SAVED_COMMANDS_SETTING } from '../workspace/SavedCommands'
import { useUsageStore } from '../state/usageStore'
import {
  agentRows,
  cliLine,
  describedOnly,
  firstMatch,
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
      { label: SAVED_COMMANDS_SETTING, words: (applied.savedCommands ?? []).map((command) => command.label) },
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
    updates: [{ label: 'Check Automatically', words: [] }],
    cli: [{ label: 'teamree command', words: [] }]
  }
}

/** A heading this close to the top of the scrolling body counts as the section in view. */
const IN_VIEW_PX = 48

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
    flash(section)
    useWorkspaceStore.setState({ settingsSection: null })
  }, [section])

  // The palette's Open Setting: the filter holds its label and its section is rung once shown.
  const asked = useWorkspaceStore((state) => state.settingsQuery)
  const ring = useRef<SectionId | null>(null)
  useEffect(() => {
    if (asked === null) return
    ring.current = firstMatch(asked)?.section ?? null
    setQuery(asked)
    useWorkspaceStore.setState({ settingsQuery: null })
  }, [asked])

  // Each new filter starts at its first section, so a match below the fold is not missed.
  const first = sections[0]?.id
  useEffect(() => {
    if (query.trim() === '' || first === undefined) return
    document.getElementById(`settings-${first}`)?.scrollIntoView?.({ block: 'start' })
    setActive(first)
    if (ring.current !== null) flash(ring.current)
    ring.current = null
  }, [query])

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
          <MachineContext.Provider value={machine}>
            {sections.map((entry) => (
              <ShownContext.Provider key={entry.id} value={shownUnder(entry.label, query, rowsOf(entry.id))}>
                <SectionBody id={entry.id} projects={projects} modifier={modifier} />
              </ShownContext.Provider>
            ))}
          </MachineContext.Provider>
        </div>
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
    case 'updates':
      return <UpdatesSection />
    case 'cli':
      return <CliSection />
  }
}

function atBottom(scroller: HTMLElement): boolean {
  return scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1
}

/** Rings a section's rows for a moment, so the one asked for is found on a long page. */
function flash(id: SectionId): void {
  const group = document
    .getElementById(`settings-${id}`)
    ?.closest('.settings-section')
    ?.querySelector('.settings-group')
  group?.animate?.([{ boxShadow: '0 0 0 2px var(--accent)' }, { boxShadow: '0 0 0 2px transparent' }], {
    duration: 1600,
    easing: 'ease-out'
  })
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
      </div>
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
      <h2 className="settings-section__title" id="settings-general" tabIndex={-1}>
        <Marked text="General" />
      </h2>
      <div className="settings-group">
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
        {show.row('Keep Awake') ? (
          <ChoiceField
            id="settings-keep-awake"
            label="Keep Awake"
            value={keepAwake}
            choices={KEEP_AWAKE_CHOICES}
            onChange={setKeepAwake}
          />
        ) : null}
        {show.row('Default editor') ? <EditorCommand editorKey={ANY_PROJECT} label="Default editor" /> : null}
        {show.row('Ask Before Deleting Worktrees') ? (
          <CheckField
            id="settings-confirm-remove"
            label="Ask Before Deleting Worktrees"
            checked={confirmations.removeWorktree}
            onChange={(on) => setConfirmation('removeWorktree', on)}
          />
        ) : null}
        {machine.problem === null ? null : <p className="settings-error">{machine.problem}</p>}
      </div>
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
  save
}: {
  own: string | undefined
  applied: string
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
    <div className="settings-field">
      <span className="settings-field__label">
        <Marked text="Worktrees in" />
      </span>
      <div className="settings-field__row">
        <code className="settings-value settings-value--mono settings-value--path">
          <Marked text={applied} />
        </code>
        <button type="button" className="button button--small" disabled={applied === ''} onClick={() => void choose()}>
          Choose…
        </button>
        <button
          type="button"
          className="button button--small"
          disabled={applied === ''}
          onClick={() => void revealInFinder(applied, 'the worktrees folder')}
        >
          Reveal
        </button>
        {own === undefined ? null : (
          <button type="button" className="button button--small" onClick={() => void attempt('')}>
            Reset
          </button>
        )}
      </div>
      {problem === null ? null : (
        <p className="settings-error">
          {problem.message}
          {problem.inside ? (
            <>
              {' '}
              <button type="button" className="button button--small" onClick={() => void attempt(problem.folder, true)}>
                Use Anyway
              </button>
            </>
          ) : null}
        </p>
      )}
    </div>
  )
}

/** Leads the branch names teamree picks; `inherited` is the prefix in effect while this one is empty. */
function BranchPrefix({
  id,
  own,
  inherited,
  save
}: {
  id: string
  own: string
  inherited: string
  save: (prefix: string) => Promise<unknown>
}): React.JSX.Element {
  const shown = useShown()
  const [problem, setProblem] = useState<string | null>(null)
  const draft = useDraft(own, (prefix) => {
    setProblem(null)
    save(prefix).catch((error: unknown) => setProblem(reasonFor(error)))
  })
  return (
    <div className="settings-field">
      <label className="settings-field__label" htmlFor={id}>
        <Marked text="Branch prefix" />
      </label>
      <input
        id={id}
        className={`settings-field__input settings-field__input--short${
          inherited ? ' settings-field__input--command' : ''
        }`}
        type="text"
        placeholder={inherited || 'None'}
        aria-invalid={problem !== null}
        {...hitMark(shown, [own])}
        {...draft}
      />
      {problem === null ? null : <p className="settings-error">{problem}</p>}
    </div>
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
      <h2 className="settings-section__title" id="settings-notices" tabIndex={-1}>
        <Marked text="Notifications" />
      </h2>
      <div className="settings-group">
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
      </div>
    </section>
  )
}

/** What teammates' presence carries from this machine. */
function TeamworkSection(): React.JSX.Element {
  const { settings, problem, change } = useRuntimeSettings()
  return (
    <section className="settings-section" aria-labelledby="settings-teamwork">
      <h2 className="settings-section__title" id="settings-teamwork" tabIndex={-1}>
        <Marked text="Teamwork" />
      </h2>
      <div className="settings-group">
        <CheckField
          id="settings-share-task-details"
          label="Share Task Details"
          checked={settings?.shareTaskDetails ?? true}
          disabled={settings === null}
          onChange={(shareTaskDetails) => change({ shareTaskDetails })}
        />
        {problem === null ? null : <p className="settings-error">{problem}</p>}
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

        {shown.row('Line height') ? (
          <div className="settings-field">
            <label className="settings-field__label" htmlFor="settings-line-height">
              <Marked text="Line height" />
            </label>
            <input
              id="settings-line-height"
              className="settings-field__input settings-field__input--number"
              type="number"
              min={TERMINAL_LINE_HEIGHT_MIN}
              max={TERMINAL_LINE_HEIGHT_MAX}
              step={0.05}
              {...lineHeight}
              {...hitMark(shown, [String(options.lineHeight)])}
            />
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

        {shown.row('Shell') ? <ShellField /> : null}

        {shown.row('Ask Before Stopping Agents') ? (
          <CheckField
            id="settings-confirm-stop-agent"
            label="Ask Before Stopping Agents"
            checked={stopAgent}
            onChange={(on) => setConfirmation('stopAgent', on)}
          />
        ) : null}

        {shown.row('Keep Agents Running When teamree Quits') ? (
          <div className="settings-field">
            <label className="settings-field__label" htmlFor="settings-keep-panes">
              <Marked text="Keep Agents Running When teamree Quits" />
            </label>
            <input
              id="settings-keep-panes"
              className="settings-field__check"
              type="checkbox"
              checked={runtime.settings?.keepPanesRunning ?? false}
              disabled={runtime.settings === null}
              onChange={(event) => runtime.change({ keepPanesRunning: event.target.checked })}
            />
          </div>
        ) : null}
        {runtime.problem === null ? null : <p className="settings-error">{runtime.problem}</p>}
      </div>
    </section>
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
    <div className="settings-field">
      <label className="settings-field__label" htmlFor="settings-shell">
        <Marked text="Shell" />
      </label>
      <input
        id="settings-shell"
        className="settings-field__input settings-field__input--command"
        type="text"
        placeholder={machine.settings?.shellFallback ?? ''}
        aria-invalid={problem !== null}
        {...hitMark(shown, [own])}
        {...draft}
      />
      {problem === null ? null : <p className="settings-error">{problem}</p>}
    </div>
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
      <h2 className="settings-section__title" id="settings-git" tabIndex={-1}>
        <Marked text="Git" />
      </h2>
      <div className="settings-group">
        {shown.row('Fetch every') ? (
          <ChoiceField
            id="settings-fetch-every"
            label="Fetch every"
            value={String(machine.settings?.fetchMinutes ?? DEFAULT_FETCH_MINUTES)}
            choices={FETCH_CHOICES}
            onChange={(minutes) => machine.change({ fetchMinutes: Number(minutes) })}
          />
        ) : null}
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
      </div>
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
      <h2 className="settings-section__title" id="settings-shortcuts" tabIndex={-1}>
        <Marked text="Shortcuts" />
      </h2>
      {groups.map((group) => {
        const kept = rows.filter((row) => row.group === group && shown.row(row.label))
        return kept.length === 0 ? null : (
          <Fragment key={group}>
            <h3 className="settings-subhead">{group}</h3>
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
          </Fragment>
        )
      })}
    </section>
  )
}

/** A label and its checkbox: the page's one shape for an on/off setting. */
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
    <div className="settings-field">
      <label className="settings-field__label" htmlFor={id}>
        <Marked text={label} />
      </label>
      <input
        id={id}
        className="settings-field__check"
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </div>
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
  const picker = (
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
  )
  return (
    <div className="settings-field">
      <label className="settings-field__label" htmlFor={id}>
        <Marked text={label} />
      </label>
      {children === undefined ? (
        picker
      ) : (
        <div className="settings-field__row">
          {picker}
          {children}
        </div>
      )}
    </div>
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
        {runtime.problem === null ? null : <p className="settings-error">{runtime.problem}</p>}
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
  const projectRows = useProjectRows(useContext(MachineContext).settings)
  const named = (project: Project): Shown => {
    const own = shownUnder(project.name, shown.query, projectRows(project))
    return shown.whole ? { ...own, whole: true, row: () => true } : own
  }
  return (
    <section className="settings-section" aria-labelledby="settings-projects">
      <h2 className="settings-section__title" id="settings-projects" tabIndex={-1}>
        <Marked text="Projects" />
      </h2>
      {shown.whole || labelMatches(SAVED_COMMANDS_SETTING, shown.query) ? (
        <div className="settings-group">
          <SavedCommandsSetting />
        </div>
      ) : null}
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
  const saveProjectSettings = useWorkspaceStore((state) => state.saveProjectSettings)
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
      </div>
      {project.repositoryProblem === undefined ? null : <p className="settings-warning">{project.repositoryProblem}</p>}

      {shown.row('Start new worktrees from') ? <StartPoint project={project} /> : null}
      <ProjectWorktrees project={project} />
      {shown.row('Fetch in Background') ? <FetchInBackground project={project} /> : null}
      <CarriedPaths project={project} />
      {shown.row(SAVED_COMMANDS_SETTING) ? <SavedCommandsSetting project={project} /> : null}
      {shown.row('Open checkouts in') ? <EditorCommand editorKey={project.id} label="Open checkouts in" /> : null}
      {shown.row('Relay') ? <RelayBlock project={project} /> : null}
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
          save={(branchPrefix) => save({ branchPrefix })}
        />
      ) : null}
    </>
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
              <Marked text={applied} />
            </code>
            <button type="button" className="button button--small" onClick={() => setDraft(applied)}>
              Change
            </button>
            {stored.length === 0 || shared !== undefined ? null : (
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
      <SettingSource
        local={stored || undefined}
        repository={shared}
        onReset={() => setStartPointDefault(project.id, null)}
      />
    </div>
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
        <button type="button" className="button button--small" onClick={onReset}>
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
    <div className="settings-field">
      <label className="settings-field__label" htmlFor={id}>
        <Marked text={label} />
      </label>
      <input
        id={id}
        className="settings-field__input"
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
      <SettingSource local={local} repository={shared} onReset={() => save('')} />
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
        {...hitMark(shown, paths ?? repository ?? [])}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
      />
      <SettingSource local={paths} repository={repository} onReset={() => save([])} />
    </div>
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
    <div className="settings-field">
      <label className="settings-field__label" htmlFor={id}>
        <Marked text={label} />
      </label>
      <div className="settings-field__row">
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
