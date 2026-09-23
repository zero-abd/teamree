// The settings page: machine-level facts (PATH, updates, text size, checkouts), so it takes the main
// area rather than a drawer. Colours and relays are read here and set where they already live.

import { useEffect, useRef, useState } from 'react'
import { agentLaunchCommand } from '@shared/agentLaunch'
import type { InstalledAgent, Project } from '@shared/entities'
import { cliOutcome } from '../dialogs/cliInstallModel'
import type { PlatformModifier } from '../keyboard/platformModifier'
import { shortcutHint } from '../keyboard/workspaceShortcuts'
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
import { modalOnScreen } from '../dialogs/modalLayer'
import { useWorkspaceStore } from '../state/workspaceStore'
import { InstallerButton } from '../updates/InstallerButton'
import { installerStep } from '../updates/updateNotice'
import { cliLine, relayPanel, updatePanel } from './settingsModel'

const SECTIONS = [
  { id: 'cli', label: 'CLI' },
  { id: 'updates', label: 'Updates' },
  { id: 'notices', label: 'Notifications' },
  { id: 'panes', label: 'Panes' },
  { id: 'agents', label: 'Agents' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'projects', label: 'Projects' }
] as const

type SectionId = (typeof SECTIONS)[number]['id']

/** A heading this close to the top of the scrolling body counts as the section in view. */
const IN_VIEW_PX = 48

export function SettingsView({ modifier }: { modifier: PlatformModifier }): React.JSX.Element {
  const projects = useWorkspaceStore((state) => state.projects)
  const toggleSettings = useWorkspaceStore((state) => state.toggleSettings)
  const loadCli = useWorkspaceStore((state) => state.loadCli)
  const loadUpdate = useWorkspaceStore((state) => state.loadUpdate)
  const hasAgents = useWorkspaceStore((state) => state.agents.length > 0)
  const sections = SECTIONS.filter((entry) => entry.id !== 'agents' || hasAgents)

  // Read again on open: both are facts about the world outside this window that may have moved.
  useEffect(() => {
    void loadCli()
    void loadUpdate()
  }, [loadCli, loadUpdate])

  // Capture phase, so a focused pane cannot eat Escape first.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // Anything modal on top owns Escape. `modalOnScreen`, not `dialog`: a remote-keystrokes
      // question is not in `dialog` and would otherwise have the page close under its scrim.
      if (modalOnScreen(useWorkspaceStore.getState())) return
      event.preventDefault()
      toggleSettings()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [toggleSettings])

  // Opened from a button elsewhere, so focus has to follow; the region, so Tab starts at the top
  // of the page and the page's name is read out.
  const region = useRef<HTMLElement>(null)
  useEffect(() => {
    region.current?.focus()
  }, [])

  const body = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState<SectionId>('cli')
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
    <main className="workspace settings" aria-label="Settings" tabIndex={-1} ref={region}>
      <header className="settings__head">
        <div className="settings__column settings__head-row">
          <div className="settings__identity">
            <h1 className="settings__title">Settings</h1>
          </div>
          <button
            type="button"
            className="settings__close"
            title="Back to the panes"
            aria-label="Back to the panes"
            onClick={toggleSettings}
          >
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="M3 3 L9 9 M9 3 L3 9" />
            </svg>
          </button>
        </div>
      </header>

      <div className="settings__body" ref={body} data-testid="settings-body">
        <div className="settings__layout">
          <SectionList sections={sections} active={active} goTo={goTo} />
          <div className="settings__content">
            <CliSection />
            <UpdatesSection />
            <NoticesSection />
            <PanesSection />
            <AgentsSection />
            <AppearanceSection modifier={modifier} />
            <ProjectsSection projects={projects} />
          </div>
        </div>
      </div>
    </main>
  )
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
    return picked !== null && at !== null && at >= 0 ? picked : (order.at(-1) ?? 'cli')
  }
  let current: SectionId = order[0] ?? 'cli'
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
  active: SectionId
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
        CLI
      </h2>
      <div className="settings-group">
        <div className="settings-row">
          <p className="settings-fact settings-fact--mono">{line.state}</p>
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

  return (
    <section className="settings-section" aria-labelledby="settings-updates">
      <h2 className="settings-section__title" id="settings-updates" tabIndex={-1}>
        Updates
      </h2>
      <div className="settings-group">
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
                {update?.checking ? 'Checking…' : 'Check for updates'}
              </button>
            </div>
          ) : null}
        </div>

        {step !== null && update?.available ? (
          <div className="settings-row">
            <p className="settings-fact">teamree {update.available.version} available</p>
            <InstallerButton step={step} className="button button--small" />
          </div>
        ) : null}
        {step?.problem ? <p className="settings-error">{step.problem}</p> : null}

        {panel.offersCheck ? (
          <label className="settings-check">
            <input
              type="checkbox"
              checked={update?.automatic ?? false}
              onChange={(event) => void setAutomaticUpdates(event.target.checked)}
            />
            {/* Half a minute after startup, then every six hours; a label is not the place for a schedule. */}
            <span>Check automatically</span>
          </label>
        ) : null}

        {/* Kept beside the button that tried rather than raised as a notice. */}
        {panel.problem ? <p className="settings-warning">{panel.problem}</p> : null}
      </div>
    </section>
  )
}

/** What an agent that has stopped may do when you are not looking at the window. */
function NoticesSection(): React.JSX.Element {
  const agentNotices = useWorkspaceStore((state) => state.agentNotices)
  const setAgentNotices = useWorkspaceStore((state) => state.setAgentNotices)

  return (
    <section className="settings-section" aria-labelledby="settings-notices">
      <h2 className="settings-section__title" id="settings-notices" tabIndex={-1}>
        Notifications
      </h2>
      <div className="settings-group">
        <div className="settings-field">
          <label className="settings-field__label" htmlFor="settings-agent-notices">
            When an agent stops
          </label>
          <select
            id="settings-agent-notices"
            className="settings-select"
            value={agentNotices}
            onChange={(event) => setAgentNotices(event.target.value as AgentNoticePreference)}
          >
            <option value="off">Nothing</option>
            <option value="notify">Notify</option>
            <option value="sound">Notify with sound</option>
          </select>
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

  return (
    <section className="settings-section" aria-labelledby="settings-panes">
      <h2 className="settings-section__title" id="settings-panes" tabIndex={-1}>
        Panes
      </h2>
      <div className="settings-group">
        <div className="settings-field">
          <label className="settings-field__label" htmlFor="settings-font-size">
            Terminal text size
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
              {terminalFontSize}px
            </output>
          </div>
        </div>

        <div className="settings-field">
          <label className="settings-field__label" htmlFor="settings-font">
            Font
          </label>
          <input id="settings-font" className="settings-field__input" type="text" {...font} />
          {/* The draft, not the stored value: the point is to see a face before keeping it. */}
          <div
            className="settings-font-preview"
            data-testid="settings-font-preview"
            style={{ fontFamily: font.value, fontSize: terminalFontSize }}
          >
            ~/repo $ git status 0O 1lI {'{}'} =&gt; !=
          </div>
        </div>

        <div className="settings-field">
          <label className="settings-field__label" htmlFor="settings-cursor">
            Cursor
          </label>
          <div className="settings-field__row">
            <select
              id="settings-cursor"
              className="settings-select"
              value={options.cursorStyle}
              onChange={(event) => setOptions({ cursorStyle: event.target.value as TerminalCursorStyle })}
            >
              <option value="bar">Bar</option>
              <option value="block">Block</option>
              <option value="underline">Underline</option>
            </select>
            <label className="settings-check">
              <input
                type="checkbox"
                checked={options.cursorBlink}
                onChange={(event) => setOptions({ cursorBlink: event.target.checked })}
              />
              <span>Blink</span>
            </label>
          </div>
        </div>

        <div className="settings-field">
          <label className="settings-field__label" htmlFor="settings-option-meta">
            Option as Meta
          </label>
          <input
            id="settings-option-meta"
            className="settings-field__check"
            type="checkbox"
            checked={options.optionIsMeta}
            onChange={(event) => setOptions({ optionIsMeta: event.target.checked })}
          />
        </div>

        <div className="settings-field">
          <label className="settings-field__label" htmlFor="settings-copy-on-select">
            Copy on select
          </label>
          <input
            id="settings-copy-on-select"
            className="settings-field__check"
            type="checkbox"
            checked={options.copyOnSelect}
            onChange={(event) => setOptions({ copyOnSelect: event.target.checked })}
          />
        </div>

        <div className="settings-field">
          <label className="settings-field__label" htmlFor="settings-scrollback">
            Scrollback lines
          </label>
          <input
            id="settings-scrollback"
            className="settings-field__input settings-field__input--number"
            type="number"
            min={TERMINAL_SCROLLBACK_MIN}
            max={TERMINAL_SCROLLBACK_MAX}
            step={1000}
            {...scrollback}
          />
        </div>
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
 * Which agent you always use and what you pass it; per machine, shown only when the probe found one.
 * Nothing is seeded: no autonomy flag is pre-applied by default.
 */
function AgentsSection(): React.JSX.Element | null {
  const agents = useWorkspaceStore((state) => state.agents)
  const defaultAgent = useWorkspaceStore((state) => state.defaultAgent)
  const setDefaultAgent = useWorkspaceStore((state) => state.setDefaultAgent)

  if (agents.length === 0) return null

  return (
    <section className="settings-section" aria-labelledby="settings-agents">
      <h2 className="settings-section__title" id="settings-agents" tabIndex={-1}>
        Agents
      </h2>
      <div className="settings-group">
        <div className="settings-field">
          <label className="settings-field__label" htmlFor="settings-default-agent">
            Default agent
          </label>
          <select
            id="settings-default-agent"
            className="settings-select"
            value={defaultAgent}
            onChange={(event) => setDefaultAgent(event.target.value)}
          >
            {/* No preference is the rule that predates the preference, named after what it does. */}
            <option value={NO_DEFAULT_AGENT}>First found</option>
            {agents.map((agent) => (
              <option key={agent.kind} value={agent.kind}>
                {agent.command}
              </option>
            ))}
          </select>
        </div>

        {agents.map((agent) => (
          <AgentArguments key={agent.kind} agent={agent} />
        ))}
      </div>
    </section>
  )
}

/**
 * One agent's launch arguments, with the command `@shared/agentLaunch` builds from them shown underneath.
 * The runtime's session selector is left out: it is not what this field controls.
 */
function AgentArguments({ agent }: { agent: InstalledAgent }): React.JSX.Element {
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
      <label className="settings-field__label" htmlFor={id}>
        {agent.command}
      </label>
      <input
        id={id}
        className="settings-field__input"
        type="text"
        value={draft}
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
      <code className="settings-launch">{agentLaunchCommand(agent.command, draft)}</code>
    </div>
  )
}

/** One row and a button to the existing colour editor; a second set of swatches would drift. */
function AppearanceSection({ modifier }: { modifier: PlatformModifier }): React.JSX.Element {
  const openDialog = useWorkspaceStore((state) => state.openDialog)

  return (
    <section className="settings-section" aria-labelledby="settings-appearance">
      <h2 className="settings-section__title" id="settings-appearance" tabIndex={-1}>
        Appearance
      </h2>
      <div className="settings-group">
        <div className="settings-row">
          <button
            type="button"
            className="button button--small"
            // No chord (⌘, is the settings page's) and no empty tooltip, which flickers open over nothing.
            title={shortcutHint('open-appearance', modifier) || undefined}
            onClick={() => openDialog({ kind: 'appearance' })}
          >
            Appearance…
          </button>
        </div>
      </div>
    </section>
  )
}

function ProjectsSection({ projects }: { projects: readonly Project[] }): React.JSX.Element {
  return (
    <section className="settings-section" aria-labelledby="settings-projects">
      <h2 className="settings-section__title" id="settings-projects" tabIndex={-1}>
        Projects
      </h2>
      {projects.length === 0 ? (
        <div className="settings-group">
          <p className="settings-note">No repositories yet.</p>
        </div>
      ) : (
        projects.map((project) => <ProjectBlock key={project.id} project={project} />)
      )}
    </section>
  )
}

function ProjectBlock({ project }: { project: Project }): React.JSX.Element {
  const revealInFinder = useWorkspaceStore((state) => state.revealInFinder)

  return (
    <article className="settings-group settings-project">
      <div className="settings-row">
        <div className="settings-project__identity">
          <h3 className="settings-project__name">{project.name}</h3>
          <p className="settings-project__path">{project.path}</p>
        </div>
        <button
          type="button"
          className="button button--small"
          onClick={() => void revealInFinder(project.path, `the ${project.name} repository`)}
        >
          Reveal in Finder
        </button>
      </div>

      <StartPoint project={project} />
      <CarriedPaths project={project} />
      <EditorCommand project={project} />
      <RelayBlock project={project} />
    </article>
  )
}

/** Which ref the New task dialog offers first; a draft written on blur, since half a ref resolves to nothing. */
function StartPoint({ project }: { project: Project }): React.JSX.Element {
  const stored = useWorkspaceStore((state) => state.startPointDefaults[project.id] ?? '')
  const setStartPointDefault = useWorkspaceStore((state) => state.setStartPointDefault)
  const [draft, setDraft] = useState(stored)

  // The stored value moving puts the trimmed spelling back, including when changed from elsewhere.
  useEffect(() => {
    setDraft(stored)
  }, [stored])

  const commit = (): void => {
    const next = draft.trim()
    if (next === stored) return
    // Null, not '': `withStartPoint` removes the entry on null, the only spelling of "use the base ref".
    setStartPointDefault(project.id, next.length === 0 ? null : next)
  }

  const id = `settings-start-point-${project.id}`

  return (
    <div className="settings-field">
      <label className="settings-field__label" htmlFor={id}>
        Start new worktrees from
      </label>
      <div className="settings-field__row">
        <input
          id={id}
          className="settings-field__input"
          type="text"
          value={draft}
          placeholder={project.baseRef}
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
        <button
          type="button"
          className="button button--small"
          disabled={stored.length === 0}
          onClick={() => setStartPointDefault(project.id, null)}
        >
          Use {project.baseRef}
        </button>
      </div>
    </div>
  )
}

/** What a new worktree of this project gets that the branch does not carry, and its setup command. */
function CarriedPaths({ project }: { project: Project }): React.JSX.Element {
  const setProjectPaths = useWorkspaceStore((state) => state.setProjectPaths)

  return (
    <>
      <PathList
        project={project}
        id="linked"
        label="Symlink into every new worktree"
        placeholder={'node_modules\n.venv'}
        paths={project.linkedPaths}
        save={(linkedPaths) => void setProjectPaths(project.id, { linkedPaths })}
      />
      <PathList
        project={project}
        id="copied"
        label="Copy into every new worktree"
        placeholder={'.env\n.env.local'}
        paths={project.copiedPaths}
        save={(copiedPaths) => void setProjectPaths(project.id, { copiedPaths })}
      />
      <SetupCommand project={project} />
    </>
  )
}

/** The one setup command a new worktree runs, stored and typed into the pane verbatim. */
function SetupCommand({ project }: { project: Project }): React.JSX.Element {
  const setProjectPaths = useWorkspaceStore((state) => state.setProjectPaths)
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
        Setup command
      </label>
      <input
        id={id}
        className="settings-field__input"
        type="text"
        value={draft}
        placeholder="npm ci"
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
  placeholder,
  paths,
  save
}: {
  project: Project
  id: string
  label: string
  placeholder: string
  paths: readonly string[] | undefined
  save: (paths: string[]) => void
}): React.JSX.Element {
  const stored = (paths ?? []).join('\n')
  const [draft, setDraft] = useState(stored)

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
        {label}
      </label>
      <textarea
        id={fieldId}
        className="settings-field__input settings-field__input--lines"
        rows={3}
        value={draft}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
      />
    </div>
  )
}

/**
 * Which editor this project's checkouts open in, when teamree's own PATH search misses it.
 * A program name, not a command line: it is spawned without a shell, the checkout as one argument.
 */
function EditorCommand({ project }: { project: Project }): React.JSX.Element {
  const stored = useWorkspaceStore((state) => state.editorCommands[project.id] ?? '')
  const editors = useWorkspaceStore((state) => state.editors)
  const setEditorCommand = useWorkspaceStore((state) => state.setEditorCommand)
  const [draft, setDraft] = useState(stored)

  useEffect(() => {
    setDraft(stored)
  }, [stored])

  const commit = (): void => {
    const next = draft.trim()
    if (next === stored) return
    setEditorCommand(project.id, next.length === 0 ? null : next)
  }

  const id = `settings-editor-${project.id}`
  const found = editors?.map((editor) => editor.command).join(', ') ?? ''

  return (
    <div className="settings-field">
      <label className="settings-field__label" htmlFor={id}>
        Open checkouts in
      </label>
      <div className="settings-field__row">
        <input
          id={id}
          className="settings-field__input"
          type="text"
          value={draft}
          placeholder={editors?.[0]?.command ?? 'code'}
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
        <button
          type="button"
          className="button button--small"
          disabled={stored.length === 0}
          onClick={() => setEditorCommand(project.id, null)}
        >
          Use what is on PATH
        </button>
      </div>
      <p className="settings-note">
        {editors === null
          ? 'Looking…'
          : found.length === 0
            ? 'None of code, cursor, zed, idea or subl on PATH'
            : `On PATH: ${found}`}
      </p>
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
      <h4 className="settings-field__label">Relay</h4>
      <p className="settings-fact">{panel.headline}</p>
      {panel.detail ? <p className="settings-note">{panel.detail}</p> : null}
      {panel.override ? <p className="settings-warning">{panel.override}</p> : null}
      <div className="settings-actions">
        <button type="button" className="button button--small" onClick={() => openTeamwork(project.id)}>
          Open teamwork for {project.name}
        </button>
      </div>
    </div>
  )
}
